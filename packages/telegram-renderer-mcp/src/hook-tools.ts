import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BindTurnInputSchema,
  FinishTurnInputSchema,
  RecordToolFailureInputSchema,
  RecordToolInputSchema,
  type BindTurnInput,
  type FinishTurnInput,
  type RecordToolFailureInput,
  type RecordToolInput
} from "./hook-contract.js";

/**
 * These four tools exist for Claude Code `mcp_tool` hooks, not for the model. They are named
 * and described so a reader can tell them apart from the public `send_reply` tool at a glance,
 * and the example settings deny model access to all of them. Denying access is a UX guarantee,
 * not a security boundary: every handler below independently rejects a payload whose
 * `hook_event_name` does not match the exact event that tool serves.
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
      prompt: { type: "string", maxLength: 1000000 },
      hook_event_name: { type: "string", const: "UserPromptSubmit" }
    }
  }
} as const;

export const RECORD_TOOL_TOOL = {
  name: "record_tool",
  description:
    `${INTERNAL_PREFIX} Wired to PreToolUse. Records that a tool started, by tool_use_id and tool_name only. Tool input is never accepted or exposed.`,
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
        description: "Present when the tool ran inside a subagent; collapses to one delegating step."
      },
      hook_event_name: { type: "string", const: "PreToolUse" }
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

export const FINISH_TURN_TOOL = {
  name: "finish_turn",
  description:
    `${INTERNAL_PREFIX} Wired to Stop and StopFailure. Closes the turn and performs one bounded final drain of the progress bubble.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "hook_event_name"],
    properties: {
      ...turnKeyProperties,
      hook_event_name: { type: "string", enum: ["Stop", "StopFailure"] }
    }
  }
} as const;

export const INTERNAL_HOOK_TOOLS = [
  BIND_TURN_TOOL,
  RECORD_TOOL_TOOL,
  RECORD_TOOL_FAILURE_TOOL,
  FINISH_TURN_TOOL
] as const;

export const HOOK_TOOL_NAMES: string[] = INTERNAL_HOOK_TOOLS.map(tool => tool.name);

export interface HookDisclosure {
  /** Binds the submitted prompt as a disclosure turn, or ignores it silently. */
  bindTurn: (input: BindTurnInput) => void;
  recordTool: (input: RecordToolInput) => void;
  recordFailure: (input: RecordToolFailureInput) => void;
  finishTurn: (input: FinishTurnInput) => Promise<void>;
}

/**
 * Hooks are presentation-only, so every outcome is a non-blocking success with an empty body.
 * An empty body also keeps hook output out of the transcript: Claude Code only injects hook
 * output as additional context when it is non-empty.
 */
const RECEIPT: CallToolResult = { content: [{ type: "text", text: "" }] };

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
        case RECORD_TOOL_FAILURE_TOOL.name:
          disclosure.recordFailure(RecordToolFailureInputSchema.parse(arguments_));
          break;
        case FINISH_TURN_TOOL.name:
          await disclosure.finishTurn(FinishTurnInputSchema.parse(arguments_));
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
