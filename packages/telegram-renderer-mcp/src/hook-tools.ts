import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BindTurnInputSchema,
  FinishTurnInputSchema,
  MAX_HOOK_FINAL_CHARACTERS,
  RecordSubagentStartInputSchema,
  RecordSubagentStopInputSchema,
  RecordToolFailureInputSchema,
  RecordToolInputSchema,
  RecordToolSuccessInputSchema,
  type BindTurnInput,
  type FinishTurnInput,
  type RecordSubagentStartInput,
  type RecordSubagentStopInput,
  type RecordToolFailureInput,
  type RecordToolInput,
  type RecordToolSuccessInput
} from "./hook-contract.js";
import { RUNTIME_FAILURE_TYPES } from "./runtime-failure-watcher.js";
import type { FinishTurnDisposition } from "./progress-disclosure.js";

/**
 * These five tools exist for Claude Code lifecycle hooks, not for the model. The example settings
 * deny model access to every hook tool.
 * Every handler also rejects payloads whose `hook_event_name` does not match the exact event that
 * tool serves; raw hook objects and outputs are never accepted.
 */

const INTERNAL_PREFIX = "Internal Claude Code hook tool. Not for model use.";

const IDENTIFIER_PATTERN = "^[A-Za-z0-9_.:-]{1,128}$";
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const turnKeyProperties = {
  session_id: {
    type: "string",
    pattern: UUID_PATTERN,
    description: "Claude Code session_id supplied by the hook runtime."
  },
  prompt_id: {
    type: "string",
    pattern: IDENTIFIER_PATTERN,
    description: "Claude Code prompt_id supplied by the hook runtime."
  }
} as const;

export const BIND_TURN_TOOL = {
  name: "bind_turn",
  description:
    `${INTERNAL_PREFIX} Wired to UserPromptSubmit. Binds the current turn to a direct inbound Telegram message. The prompt is parsed for the official channel envelope and is never stored or logged.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "prompt", "hook_event_name"],
    properties: {
      ...turnKeyProperties,
      prompt: { type: "string", maxLength: 1_000_000 },
      transcript_path: { type: "string", maxLength: 8_192 },
      hook_event_name: { type: "string", const: "UserPromptSubmit" }
    }
  }
} as const;

export const RECORD_TOOL_TOOL = {
  name: "record_tool",
  description:
    `${INTERNAL_PREFIX} Wired to PreToolUse. Records that a tool started plus selected bounded preview fields. The raw tool_input object and tool output are never accepted.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "tool_use_id", "tool_name", "hook_event_name"],
    properties: {
      ...turnKeyProperties,
      tool_use_id: { type: "string", pattern: IDENTIFIER_PATTERN },
      tool_name: { type: "string", pattern: IDENTIFIER_PATTERN },
      agent_id: {
        type: "string",
        pattern: "^(?:|[A-Za-z0-9_.:-]{1,128})$",
        description: "Present when the tool ran inside a subagent; nested tools remain individually disclosed."
      },
      command: { type: "string", maxLength: 32768 },
      file_path: { type: "string", maxLength: 4096 },
      path: { type: "string", maxLength: 4096 },
      offset: { type: "string", maxLength: 32 },
      limit: { type: "string", maxLength: 32 },
      pattern: { type: "string", maxLength: 8192 },
      query: { type: "string", maxLength: 8192 },
      url: { type: "string", maxLength: 8192 },
      skill: { type: "string", maxLength: 128 },
      description: { type: "string", maxLength: 2048 },
      hook_event_name: { type: "string", const: "PreToolUse" }
    }
  }
} as const;


export const RECORD_TOOL_SUCCESS_TOOL = {
  name: "record_tool_success",
  description:
    `${INTERNAL_PREFIX} Wired to PostToolUse. Marks an already-recorded tool_use_id as completed and accepts only bounded task status plus task identity. Tool output is never accepted.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "tool_use_id", "hook_event_name"],
    properties: {
      ...turnKeyProperties,
      tool_use_id: { type: "string", pattern: IDENTIFIER_PATTERN },
      task_status: { type: "string", maxLength: 64 },
      task_id: { type: "string", pattern: `^(?:|${IDENTIFIER_PATTERN.slice(1, -1)})$` },
      hook_event_name: { type: "string", const: "PostToolUse" }
    }
  }
} as const;

export const RECORD_TOOL_FAILURE_TOOL = {
  name: "record_tool_failure",
  description:
    `${INTERNAL_PREFIX} Wired to PostToolUseFailure. Marks an already-recorded tool_use_id as failed. The error text is never accepted.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "tool_use_id", "hook_event_name"],
    properties: {
      ...turnKeyProperties,
      tool_use_id: { type: "string", pattern: IDENTIFIER_PATTERN },
      hook_event_name: { type: "string", const: "PostToolUseFailure" }
    }
  }
} as const;

const subagentLifecycleProperties = {
  ...turnKeyProperties,
  agent_id: { type: "string", pattern: IDENTIFIER_PATTERN },
  agent_type: { type: "string", pattern: IDENTIFIER_PATTERN }
} as const;

export const RECORD_SUBAGENT_START_TOOL = {
  name: "record_subagent_start",
  description:
    `${INTERNAL_PREFIX} Wired to SubagentStart. Records bounded agent identity only; no prompt or transcript content is accepted.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "agent_id", "agent_type", "hook_event_name"],
    properties: {
      ...subagentLifecycleProperties,
      hook_event_name: { type: "string", const: "SubagentStart" }
    }
  }
} as const;

export const RECORD_SUBAGENT_STOP_TOOL = {
  name: "record_subagent_stop",
  description:
    `${INTERNAL_PREFIX} Wired to SubagentStop. Marks a known bounded agent identity complete; final subagent text is never accepted.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "agent_id", "agent_type", "hook_event_name"],
    properties: {
      ...subagentLifecycleProperties,
      hook_event_name: { type: "string", const: "SubagentStop" }
    }
  }
} as const;

export const FINISH_TURN_TOOL = {
  name: "finish_turn",
  description:
    `${INTERNAL_PREFIX} Wired to Stop and StopFailure. Closes progress and auto-delivers the final assistant Markdown for a bound Telegram turn.`,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "last_assistant_message", "hook_event_name"],
    properties: {
      ...turnKeyProperties,
      last_assistant_message: { type: "string", maxLength: MAX_HOOK_FINAL_CHARACTERS },
      error: { type: "string", enum: [...RUNTIME_FAILURE_TYPES] },
      hook_event_name: { type: "string", enum: ["Stop", "StopFailure"] }
    },
    oneOf: [
      {
        properties: { hook_event_name: { const: "Stop" } },
        not: { required: ["error"] }
      },
      {
        properties: { hook_event_name: { const: "StopFailure" } },
        required: ["error"]
      }
    ]
  }
} as const;

export const INTERNAL_HOOK_TOOLS = [
  BIND_TURN_TOOL,
  RECORD_TOOL_TOOL,
  RECORD_TOOL_SUCCESS_TOOL,
  RECORD_TOOL_FAILURE_TOOL,
  RECORD_SUBAGENT_START_TOOL,
  RECORD_SUBAGENT_STOP_TOOL,
  FINISH_TURN_TOOL
] as const;

export const HOOK_TOOL_NAMES: string[] = INTERNAL_HOOK_TOOLS.map(tool => tool.name);


export interface HookDisclosure {
  /** Binds the submitted prompt as a disclosure turn, or ignores it silently. */
  bindTurn: (input: BindTurnInput) => void;
  recordTool: (input: RecordToolInput) => void;
  recordSubagentStart: (input: RecordSubagentStartInput) => void;
  recordSubagentStop: (input: RecordSubagentStopInput) => void;
  recordSuccess: (input: RecordToolSuccessInput) => void;
  recordFailure: (input: RecordToolFailureInput) => void;
  finishTurn: (input: FinishTurnInput) => Promise<FinishTurnDisposition>;
}

/**
 * Normal outcomes use an empty receipt so no hook context enters the transcript. The sole
 * exception is a proven local size rejection at Stop, which blocks once with bounded feedback
 * so Claude can return a shorter final response.
 */
const RECEIPT: CallToolResult = { content: [{ type: "text", text: "" }] };
const STOP_RETRY_RECEIPT: CallToolResult = {
  content: [{
    type: "text",
    text: JSON.stringify({
      decision: "block",
      reason: "Final Telegram reply is too long. Return a shorter final response.",
      hookSpecificOutput: { hookEventName: "Stop" }
    })
  }]
};
export function createHookToolHandler(disclosure: HookDisclosure) {
  return async (name: string, arguments_: unknown): Promise<CallToolResult | null> => {
    if (!HOOK_TOOL_NAMES.includes(name)) return null;
    try {
      switch (name) {
        case BIND_TURN_TOOL.name:
          disclosure.bindTurn(BindTurnInputSchema.parse(arguments_));
          break;
        case RECORD_TOOL_TOOL.name:
          disclosure.recordTool(RecordToolInputSchema.parse(arguments_));
          break;
        case RECORD_SUBAGENT_START_TOOL.name:
          disclosure.recordSubagentStart(RecordSubagentStartInputSchema.parse(arguments_));
          break;
        case RECORD_SUBAGENT_STOP_TOOL.name:
          disclosure.recordSubagentStop(RecordSubagentStopInputSchema.parse(arguments_));
          break;
        case RECORD_TOOL_SUCCESS_TOOL.name:
          disclosure.recordSuccess(RecordToolSuccessInputSchema.parse(arguments_));
          break;
        case RECORD_TOOL_FAILURE_TOOL.name:
          disclosure.recordFailure(RecordToolFailureInputSchema.parse(arguments_));
          break;
        case FINISH_TURN_TOOL.name:
          if (await disclosure.finishTurn(FinishTurnInputSchema.parse(arguments_)) === "retry") {
            return STOP_RETRY_RECEIPT;
          }
          break;
        default:
          break;
      }
    } catch {
      // A malformed, spoofed, or failing hook call must never block or fail the agent.
    }
    return RECEIPT;
  };
}
