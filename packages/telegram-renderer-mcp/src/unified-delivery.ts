import { toMarkdownV2 } from "./markdown.js";
import { needsRichRendering, normalizeRichMarkdown } from "./router.js";
import { assertAuthorizedChat, type RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import type { UnifiedReplyInput } from "./unified-contract.js";

export type UnifiedFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface UnifiedDeliveryReceipt {
  mode: "rich" | "markdownv2" | "text";
  messageIds: number[];
}

interface TelegramEnvelope {
  ok?: unknown;
  result?: { message_id?: unknown };
}

type TelegramAttempt =
  | { kind: "success"; messageId: number }
  | { kind: "permanent"; disableCapability: boolean }
  | { kind: "uncertain" };

async function attemptTelegram(
  method: string,
  body: Record<string, unknown>,
  config: RuntimeConfig,
  fetchImpl: UnifiedFetchLike
): Promise<TelegramAttempt> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    return { kind: "uncertain" };
  }

  let envelope: TelegramEnvelope;
  try {
    envelope = await response.json() as TelegramEnvelope;
  } catch {
    return { kind: "uncertain" };
  }
  const messageId = envelope.result?.message_id;
  if (response.ok && envelope.ok === true && typeof messageId === "number" && Number.isInteger(messageId)) {
    return { kind: "success", messageId };
  }
  if (response.status === 400 || response.status === 404) {
    return { kind: "permanent", disableCapability: response.status === 404 };
  }
  return { kind: "uncertain" };
}

export function createUnifiedDeliverer(fetchImpl: UnifiedFetchLike = fetch) {
  let richDisabled = false;

  return async (input: UnifiedReplyInput, config: RuntimeConfig): Promise<UnifiedDeliveryReceipt> => {
    assertAuthorizedChat(config, input.chat_id);
    const common: Record<string, unknown> = { chat_id: input.chat_id };
    if (input.reply_to !== undefined) common.reply_parameters = { message_id: Number(input.reply_to) };
    if (input.disable_notification) common.disable_notification = true;

    if (!richDisabled && needsRichRendering(input.content)) {
      const richAttempt = await attemptTelegram(
        "sendRichMessage",
        {
          ...common,
          rich_message: { markdown: normalizeRichMarkdown(input.content) }
        },
        config,
        fetchImpl
      );
      if (richAttempt.kind === "success") {
        return { mode: "rich", messageIds: [richAttempt.messageId] };
      }
      if (richAttempt.kind === "uncertain") {
        throw new Error("Telegram rich delivery outcome unknown; no fallback sent");
      }
      if (richAttempt.disableCapability) richDisabled = true;
    }

    const rendered = toMarkdownV2(input.content);
    if (rendered.length > 4_096) {
      throw new Error("content does not fit in a single Telegram message");
    }
    const markdownAttempt = await attemptTelegram(
      "sendMessage",
      { ...common, parse_mode: "MarkdownV2", text: rendered },
      config,
      fetchImpl
    );
    if (markdownAttempt.kind === "success") {
      return { mode: "markdownv2", messageIds: [markdownAttempt.messageId] };
    }
    if (markdownAttempt.kind === "uncertain") {
      throw new Error("Telegram MarkdownV2 delivery outcome unknown; no fallback sent");
    }

    if (input.content.length > 4_096) {
      throw new Error("content does not fit in a single Telegram message");
    }
    const textAttempt = await attemptTelegram(
      "sendMessage",
      { ...common, text: input.content },
      config,
      fetchImpl
    );
    if (textAttempt.kind === "success") {
      return { mode: "text", messageIds: [textAttempt.messageId] };
    }
    if (textAttempt.kind === "uncertain") {
      throw new Error("Telegram text delivery outcome unknown; no retry sent");
    }
    throw new Error("Telegram delivery rejected");
  };
}
