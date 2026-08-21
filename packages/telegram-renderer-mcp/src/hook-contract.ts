import { z } from "zod";

export {
  parseDirectTelegramEnvelope,
  type DirectTelegramEnvelope
} from "@project-tharsis/claude-code-telegram-shared";

/**
 * Hook payloads are built by Claude Code from `${...}` templates, so a missing field
 * arrives as an empty string rather than as an absent key. Identifiers are non-empty,
 * bounded, and character-restricted. Selected preview fields are bounded strings; the raw
 * `tool_input` object and every tool output remain rejected by strict schemas.
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

function optionalText(maxLength: number) {
  return z.string().max(maxLength).optional()
    .transform(value => (value === undefined || value === "" ? undefined : value));
}

const turnKey = {
  session_id: uuid,
  prompt_id: identifier
};

export const BindTurnInputSchema = z.object({
  ...turnKey,
  prompt,
  transcript_path: optionalText(8_192),
  hook_event_name: z.literal("UserPromptSubmit")
}).strict();

export const RecordToolInputSchema = z.object({
  ...turnKey,
  tool_use_id: identifier,
  tool_name: toolName,
  agent_id: optionalIdentifier,
  command: optionalText(32_768),
  file_path: optionalText(4_096),
  path: optionalText(4_096),
  pattern: optionalText(8_192),
  query: optionalText(8_192),
  url: optionalText(8_192),
  skill: optionalText(2_048),
  description: optionalText(2_048),
  hook_event_name: z.literal("PreToolUse")
}).strict();

export const RecordToolSuccessInputSchema = z.object({
  ...turnKey,
  tool_use_id: identifier,
  hook_event_name: z.literal("PostToolUse")
}).strict();

export const RecordToolFailureInputSchema = z.object({
  ...turnKey,
  tool_use_id: identifier,
  hook_event_name: z.literal("PostToolUseFailure")
}).strict();

export const FinishTurnInputSchema = z.object({
  ...turnKey,
  last_assistant_message: optionalText(100_000),
  hook_event_name: z.union([z.literal("Stop"), z.literal("StopFailure")])
}).strict();

export type BindTurnInput = z.infer<typeof BindTurnInputSchema>;
export type RecordToolInput = z.infer<typeof RecordToolInputSchema>;
export type RecordToolSuccessInput = z.infer<typeof RecordToolSuccessInputSchema>;
export type RecordToolFailureInput = z.infer<typeof RecordToolFailureInputSchema>;
export type FinishTurnInput = z.infer<typeof FinishTurnInputSchema>;
