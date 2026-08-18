import { describe, expect, test } from "bun:test";
import {
  CONFIRMATION,
  createResetController,
  ResetRequestSchema
} from "../src/control.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const config: RuntimeConfig = {
  token: TEST_TOKEN,
  allowedChatIds: new Set(["123456789"])
};

describe("reset control plane", () => {
  test("authorizes, acknowledges, then schedules the root helper", async () => {
    const events: string[] = [];
    const controller = createResetController({
      loadConfig: () => config,
      sendMessage: async (_cfg, chatId, text) => {
        events.push(`ack:${chatId}:${text}`);
        return 71;
      },
      schedule: async chatId => {
        events.push(`schedule:${chatId}`);
        return "claude-session-reset-test";
      }
    });
    const request = ResetRequestSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      confirmation: CONFIRMATION
    });

    const receipt = await controller(request);

    expect(receipt).toEqual({
      status: "scheduled",
      ackMessageId: 71,
      unit: "claude-session-reset-test"
    });
    expect(events[0]?.startsWith("ack:123456789:")).toBe(true);
    expect(events[1]).toBe("schedule:123456789");
  });

  test("never schedules when the ACK outcome is unknown", async () => {
    let scheduleCalls = 0;
    const controller = createResetController({
      loadConfig: () => config,
      sendMessage: async () => { throw new TypeError("timeout"); },
      schedule: async () => {
        scheduleCalls += 1;
        return "unexpected";
      }
    });

    await expect(controller({ chat_id: "123456789", message_id: "51", confirmation: CONFIRMATION })).rejects.toThrow(
      "ACK delivery failed"
    );
    expect(scheduleCalls).toBe(0);
  });

  test("fails closed before ACK for an unauthorized chat", async () => {
    let ackCalls = 0;
    const controller = createResetController({
      loadConfig: () => config,
      sendMessage: async () => { ackCalls += 1; return 1; },
      schedule: async () => "unexpected"
    });

    await expect(controller({ chat_id: "999", message_id: "51", confirmation: CONFIRMATION })).rejects.toThrow(
      "chat is not authorized"
    );
    expect(ackCalls).toBe(0);
  });

  test("reports scheduler failure after a successful ACK", async () => {
    const messages: string[] = [];
    const controller = createResetController({
      loadConfig: () => config,
      sendMessage: async (_cfg, _chatId, text) => {
        messages.push(text);
        return messages.length;
      },
      schedule: async () => { throw new Error("systemd rejected"); }
    });

    await expect(controller({ chat_id: "123456789", message_id: "51", confirmation: CONFIRMATION })).rejects.toThrow(
      "reset scheduler failed"
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("No reset was started");
  });
});
