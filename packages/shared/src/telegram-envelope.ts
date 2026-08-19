/**
 * The official Telegram Channel prefixes every inbound message with a `<channel ...>` envelope.
 * Sidecars parse it to learn the exact destination of the message currently being handled.
 */

const MAX_ENVELOPE_TAG_CHARS = 1_024;
const CHANNEL_TAG_OPEN = "<channel";

export interface DirectTelegramEnvelope {
  chatId: string;
  messageId: string;
  body: string;
}

function isPositiveSafeTelegramId(value: string): boolean {
  if (!/^\d{1,15}$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1;
}

/**
 * Accepts only a direct inbound Telegram message: the official Channel envelope must open
 * the prompt, and the prompt must contain exactly one channel tag. Quoted, forwarded, or
 * tool-sourced text that merely mentions an envelope never binds a turn.
 */
export function parseDirectTelegramEnvelope(prompt: string): DirectTelegramEnvelope | null {
  if (typeof prompt !== "string" || prompt.length === 0) return null;

  const leading = prompt.length - prompt.trimStart().length;
  const trimmed = prompt.slice(leading);
  if (!trimmed.startsWith(CHANNEL_TAG_OPEN)) return null;

  let occurrences = 0;
  for (let index = trimmed.indexOf(CHANNEL_TAG_OPEN); index !== -1; index = trimmed.indexOf(CHANNEL_TAG_OPEN, index + 1)) {
    occurrences += 1;
    if (occurrences > 1) return null;
  }

  const close = trimmed.indexOf(">");
  if (close === -1 || close > MAX_ENVELOPE_TAG_CHARS) return null;
  const tag = trimmed.slice(CHANNEL_TAG_OPEN.length, close);
  if (tag.length === 0 || !/^[\s]/.test(tag)) return null;

  const attributes = new Map<string, string>();
  const pattern = /([a-z_][a-z0-9_]{0,31})="([^"<>]{0,256})"/gi;
  let match = pattern.exec(tag);
  while (match !== null) {
    attributes.set(match[1]!.toLowerCase(), match[2]!);
    match = pattern.exec(tag);
  }

  // The official Channel emits `plugin:telegram:telegram`; earlier versions emitted `telegram`.
  // Accept both exact values only — prefixes or suffixes must not pass.
  const source = attributes.get("source");
  if (source !== "telegram" && source !== "plugin:telegram:telegram") return null;
  const chatId = attributes.get("chat_id");
  const messageId = attributes.get("message_id");
  if (chatId === undefined || messageId === undefined) return null;
  if (!/^-?\d{1,20}$/.test(chatId)) return null;
  if (!isPositiveSafeTelegramId(messageId)) return null;

  let body = trimmed.slice(close + 1);
  const closingTag = body.lastIndexOf("</channel>");
  if (closingTag !== -1) body = body.slice(0, closingTag);
  return { chatId, messageId, body: body.trim() };
}
