import {
  assertAuthorizedChat,
  readTelegramJson,
  TELEGRAM_SEND_TIMEOUT_MS,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

export type ProgressFetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/**
 * `uncertain` means Telegram may or may not have created the bubble. The caller must never
 * turn it into a second send, because that is the one failure mode that produces a duplicate.
 */
export type ProgressSendOutcome =
  | { kind: "sent"; messageId: number }
  | { kind: "uncertain" }
  | { kind: "rejected" };

/**
 * `transient` keeps the bubble identity for a later catch-up edit. `gone` is the only class
 * that may spend the turn's single replacement send.
 */
export type ProgressEditOutcome =
  | { kind: "edited" }
  | { kind: "unchanged" }
  | { kind: "transient" }
  | { kind: "throttled" }
  | { kind: "gone" }
  | { kind: "rejected" };

interface TelegramEnvelope {
  ok?: unknown;
  result?: unknown;
  description?: unknown;
}

const GONE_DESCRIPTIONS = [
  "message to edit not found",
  "message can't be edited",
  "message_id_invalid",
  "message identifier is not specified",
  "message to be edited was not found"
];

function describe(envelope: TelegramEnvelope): string {
  return typeof envelope.description === "string" ? envelope.description.toLowerCase() : "";
}

function positiveMessageId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

async function call(
  method: string,
  body: Record<string, unknown>,
  config: RuntimeConfig,
  fetchImpl: ProgressFetchLike
): Promise<{ status: number; envelope: TelegramEnvelope } | null> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  try {
    return { status: response.status, envelope: await readTelegramJson(response) as TelegramEnvelope };
  } catch {
    return null;
  }
}

export async function sendProgressBubble(
  config: RuntimeConfig,
  chatId: string,
  replyToMessageId: string,
  text: string,
  fetchImpl: ProgressFetchLike = fetch
): Promise<ProgressSendOutcome> {
  assertAuthorizedChat(config, chatId);
  const quoted = Number(replyToMessageId);
  if (!/^\d+$/.test(replyToMessageId) || !Number.isSafeInteger(quoted) || quoted < 1) {
    throw new Error("invalid progress quote target");
  }

  const attempt = await call("sendMessage", {
    chat_id: chatId,
    text,
    disable_notification: true,
    reply_parameters: { message_id: quoted }
  }, config, fetchImpl);
  if (attempt === null) return { kind: "uncertain" };

  const messageId = positiveMessageId((attempt.envelope.result as { message_id?: unknown } | undefined)?.message_id);
  if (attempt.envelope.ok === true && messageId !== null) return { kind: "sent", messageId };
  if (attempt.status === 400) return { kind: "rejected" };
  return { kind: "uncertain" };
}

export async function editProgressBubble(
  config: RuntimeConfig,
  chatId: string,
  messageId: number,
  text: string,
  fetchImpl: ProgressFetchLike = fetch
): Promise<ProgressEditOutcome> {
  assertAuthorizedChat(config, chatId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error("invalid progress bubble ID");

  const attempt = await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text
  }, config, fetchImpl);
  if (attempt === null) return { kind: "transient" };

  const { status, envelope } = attempt;
  if (envelope.ok === true) {
    if (envelope.result === true) return { kind: "edited" };
    if (positiveMessageId((envelope.result as { message_id?: unknown } | undefined)?.message_id) !== null) {
      return { kind: "edited" };
    }
    return { kind: "transient" };
  }

  const description = describe(envelope);
  if (status === 400 && description.includes("message is not modified")) return { kind: "unchanged" };
  if (status === 429) return { kind: "throttled" };
  if (status === 404) return { kind: "gone" };
  if (status === 400 && GONE_DESCRIPTIONS.some(known => description.includes(known))) return { kind: "gone" };
  if (status === 400) return { kind: "rejected" };
  return { kind: "transient" };
}
