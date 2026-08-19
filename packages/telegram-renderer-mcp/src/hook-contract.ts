import { z } from "zod";

export {
  parseDirectTelegramEnvelope,
  type DirectTelegramEnvelope
} from "@project-tharsis/claude-code-telegram-shared";

/**
 * Hook payloads are built by Claude Code from `${...}` templates, so a missing field
 * arrives as an empty string rather than as an absent key. Every identifier below is
 * therefore non-empty, bounded, and character-restricted, and every schema is strict so
 * an unexpected field (notably `tool_input`) is a hard rejection rather than a passthrough.
 */

const uuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "invalid session UUID"
);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid identifier");
const toolName = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid tool name");
/** Never persisted, never logged; parsed for the direct-envelope target and then dropped. */
const prompt = z.string().max(1_000_000);

/** An empty string is Claude Code's rendering of an absent optional template field. */
const optionalIdentifier = z.union([z.literal(""), identifier])
  .optional()
  .transform(value => (value === undefined || value === "" ? undefined : value));

const turnKey = {
  session_id: uuid,
  prompt_id: identifier
};

export const BindTurnInputSchema = z.object({
  ...turnKey,
  prompt,
  hook_event_name: z.literal("UserPromptSubmit")
}).strict();

export const RecordToolInputSchema = z.object({
  ...turnKey,
  tool_use_id: identifier,
  tool_name: toolName,
  agent_id: optionalIdentifier,
  hook_event_name: z.literal("PreToolUse")
}).strict();

export const RecordToolFailureInputSchema = z.object({
  ...turnKey,
  tool_use_id: identifier,
  hook_event_name: z.literal("PostToolUseFailure")
}).strict();

export const FinishTurnInputSchema = z.object({
  ...turnKey,
  hook_event_name: z.union([z.literal("Stop"), z.literal("StopFailure")])
}).strict();

export type BindTurnInput = z.infer<typeof BindTurnInputSchema>;
export type RecordToolInput = z.infer<typeof RecordToolInputSchema>;
export type RecordToolFailureInput = z.infer<typeof RecordToolFailureInputSchema>;
export type FinishTurnInput = z.infer<typeof FinishTurnInputSchema>;
