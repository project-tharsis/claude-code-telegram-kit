import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  parseDirectTelegramEnvelope
} from "@project-tharsis/claude-code-telegram-shared";
import {
  ControlHookInputSchema,
  type ControlHookInput
} from "./control-input.js";
import { parseControlCommand } from "./control-command.js";
import type { ControlDispatchResult } from "./command-dispatch.js";

export const CONTROL_COMMAND_TOOL = {
  name: "dispatch_command",
  description:
    "Internal Claude Code hook tool for UserPromptSubmit. Deterministically handles direct Telegram /usage, /resume, /resume N, /model, /rename NAME, /reset, legacy /sessions, and confirmation commands before the LLM. Not for model use.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "prompt_id", "prompt", "hook_event_name"],
    properties: {
      session_id: {
        type: "string",
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
      },
      prompt_id: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
      prompt: { type: "string", maxLength: 1_000_000 },
      hook_event_name: { type: "string", const: "UserPromptSubmit" }
    }
  }
} as const;

const EMPTY_RECEIPT: CallToolResult = { content: [{ type: "text", text: "" }] };
const BLOCK_RECEIPT: CallToolResult = {
  content: [{
    type: "text",
    text: JSON.stringify({
      decision: "block",
      reason: "Handled by deterministic Telegram session control.",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        suppressOriginalPrompt: true
      }
    })
  }]
};

function isControlPrompt(input: ControlHookInput): boolean {
  try {
    const envelope = parseDirectTelegramEnvelope(input.prompt);
    return envelope !== null && parseControlCommand(envelope.body).kind !== "other";
  } catch {
    return false;
  }
}

export function createControlRouterToolHandler(
  dispatch: (input: ControlHookInput) => Promise<ControlDispatchResult>
) {
  return async (name: string, arguments_: unknown): Promise<CallToolResult | null> => {
    if (name !== CONTROL_COMMAND_TOOL.name) return null;

    let input: ControlHookInput;
    try {
      input = ControlHookInputSchema.parse(arguments_);
    } catch {
      return EMPTY_RECEIPT;
    }

    try {
      const result = await dispatch(input);
      return result.handled ? BLOCK_RECEIPT : EMPTY_RECEIPT;
    } catch {
      // A direct control namespace must never fall through to model interpretation merely
      // because the deterministic sidecar failed internally.
      return isControlPrompt(input) ? BLOCK_RECEIPT : EMPTY_RECEIPT;
    }
  };
}
