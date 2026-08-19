import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import {
  BindCommandInputSchema,
  MAX_SESSION_INDEX,
  type BindCommandInput
} from "./command-capability.js";
import {
  ListSessionsRequestSchema,
  ResumeSessionRequestSchema,
  type ListSessionsReceipt,
  type ListSessionsRequest,
  type ResumeSessionReceipt,
  type ResumeSessionRequest
} from "./sessions-control.js";

/**
 * The model may relay that a user typed `/sessions` or `/resume 3`. It may not supply a session
 * UUID, a transcript path, a unit, or a service: the public tools below accept only a chat and a
 * one-based index, and both are checked against the capability the hook bound this turn.
 */

const CHAT_ID = {
  type: "string",
  pattern: "^-?\\d+$",
  description: "Allowlisted chat_id from the inbound Telegram channel event."
} as const;

export const LIST_SESSIONS_TOOL = {
  name: "list_sessions",
  description:
    "List up to ten recent resumable Claude Code sessions for an exact inbound /sessions command. The control MCP scans its own configured sessions directory, sends the numbered list itself, and records the index-to-session mapping privately. Use only for an exact /sessions command.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["chat_id"],
    properties: { chat_id: CHAT_ID }
  }
} as const;

export const RESUME_SESSION_TOOL = {
  name: "resume_session",
  description:
    "Resume a previously listed Claude Code session by its one-based list index. The exact session is resolved from the private selection snapshot, never from this call. The control MCP sends its own acknowledgement and delegates execution to a root-owned systemd oneshot. Use only for an exact /resume N command.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["chat_id", "index"],
    properties: {
      chat_id: CHAT_ID,
      index: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SESSION_INDEX,
        description: "One-based index from the most recent /sessions list in this chat."
      }
    }
  }
} as const;

export const BIND_COMMAND_TOOL = {
  name: "bind_command",
  description:
    "Internal Claude Code hook tool. Not for model use. Wired to UserPromptSubmit. Binds a current-turn capability when the prompt is an exact direct Telegram /sessions or /resume N command. The prompt is never stored or logged.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
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
      prompt: { type: "string", maxLength: 1000000 },
      hook_event_name: { type: "string", const: "UserPromptSubmit" }
    }
  }
} as const;

export const SESSIONS_TOOLS = [LIST_SESSIONS_TOOL, RESUME_SESSION_TOOL, BIND_COMMAND_TOOL] as const;
export const SESSIONS_TOOL_NAMES = SESSIONS_TOOLS.map(tool => tool.name);

export interface SessionsToolDeps {
  controller: {
    listSessions: (request: ListSessionsRequest) => Promise<ListSessionsReceipt>;
    resumeSession: (request: ResumeSessionRequest) => Promise<ResumeSessionReceipt>;
  };
  capabilities: {
    bind: (input: BindCommandInput) => boolean;
  };
}

/** Hooks are non-blocking, so the binder always answers with an empty success receipt. */
const HOOK_RECEIPT: CallToolResult = { content: [{ type: "text", text: "" }] };

function failure(error: unknown, label: string): CallToolResult {
  const message = error instanceof ZodError
    ? `invalid ${label} request: ${error.issues.map(issue => issue.message).join("; ")}`
    : `${label} request failed`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function createSessionsToolHandler(deps: SessionsToolDeps) {
  return async (name: string, arguments_: unknown): Promise<CallToolResult | null> => {
    if (name === BIND_COMMAND_TOOL.name) {
      try {
        deps.capabilities.bind(BindCommandInputSchema.parse(arguments_));
      } catch {
        // A malformed or spoofed hook call binds nothing and never fails the agent.
      }
      return HOOK_RECEIPT;
    }

    if (name === LIST_SESSIONS_TOOL.name) {
      try {
        const receipt = await deps.controller.listSessions(ListSessionsRequestSchema.parse(arguments_));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: receipt.status,
              count: receipt.count,
              ack_message_id: receipt.ackMessageId
            })
          }]
        };
      } catch (error) {
        return failure(error, "list_sessions");
      }
    }

    if (name === RESUME_SESSION_TOOL.name) {
      try {
        const receipt = await deps.controller.resumeSession(ResumeSessionRequestSchema.parse(arguments_));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: receipt.status,
              ack_message_id: receipt.ackMessageId,
              unit: receipt.unit
            })
          }]
        };
      } catch (error) {
        return failure(error, "resume");
      }
    }

    return null;
  };
}
