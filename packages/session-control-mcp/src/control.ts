import { z } from "zod";
import { assertAuthorizedChat, type RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

export const CONFIRMATION = "RESET SESSION";
export const RESET_ACCEPTED_TEXT = "Session reset accepted. Starting a fresh session now…";
export const RESET_SCHEDULER_FAILED_TEXT = "Session reset scheduling failed. No reset was started.";

export const ResetRequestSchema = z.object({
  chat_id: z.string().regex(/^\d+$/),
  message_id: z.string().regex(/^\d+$/),
  confirmation: z.literal(CONFIRMATION)
}).strict();

export type ResetRequest = z.infer<typeof ResetRequestSchema>;

export interface ResetReceipt {
  status: "scheduled";
  ackMessageId: number;
  unit: string;
}

export interface ResetControllerDeps {
  loadConfig: () => RuntimeConfig;
  sendMessage: (config: RuntimeConfig, chatId: string, text: string) => Promise<number>;
  schedule: (chatId: string, messageId: string) => Promise<string>;
}

export function createResetController(deps: ResetControllerDeps) {
  return async (rawRequest: ResetRequest): Promise<ResetReceipt> => {
    const request = ResetRequestSchema.parse(rawRequest);
    const config = deps.loadConfig();
    assertAuthorizedChat(config, request.chat_id);

    let ackMessageId: number;
    try {
      ackMessageId = await deps.sendMessage(config, request.chat_id, RESET_ACCEPTED_TEXT);
    } catch {
      throw new Error("ACK delivery failed; reset was not scheduled");
    }

    let unit: string;
    try {
      unit = await deps.schedule(request.chat_id, request.message_id);
    } catch {
      try {
        await deps.sendMessage(config, request.chat_id, RESET_SCHEDULER_FAILED_TEXT);
      } catch {
        // The primary failure is scheduler rejection; notification is best-effort.
      }
      throw new Error("reset scheduler failed");
    }

    return { status: "scheduled", ackMessageId, unit };
  };
}
