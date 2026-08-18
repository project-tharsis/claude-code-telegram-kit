import { z } from "zod";

const boundedContent = z.string()
  .refine(value => value.trim().length > 0, "content must not be empty")
  .refine(value => Array.from(value).length <= 100_000, "content exceeds 100000 characters");

export const UnifiedReplyInputSchema = z.object({
  chat_id: z.string().regex(/^-?\d+$/),
  content: boundedContent,
  reply_to: z.string().regex(/^\d+$/).optional(),
  disable_notification: z.boolean().default(false)
}).strict();

export type UnifiedReplyInput = z.infer<typeof UnifiedReplyInputSchema>;
