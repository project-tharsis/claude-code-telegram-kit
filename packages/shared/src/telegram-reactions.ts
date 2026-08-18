import {
  assertAuthorizedChat,
  type RuntimeConfig
} from "./telegram-authority.js";
import { readTelegramJson } from "./telegram-response.js";

export type TelegramReactionFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;
export type TelegramFinalReaction = "success" | "failure";

function parseSafeMessageId(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("invalid message ID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid message ID");
  return parsed;
}

export async function finalizeTelegramReaction(
  config: RuntimeConfig,
  chatId: string,
  messageId: string,
  state: TelegramFinalReaction,
  options: { fetchImpl?: TelegramReactionFetch } = {}
): Promise<boolean> {
  assertAuthorizedChat(config, chatId);
  const parsedMessageId = parseSafeMessageId(messageId);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${config.token}/setMessageReaction`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: parsedMessageId,
          reaction: [{ type: "emoji", emoji: state === "success" ? "👍" : "👎" }]
        }),
        signal: AbortSignal.timeout(3_000)
      }
    );
    const body = await readTelegramJson(response) as { ok?: unknown; result?: unknown };
    return response.ok && body.ok === true && body.result === true;
  } catch {
    return false;
  }
}
