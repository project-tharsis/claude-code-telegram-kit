import { createConnection } from "node:net";
import {
  assertAuthorizedChat,
  readTelegramJson,
  TELEGRAM_SEND_TIMEOUT_MS,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import { MODEL_ALIASES, type ModelAlias } from "./control-command.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type TelegramReplyMarkup = Record<string, unknown>;

const DEFAULT_BROKER_SOCKET = "/run/claude-code-telegram-kit/control.sock";
const MAX_BROKER_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_BROKER_TIMEOUT_MS = 5_000;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNIT = /^claude-session-(?:reset(?:-(?:resume|model))?|title)-[0-9a-f]{24}$/;
export const BROKER_PROTOCOL_VERSION = 2;
export const HELPER_PROTOCOL_VERSION = 6;
export const REQUIRED_HELPER_ACTIONS = ["reset", "resume", "model", "title"] as const;

interface TelegramEnvelope {
  ok?: unknown;
  result?: { message_id?: unknown };
}

export async function sendTelegramMessage(
  config: RuntimeConfig,
  chatId: string,
  text: string,
  fetchImpl: FetchLike = fetch,
  replyTo?: string,
  parseMode?: "HTML",
  replyMarkup?: TelegramReplyMarkup
): Promise<number> {
  assertAuthorizedChat(config, chatId);
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode !== undefined) body.parse_mode = parseMode;
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  if (replyTo !== undefined) {
    const replyMessageId = Number(replyTo);
    if (!/^\d+$/.test(replyTo) || !Number.isSafeInteger(replyMessageId) || replyMessageId < 1) {
      throw new Error("invalid reply message ID");
    }
    body.reply_parameters = { message_id: replyMessageId };
  }
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS)
    });
  } catch {
    throw new Error("Telegram control notification failed");
  }
  let envelope: TelegramEnvelope;
  try {
    envelope = await readTelegramJson(response) as TelegramEnvelope;
  } catch {
    throw new Error("Telegram control notification failed");
  }
  const messageId = envelope.result?.message_id;
  if (!response.ok || envelope.ok !== true || typeof messageId !== "number"
      || !Number.isSafeInteger(messageId) || messageId < 1) {
    throw new Error("Telegram control notification failed");
  }
  return messageId;
}

export type BrokerRequest =
  | { protocol: 2; action: "capabilities" }
  | { protocol: 2; action: "reset"; chat_id: string; message_id: string; current_session_id: string }
  | { protocol: 2; action: "resume"; chat_id: string; message_id: string; current_session_id: string; session_id: string }
  | { protocol: 2; action: "model"; chat_id: string; message_id: string; model: ModelAlias }
  | { protocol: 2; action: "title"; session_id: string };

export type BrokerCall = (request: BrokerRequest) => Promise<unknown>;

export function callControlBroker(
  request: BrokerRequest,
  options: { socketPath?: string; timeoutMs?: number } = {}
): Promise<unknown> {
  const socketPath = options.socketPath ?? process.env.CLAUDE_SESSION_CONTROL_SOCKET ?? DEFAULT_BROKER_SOCKET;
  if (!socketPath.startsWith("/") || socketPath.includes("\0")) {
    return Promise.reject(new Error("invalid control socket path"));
  }
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS, 60_000));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("control broker timed out")), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      total += chunk.byteLength;
      if (total > MAX_BROKER_RESPONSE_BYTES) return finish(new Error("control broker response too large"));
      chunks.push(chunk);
    });
    socket.once("error", () => finish(new Error("control broker unavailable")));
    socket.once("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
          return finish(new Error("control broker response is malformed"));
        }
        finish(undefined, JSON.parse(text));
      } catch {
        finish(new Error("control broker response is malformed"));
      }
    });
  });
}

export interface SchedulerOptions {
  callBroker?: BrokerCall;
  socketPath?: string;
  timeoutMs?: number;
}

function brokerCall(options: SchedulerOptions): BrokerCall {
  return options.callBroker ?? (request => callControlBroker(request, {
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  }));
}

function validId(value: string, label: string): void {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${label}`);
  }
}

export function createSessionScheduler(options: SchedulerOptions = {}) {
  const call = brokerCall(options);
  async function submit(request: Exclude<BrokerRequest, { action: "capabilities" }>): Promise<string> {
    if (request.action !== "title") {
      validId(request.chat_id, "chat ID");
      validId(request.message_id, "message ID");
    }
    if (request.action === "reset" || request.action === "resume") {
      if (!SESSION_UUID.test(request.current_session_id)) throw new Error("invalid current session UUID");
    }
    if (request.action === "resume") {
      if (!SESSION_UUID.test(request.session_id)) throw new Error("invalid session UUID");
    }
    if (request.action === "model" && !MODEL_ALIASES.includes(request.model)) {
      throw new Error("invalid model alias");
    }
    if (request.action === "title" && !SESSION_UUID.test(request.session_id)) {
      throw new Error("invalid session UUID");
    }
    const result = await call(request) as { status?: unknown; unit?: unknown };
    if (result?.status !== "scheduled" || typeof result.unit !== "string" || !UNIT.test(result.unit)) {
      throw new Error(`control broker rejected the ${request.action} job`);
    }
    return result.unit;
  }
  return {
    scheduleReset: (chatId: string, messageId: string, currentSessionId: string) => submit({ protocol: 2, action: "reset", chat_id: chatId, message_id: messageId, current_session_id: currentSessionId }),
    scheduleResume: (chatId: string, messageId: string, currentSessionId: string, sessionId: string) => submit({ protocol: 2, action: "resume", chat_id: chatId, message_id: messageId, current_session_id: currentSessionId, session_id: sessionId }),
    scheduleModel: (chatId: string, messageId: string, model: ModelAlias) => submit({ protocol: 2, action: "model", chat_id: chatId, message_id: messageId, model }),
    scheduleTitle: (sessionId: string) => submit({ protocol: 2, action: "title", session_id: sessionId })
  };
}

export function createResetScheduler(options: SchedulerOptions = {}) {
  return createSessionScheduler(options).scheduleReset;
}

export interface HelperCapabilities {
  protocol: number;
  actions: string[];
  models: string[];
}

export async function probeHelperCapabilities(options: SchedulerOptions = {}): Promise<HelperCapabilities> {
  const result = await brokerCall(options)({ protocol: BROKER_PROTOCOL_VERSION, action: "capabilities" }) as {
    status?: unknown;
    capabilities?: { protocol?: unknown; actions?: unknown; models?: unknown };
  };
  if (result?.status !== "ok" || typeof result.capabilities !== "object" || result.capabilities === null) {
    throw new Error("control broker capability probe failed");
  }
  const parsed = result.capabilities;
  if (parsed.protocol !== HELPER_PROTOCOL_VERSION) throw new Error("reset helper protocol mismatch");
  const actions: unknown[] = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (!actions.every((action): action is string => typeof action === "string")
      || !REQUIRED_HELPER_ACTIONS.every(action => actions.includes(action))) {
    throw new Error("reset helper does not support the required actions");
  }
  const models: unknown[] = Array.isArray(parsed.models) ? parsed.models : [];
  if (!models.every((model): model is string => typeof model === "string")
      || !MODEL_ALIASES.every(model => models.includes(model))) {
    throw new Error("reset helper does not support the required models");
  }
  return { protocol: HELPER_PROTOCOL_VERSION, actions, models };
}
