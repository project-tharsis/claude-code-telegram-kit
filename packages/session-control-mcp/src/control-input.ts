import { z } from "zod";

export const MAX_SESSION_INDEX = 10;

const uuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "invalid session UUID"
);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid identifier");

/** Strict input accepted only by the deterministic UserPromptSubmit dispatcher. */
export const ControlHookInputSchema = z.object({
  session_id: uuid,
  prompt_id: identifier,
  prompt: z.string().max(1_000_000),
  hook_event_name: z.literal("UserPromptSubmit")
}).strict();

export type ControlHookInput = z.infer<typeof ControlHookInputSchema>;
