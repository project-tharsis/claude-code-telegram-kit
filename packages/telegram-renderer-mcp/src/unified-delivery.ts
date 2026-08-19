import { toMarkdownV2 } from "./markdown.js";
import { finalizeReaction } from "./reactions.js";
import { needsRichRendering, normalizeRichMarkdown } from "./router.js";
import {
  assertAuthorizedChat,
  readTelegramJson,
  TELEGRAM_SEND_TIMEOUT_MS,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import type { UnifiedReplyInput } from "./unified-contract.js";

export type UnifiedFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ClockLike = () => number;

/**
 * A 404 is the only Rich capability signal Telegram gives us, and it is not exclusive:
 * a revoked token and a meddling intermediary produce the same status. So the latch
 * expires instead of lasting the whole process lifetime.
 */
export const RICH_CAPABILITY_COOLDOWN_MS = 30 * 60 * 1_000;

/** Thrown when Telegram's outcome is unknown. The 👀 acknowledgement must survive it. */
export class TelegramUncertainOutcomeError extends Error {}

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
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS)
    });
  } catch {
    return { kind: "uncertain" };
  }

  let envelope: TelegramEnvelope;
  try {
    envelope = await readTelegramJson(response) as TelegramEnvelope;
  } catch {
    return { kind: "uncertain" };
  }
  const messageId = envelope.result?.message_id;
  if (
    response.ok
    && envelope.ok === true
    && typeof messageId === "number"
    && Number.isSafeInteger(messageId)
    && messageId >= 1
  ) {
    return { kind: "success", messageId };
  }
  if (response.status === 400 || response.status === 404) {
    return { kind: "permanent", disableCapability: response.status === 404 };
  }
  return { kind: "uncertain" };
}

async function finalizeSuccessReaction(
  config: RuntimeConfig,
  input: UnifiedReplyInput,
  fetchImpl: UnifiedFetchLike
): Promise<void> {
  try {
    await finalizeReaction(config, input.chat_id, input.message_id, "success", { fetchImpl });
  } catch {
    // Reactions are UX only. They never alter a confirmed reply outcome.
  }
}

export function createUnifiedDeliverer(
  fetchImpl: UnifiedFetchLike = fetch,
  now: ClockLike = Date.now
) {
  let richDisabledUntil = 0;

  return async (input: UnifiedReplyInput, config: RuntimeConfig): Promise<UnifiedDeliveryReceipt> => {
    assertAuthorizedChat(config, input.chat_id);
    const common: Record<string, unknown> = {
      chat_id: input.chat_id,
      reply_parameters: { message_id: Number(input.reply_to ?? input.message_id) }
    };
    if (input.disable_notification) common.disable_notification = true;

    if (now() >= richDisabledUntil && needsRichRendering(input.content)) {
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
        await finalizeSuccessReaction(config, input, fetchImpl);
        return { mode: "rich", messageIds: [richAttempt.messageId] };
      }
      if (richAttempt.kind === "uncertain") {
        throw new TelegramUncertainOutcomeError("Telegram rich delivery outcome unknown; no fallback sent");
      }
      if (richAttempt.disableCapability) richDisabledUntil = now() + RICH_CAPABILITY_COOLDOWN_MS;
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
      await finalizeSuccessReaction(config, input, fetchImpl);
      return { mode: "markdownv2", messageIds: [markdownAttempt.messageId] };
    }
    if (markdownAttempt.kind === "uncertain") {
      throw new TelegramUncertainOutcomeError("Telegram MarkdownV2 delivery outcome unknown; no fallback sent");
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
      await finalizeSuccessReaction(config, input, fetchImpl);
      return { mode: "text", messageIds: [textAttempt.messageId] };
    }
    if (textAttempt.kind === "uncertain") {
      throw new TelegramUncertainOutcomeError("Telegram text delivery outcome unknown; no retry sent");
    }
    throw new Error("Telegram delivery rejected");
  };
}
