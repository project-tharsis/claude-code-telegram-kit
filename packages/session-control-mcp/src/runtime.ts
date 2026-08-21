import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  assertAuthorizedChat,
  readTelegramJson,
  TELEGRAM_SEND_TIMEOUT_MS,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import { MODEL_ALIASES, type ModelAlias } from "./control-command.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface CommandRunnerOptions { timeoutMs?: number }
export type CommandRunner = (
  argv: string[],
  options?: CommandRunnerOptions
) => Promise<{ exitCode: number; stderr: string; stdout?: string }>;
export type TelegramReplyMarkup = Record<string, unknown>;

const DEFAULT_HELPER = "/usr/local/sbin/claude-code-session-reset";
const DEFAULT_CONFIG = "/etc/claude-code-telegram-kit/reset.json";
const DEFAULT_UNIT_PREFIX = "claude-session-reset";
/** Wire protocol between this MCP and the root helper. Both sides must agree exactly. */
export const HELPER_PROTOCOL_VERSION = 4;
export const REQUIRED_HELPER_ACTIONS = ["reset", "resume", "model"] as const;
const MAX_CAPABILITIES_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    response = await fetchImpl(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS)
      }
    );
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
  if (
    !response.ok
    || envelope.ok !== true
    || typeof messageId !== "number"
    || !Number.isSafeInteger(messageId)
    || messageId < 1
  ) {
    throw new Error("Telegram control notification failed");
  }
  return messageId;
}

export async function runCommand(
  argv: string[],
  options: CommandRunnerOptions = {}
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 60_000));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();
  try {
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
      child.stdout ? new Response(child.stdout).text() : Promise.resolve("")
    ]);
    if (timedOut) throw new Error("command timed out");
    return {
      exitCode,
      stderr: stderr.slice(0, 4_096),
      stdout: stdout.slice(0, MAX_CAPABILITIES_BYTES + 1)
    };
  } finally {
    clearTimeout(timer);
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (!value.startsWith("/") || value.includes("\0")) throw new Error(`${label} must be an absolute path`);
}

interface RootOwnedFileMetadata {
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  uid: number;
  mode: number;
  nlink: number;
}

export function isSecureRootOwnedFileMetadata(
  info: RootOwnedFileMetadata,
  allowedModes: readonly number[]
): boolean {
  return (
    info.isFile()
    && !info.isSymbolicLink()
    && info.uid === 0
    && info.nlink === 1
    && allowedModes.includes(info.mode & 0o777)
  );
}

function verifyRootOwnedFile(path: string, modes: readonly number[], label: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (!isSecureRootOwnedFileMetadata(info, modes)) {
    throw new Error(`${label} ownership or mode is invalid`);
  }
}

export interface SchedulerOptions {
  run?: CommandRunner;
  verifyHelper?: () => void;
  helperPath?: string;
  configPath?: string;
  unitPrefix?: string;
}

interface ResolvedScheduler {
  run: CommandRunner;
  helperPath: string;
  configPath: string;
  unitPrefix: string;
  verifyHelper: () => void;
}

function resolveScheduler(options: SchedulerOptions): ResolvedScheduler {
  const run = options.run ?? runCommand;
  const helperPath = options.helperPath ?? process.env.CLAUDE_SESSION_RESET_HELPER ?? DEFAULT_HELPER;
  const configPath = options.configPath ?? process.env.CLAUDE_SESSION_RESET_CONFIG ?? DEFAULT_CONFIG;
  const unitPrefix = options.unitPrefix ?? process.env.CLAUDE_SESSION_RESET_UNIT_PREFIX ?? DEFAULT_UNIT_PREFIX;
  assertAbsolutePath(helperPath, "reset helper");
  assertAbsolutePath(configPath, "reset config");
  if (!/^[A-Za-z0-9_.@-]+$/.test(unitPrefix)) throw new Error("invalid reset unit prefix");

  const verifyHelper = options.verifyHelper ?? (() => {
    verifyRootOwnedFile(helperPath, [0o755], "reset helper");
    verifyRootOwnedFile(configPath, [0o600, 0o644], "reset config");
  });

  return { run, helperPath, configPath, unitPrefix, verifyHelper };
}

/**
 * The only shape of privileged command this MCP ever builds: a fixed argv, no shell, no
 * caller-supplied executable, path, unit, or service. The action and its session UUID are the
 * only variable parts, and the UUID is resolved from a user-private snapshot, never the model.
 */
export function createSessionScheduler(options: SchedulerOptions = {}) {
  const resolved = resolveScheduler(options);

  async function submit(
    action: "reset" | "resume" | "model",
    chatId: string,
    messageId: string,
    currentSessionId?: string,
    sessionId?: string,
    model?: ModelAlias
  ): Promise<string> {
    if (!/^\d+$/.test(chatId)) throw new Error("invalid chat ID");
    if (!/^\d+$/.test(messageId)) throw new Error("invalid message ID");
    if (action === "resume" && (sessionId === undefined || !SESSION_UUID.test(sessionId))) {
      throw new Error("invalid session UUID");
    }
    if (action === "resume" && (currentSessionId === undefined || !SESSION_UUID.test(currentSessionId))) {
      throw new Error("invalid current session UUID");
    }
    if (action === "model" && !MODEL_ALIASES.includes((model ?? "") as ModelAlias)) {
      throw new Error("invalid model alias");
    }
    resolved.verifyHelper();

    // Reset and resume for the same inbound message stay separately idempotent at the root.
    const seed = action === "reset"
      ? `${chatId}:${messageId}`
      : action === "resume"
        ? `${action}:${chatId}:${messageId}:${currentSessionId!}`
        : `${action}:${chatId}:${messageId}:${model!}`;
    const id = createHash("sha256").update(seed).digest("hex").slice(0, 24);
    const unit = action === "reset"
      ? `${resolved.unitPrefix}-${id}`
      : `${resolved.unitPrefix}-${action}-${id}`;
    const argv = [
      "/usr/bin/sudo",
      "-n",
      "/usr/bin/systemd-run",
      `--unit=${unit}`,
      "--collect",
      "--no-block",
      resolved.helperPath,
      "--config",
      resolved.configPath,
      "--protocol",
      String(HELPER_PROTOCOL_VERSION),
      "--action",
      action,
      ...(action === "resume" ? ["--current-session-id", currentSessionId!] : []),
      ...(action === "resume" ? ["--session-id", sessionId!] : []),
      ...(action === "model" ? ["--model", model!] : []),
      "--chat-id",
      chatId,
      "--request-id",
      id
    ];
    const result = await resolved.run(argv);
    if (result.exitCode !== 0) throw new Error(`systemd rejected the ${action} job`);
    return unit;
  }

  return {
    scheduleReset: (chatId: string, messageId: string) => submit("reset", chatId, messageId),
    scheduleResume: (chatId: string, messageId: string, currentSessionId: string, sessionId: string) =>
      submit("resume", chatId, messageId, currentSessionId, sessionId),
    scheduleModel: (chatId: string, messageId: string, model: ModelAlias) =>
      submit("model", chatId, messageId, undefined, undefined, model)
  };
}

export function createResetScheduler(options: SchedulerOptions = {}) {
  const { scheduleReset } = createSessionScheduler(options);
  return scheduleReset;
}

export interface HelperCapabilities {
  protocol: number;
  actions: string[];
  models: string[];
}

/**
 * Read-only preflight against the installed root helper. It runs unprivileged and mutates
 * nothing, so a version skew between this checkout and `/usr/local/sbin` is discovered before
 * a user is told an action was accepted rather than after a failed privileged job.
 */
export async function probeHelperCapabilities(options: SchedulerOptions = {}): Promise<HelperCapabilities> {
  const resolved = resolveScheduler(options);
  resolved.verifyHelper();

  const result = await resolved.run([resolved.helperPath, "--capabilities"]);
  if (result.exitCode !== 0) throw new Error("reset helper capability probe failed");
  const stdout = result.stdout ?? "";
  if (stdout.length === 0 || stdout.length > MAX_CAPABILITIES_BYTES) {
    throw new Error("reset helper capability output is unusable");
  }

  const parsed = JSON.parse(stdout) as { protocol?: unknown; actions?: unknown; models?: unknown };
  if (parsed.protocol !== HELPER_PROTOCOL_VERSION) {
    throw new Error("reset helper protocol mismatch");
  }
  const actions: unknown[] = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (
    !actions.every((action): action is string => typeof action === "string")
    || !REQUIRED_HELPER_ACTIONS.every(action => actions.includes(action))
  ) {
    throw new Error("reset helper does not support the required actions");
  }
  const models: unknown[] = Array.isArray(parsed.models) ? parsed.models : [];
  if (
    !models.every((model): model is string => typeof model === "string")
    || !MODEL_ALIASES.every(model => models.includes(model))
  ) {
    throw new Error("reset helper does not support the required models");
  }
  return { protocol: HELPER_PROTOCOL_VERSION, actions, models };
}
