import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { UnifiedReplyInputSchema, type UnifiedReplyInput } from "./unified-contract.js";
import type { UnifiedDeliveryReceipt } from "./unified-delivery.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

export const SEND_REPLY_TOOL = {
  name: "send_reply",
  description:
    "Send one Telegram reply from canonical raw Markdown. The sidecar deterministically chooses native Rich Message only for tables, task lists, details, or block math; ordinary Markdown uses MarkdownV2. Use exactly once per user-facing answer.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["chat_id", "content"],
    properties: {
      chat_id: {
        type: "string",
        pattern: "^-?\\d+$",
        description: "Allowlisted chat_id from the inbound Telegram channel event."
      },
      content: {
        type: "string",
        minLength: 1,
        maxLength: 100000,
        description: "Canonical CommonMark/GFM reply. Do not pre-escape for Telegram."
      },
      reply_to: {
        type: "string",
        pattern: "^\\d+$",
        description: "Optional inbound message_id to quote."
      },
      disable_notification: {
        type: "boolean",
        default: false
      }
    }
  }
} as const;

export interface UnifiedToolDeps {
  loadConfig: () => RuntimeConfig;
  deliver: (input: UnifiedReplyInput, config: RuntimeConfig) => Promise<UnifiedDeliveryReceipt>;
}

export function createUnifiedToolHandler(deps: UnifiedToolDeps) {
  return async (name: string, arguments_: unknown): Promise<CallToolResult> => {
    if (name !== SEND_REPLY_TOOL.name) {
      return {
        isError: true,
        content: [{ type: "text", text: "unknown tool" }]
      };
    }
    try {
      const input = UnifiedReplyInputSchema.parse(arguments_);
      const receipt = await deps.deliver(input, deps.loadConfig());
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ mode: receipt.mode, message_ids: receipt.messageIds })
        }]
      };
    } catch (error) {
      const message = error instanceof ZodError
        ? `invalid input: ${error.issues.map(issue => issue.message).join("; ")}`
        : "send_reply failed";
      return {
        isError: true,
        content: [{ type: "text", text: message }]
      };
    }
  };
}
