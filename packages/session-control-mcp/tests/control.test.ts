import { describe, expect, test } from "bun:test";
import {
  CONFIRMATION,
  createResetController,
  RESET_ACCEPTED_TEXT,
  RESET_SCHEDULER_FAILED_TEXT,
  ResetRequestSchema
} from "../src/control.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const config: RuntimeConfig = {
  token: TEST_TOKEN,
  allowedChatIds: new Set(["123456789"])
};

describe("reset control plane", () => {
  test("rejects a lossy inbound message ID", () => {
    expect(() => ResetRequestSchema.parse({
      chat_id: "123456789",
      message_id: "9007199254740993",
      current_session_id: SESSION,
      confirmation: CONFIRMATION
    })).toThrow();
  });

  test("authorizes, acknowledges, then schedules the root helper", async () => {
    const events: string[] = [];
    const controller = createResetController({
      loadConfig: () => config,
      helperReady: async () => true,
      sendMessage: async (_cfg, chatId, text, replyTo, parseMode) => {
        events.push(`ack:${chatId}:${replyTo}:${parseMode}:${text}`);
        return 71;
      },
      react: async (_cfg, chatId, messageId, state) => {
        events.push(`react:${chatId}:${messageId}:${state}`);
        return true;
      },
      schedule: async (chatId, _messageId, currentSessionId) => {
        events.push(`schedule:${chatId}:${currentSessionId}`);
        return "claude-session-reset-test";
      }
    });
    const request = ResetRequestSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      current_session_id: SESSION,
      confirmation: CONFIRMATION
    });

    const receipt = await controller(request);

    expect(receipt).toEqual({
      status: "scheduled",
      ackMessageId: 71,
      unit: "claude-session-reset-test"
    });
    expect(events[0]).toBe(`ack:123456789:51:HTML:${RESET_ACCEPTED_TEXT}`);
    expect(events[1]).toBe("react:123456789:51:success");
    expect(events[2]).toBe(`schedule:123456789:${SESSION}`);
  });

  test("keeps scheduling after the confirmed ACK when reaction finalization fails", async () => {
    let scheduleCalls = 0;
    const controller = createResetController({
      loadConfig: () => config,
      helperReady: async () => true,
      sendMessage: async () => 71,
      react: async () => { throw new TypeError("reaction timeout"); },
      schedule: async () => {
        scheduleCalls += 1;
        return "claude-session-reset-test";
      }
    });

    const receipt = await controller({
      chat_id: "123456789",
      message_id: "51",
      current_session_id: SESSION,
      confirmation: CONFIRMATION
    });

    expect(receipt.status).toBe("scheduled");
    expect(scheduleCalls).toBe(1);
  });

  test("never schedules when the ACK outcome is unknown", async () => {
    let scheduleCalls = 0;
    const controller = createResetController({
      loadConfig: () => config,
      helperReady: async () => true,
      sendMessage: async () => { throw new TypeError("timeout"); },
      react: async () => true,
      schedule: async () => {
        scheduleCalls += 1;
        return "unexpected";
      }
    });

    await expect(controller({ chat_id: "123456789", message_id: "51", current_session_id: SESSION, confirmation: CONFIRMATION })).rejects.toThrow(
      "ACK delivery failed"
    );
    expect(scheduleCalls).toBe(0);
  });

  test("fails closed before ACK when the helper is unavailable", async () => {
    let ackCalls = 0;
    const controller = createResetController({
      loadConfig: () => config,
      helperReady: async () => false,
      sendMessage: async () => { ackCalls += 1; return 1; },
      react: async () => true,
      schedule: async () => "unexpected"
    });

    await expect(controller({ chat_id: "123456789", message_id: "51", current_session_id: SESSION, confirmation: CONFIRMATION }))
      .rejects.toThrow("unavailable");
    expect(ackCalls).toBe(0);
  });

  test("fails closed before ACK for an unauthorized chat", async () => {
    let ackCalls = 0;
    const controller = createResetController({
      loadConfig: () => config,
      helperReady: async () => true,
      sendMessage: async () => { ackCalls += 1; return 1; },
      react: async () => true,
      schedule: async () => "unexpected"
    });

    await expect(controller({ chat_id: "999", message_id: "51", current_session_id: SESSION, confirmation: CONFIRMATION })).rejects.toThrow(
      "chat is not authorized"
    );
    expect(ackCalls).toBe(0);
  });

  test("reports scheduler failure after a successful ACK", async () => {
    const messages: string[] = [];
    const reactions: Array<[string, string, string]> = [];
    const controller = createResetController({
      loadConfig: () => config,
      helperReady: async () => true,
      sendMessage: async (_cfg, _chatId, text, replyTo, parseMode) => {
        messages.push(`${replyTo ?? "independent"}:${parseMode}:${text}`);
        return messages.length;
      },
      react: async (_cfg, chatId, messageId, state) => {
        reactions.push([chatId, messageId, state]);
        return true;
      },
      schedule: async () => { throw new Error("systemd rejected"); }
    });

    await expect(controller({ chat_id: "123456789", message_id: "51", current_session_id: SESSION, confirmation: CONFIRMATION })).rejects.toThrow(
      "reset scheduler failed"
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(`51:HTML:${RESET_ACCEPTED_TEXT}`);
    expect(messages[1]).toBe(`independent:HTML:${RESET_SCHEDULER_FAILED_TEXT}`);
    expect(reactions).toEqual([
      ["123456789", "51", "success"],
      ["123456789", "51", "failure"]
    ]);
  });
});
