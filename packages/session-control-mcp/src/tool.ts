import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import {
  ResetRequestSchema,
  type ResetReceipt,
  type ResetRequest
} from "./control.js";

export const RESET_TOOL = {
  name: "schedule_session_reset",
  description:
    "Schedule a fresh Claude Code session. The tool validates the Telegram allowlist, sends its own ACK, and delegates the reset to a root-owned systemd oneshot. Use only for an exact authorized reset command.",
  annotations: {
    destructiveHint: true,
    readOnlyHint: false,
    idempotentHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      chat_id: {
        type: "string",
        pattern: "^\\d+$",
        description: "Authorized private Telegram chat ID from the inbound channel event."
      },
      confirmation: {
        type: "string",
        const: "RESET SESSION",
        description: "Exact reset confirmation phrase."
      }
    },
    required: ["chat_id", "confirmation"]
  }
} as const;

export function createToolHandler(controller: (request: ResetRequest) => Promise<ResetReceipt>) {
  return async (name: string, arguments_: unknown): Promise<CallToolResult> => {
    if (name !== RESET_TOOL.name) {
      return { isError: true, content: [{ type: "text", text: "unknown control tool" }] };
    }
    try {
      const request = ResetRequestSchema.parse(arguments_);
      const receipt = await controller(request);
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
      const message = error instanceof ZodError
        ? `invalid reset request: ${error.issues.map(issue => issue.message).join("; ")}`
        : "reset request failed";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}
