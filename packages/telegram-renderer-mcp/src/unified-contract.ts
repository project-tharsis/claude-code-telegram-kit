import { z } from "zod";

const boundedContent = z.string()
  .refine(value => value.trim().length > 0, "content must not be empty")
  .refine(value => Array.from(value).length <= 100_000, "content exceeds 100000 characters");

const telegramMessageId = z.string()
  .regex(/^\d+$/)
  .refine(value => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1;
  }, "invalid Telegram message ID");

export const UnifiedReplyInputSchema = z.object({
  chat_id: z.string().regex(/^-?\d+$/),
  message_id: telegramMessageId,
  content: boundedContent,
  reply_to: telegramMessageId.optional(),
  disable_notification: z.boolean().default(false)
}).strict();

export type UnifiedReplyInput = z.infer<typeof UnifiedReplyInputSchema>;

/** Loose target extraction so a rejected input can still finalize its 👀 acknowledgement. */
export const ReactionTargetSchema = z.object({
  chat_id: z.string().regex(/^-?\d+$/),
  message_id: telegramMessageId
});
