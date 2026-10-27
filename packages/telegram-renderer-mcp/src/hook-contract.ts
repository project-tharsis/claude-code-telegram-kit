import { z } from "zod";
import { RUNTIME_FAILURE_TYPES } from "./runtime-failure-watcher.js";

export const MAX_HOOK_FINAL_CHARACTERS = 1_000_000;

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
function boundedText(maxLength: number) {
  return z.string().refine(
    value => Array.from(value).length <= maxLength,
    `text exceeds ${maxLength} characters`
  );
}

/** Never persisted, never logged; parsed for the direct-envelope target and then dropped. */
const prompt = boundedText(1_000_000);

/** An empty string is Claude Code's rendering of an absent optional template field. */
const optionalIdentifier = z.union([z.literal(""), identifier])
  .optional()
  .transform(value => (value === undefined || value === "" ? undefined : value));
const optionalTaskStatus = z.union([
  z.literal(""),
  boundedText(64)
]).optional().transform(value => (value === undefined || value === "" ? undefined : value));

function optionalText(maxLength: number) {
  return boundedText(maxLength).optional()
    .transform(value => (value === undefined || value === "" ? undefined : value));
}

function requiredTemplateText(maxLength: number) {
  return boundedText(maxLength)
    .transform(value => (value === "" ? undefined : value));
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
  offset: optionalText(32),
  limit: optionalText(32),
  pattern: optionalText(8_192),
  query: optionalText(8_192),
  url: optionalText(8_192),
  skill: optionalText(128),
  description: optionalText(2_048),
  hook_event_name: z.literal("PreToolUse")
}).strict();


export const RecordToolSuccessInputSchema = z.object({
  ...turnKey,
  tool_use_id: identifier,
  tool_name: toolName.optional(),
  task_status: optionalTaskStatus,
  task_id: optionalIdentifier,
  hook_event_name: z.literal("PostToolUse")
}).strict();

export const RecordToolFailureInputSchema = z.object({
  ...turnKey,
  tool_use_id: identifier,
  hook_event_name: z.literal("PostToolUseFailure")
}).strict();

const subagentLifecycle = {
  ...turnKey,
  agent_id: identifier,
  agent_type: identifier
};

export const RecordSubagentStartInputSchema = z.object({
  ...subagentLifecycle,
  hook_event_name: z.literal("SubagentStart")
}).strict();

export const RecordSubagentStopInputSchema = z.object({
  ...subagentLifecycle,
  stop_hook_active: z.boolean().optional(),
  background_tasks: z.array(z.unknown()).optional(),
  session_crons: z.array(z.unknown()).optional(),
  hook_event_name: z.literal("SubagentStop")
}).strict();

const StopInputSchema = z.object({
  ...turnKey,
  last_assistant_message: requiredTemplateText(MAX_HOOK_FINAL_CHARACTERS),
  stop_hook_active: z.boolean().optional(),
  background_tasks: z.array(z.unknown()).optional(),
  session_crons: z.array(z.unknown()).optional(),
  hook_event_name: z.literal("Stop")
}).strict();

const StopFailureInputSchema = z.object({
  ...turnKey,
  last_assistant_message: requiredTemplateText(MAX_HOOK_FINAL_CHARACTERS),
  error: z.enum(RUNTIME_FAILURE_TYPES),
  hook_event_name: z.literal("StopFailure")
}).strict();

export const FinishTurnInputSchema = z.discriminatedUnion("hook_event_name", [
  StopInputSchema,
  StopFailureInputSchema
]);

/**
 * Zod 4 keeps a key required in the output type when its transform may yield `undefined`.
 * Parsed payloads omit such keys, so restore the optional-key shape for callers. Runtime
 * validation is unchanged: the input schemas above still require every template field.
 */
type UndefinedKeysOptional<T> = T extends unknown
  ? { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
    & { [K in keyof T as undefined extends T[K] ? K : never]?: T[K] }
  : never;
type HookOutput<S extends z.ZodType> = UndefinedKeysOptional<z.infer<S>>;

export type BindTurnInput = HookOutput<typeof BindTurnInputSchema>;
export type RecordToolInput = HookOutput<typeof RecordToolInputSchema>;

export type RecordToolSuccessInput = HookOutput<typeof RecordToolSuccessInputSchema>;
export type RecordToolFailureInput = HookOutput<typeof RecordToolFailureInputSchema>;
export type RecordSubagentStartInput = HookOutput<typeof RecordSubagentStartInputSchema>;
export type RecordSubagentStopInput = HookOutput<typeof RecordSubagentStopInputSchema>;
export type FinishTurnInput = HookOutput<typeof FinishTurnInputSchema>;
