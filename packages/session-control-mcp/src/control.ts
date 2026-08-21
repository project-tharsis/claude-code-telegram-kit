import { z } from "zod";
import { assertAuthorizedChat, type RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

export const CONFIRMATION = "RESET SESSION";
export const RESET_ACCEPTED_TEXT = "<b>Fresh session requested</b>\n<i>Starting now…</i>";
export const RESET_SCHEDULER_FAILED_TEXT = "<b>Reset failed</b>\n<i>No fresh session was started.</i>";

const telegramMessageId = z.string()
  .regex(/^\d+$/)
  .refine(value => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1;
  }, "invalid Telegram message ID");

export const ResetRequestSchema = z.object({
  chat_id: z.string().regex(/^\d+$/),
  message_id: telegramMessageId,
  current_session_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  confirmation: z.literal(CONFIRMATION)
}).strict();

export type ResetRequest = z.infer<typeof ResetRequestSchema>;

export interface ResetReceipt {
  status: "scheduled";
  ackMessageId: number;
  unit: string;
}

export interface ResetControllerDeps {
  loadConfig: () => RuntimeConfig;
  helperReady: () => Promise<boolean>;
  sendMessage: (
    config: RuntimeConfig,
    chatId: string,
    text: string,
    replyTo?: string,
    parseMode?: "HTML"
  ) => Promise<number>;
  react: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    state: "success" | "failure"
  ) => Promise<boolean>;
  schedule: (chatId: string, messageId: string, currentSessionId: string) => Promise<string>;
}

export function createResetController(deps: ResetControllerDeps) {
  return async (rawRequest: ResetRequest): Promise<ResetReceipt> => {
    const request = ResetRequestSchema.parse(rawRequest);
    const config = deps.loadConfig();
    assertAuthorizedChat(config, request.chat_id);
    if (!await deps.helperReady()) throw new Error("session reset is unavailable on this host");

    let ackMessageId: number;
    try {
      ackMessageId = await deps.sendMessage(
        config, request.chat_id, RESET_ACCEPTED_TEXT, request.message_id, "HTML"
      );
    } catch {
      throw new Error("ACK delivery failed; reset was not scheduled");
    }

    try {
      await deps.react(config, request.chat_id, request.message_id, "success");
    } catch {
      // Reaction UX is best-effort and never blocks a confirmed reset ACK.
    }

    let unit: string;
    try {
      unit = await deps.schedule(request.chat_id, request.message_id, request.current_session_id);
    } catch {
      try {
        await deps.sendMessage(config, request.chat_id, RESET_SCHEDULER_FAILED_TEXT, undefined, "HTML");
      } catch {
        // The primary failure is scheduler rejection; notification is best-effort.
      }
      try {
        // The ACK already marked the command with 👀/👍; a rejection that never started the
        // reset must not leave the triggering message looking successful.
        await deps.react(config, request.chat_id, request.message_id, "failure");
      } catch {
        // Reaction UX is best-effort and never changes the reported failure.
      }
      throw new Error("reset scheduler failed");
    }

    return { status: "scheduled", ackMessageId, unit };
  };
}
