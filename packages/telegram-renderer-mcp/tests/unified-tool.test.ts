import { describe, expect, test } from "bun:test";
import { createUnifiedToolHandler, SEND_REPLY_TOOL } from "../src/unified-tool.js";
import type { UnifiedReplyInput } from "../src/unified-contract.js";
import {
  TelegramUncertainOutcomeError,
  type UnifiedDeliveryReceipt
} from "../src/unified-delivery.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;

describe("unified MCP tool", () => {
  test("exposes one raw Markdown tool and returns a bounded receipt", async () => {
    let delivered: UnifiedReplyInput | undefined;
    const config: RuntimeConfig = {
      token: TEST_TOKEN,
      allowedChatIds: new Set(["123456789"])
    };
    const handler = createUnifiedToolHandler({
      loadConfig: () => config,
      deliver: async (input): Promise<UnifiedDeliveryReceipt> => {
        delivered = input;
        return { mode: "rich", messageIds: [61] };
      },
      react: async () => true
    });

    const result = await handler("send_reply", {
      chat_id: "123456789",
      message_id: "51",
      content: "## 状态\n\n| Layer | State |\n|---|---|\n| Claude | online |"
    });

    expect(SEND_REPLY_TOOL.name).toBe("send_reply");
    expect(delivered?.disable_notification).toBe(false);
    expect(result.isError).toBeUndefined();
    const first = result.content[0]!;
    expect(first.type).toBe("text");
    if (first.type !== "text") throw new Error("expected text receipt");
    expect(JSON.parse(first.text)).toEqual({
      mode: "rich",
      message_ids: [61]
    });
  });

  test("marks an input rejected before delivery as a definitive failure", async () => {
    const reactions: Array<[string, string, string]> = [];
    const config: RuntimeConfig = {
      token: TEST_TOKEN,
      allowedChatIds: new Set(["123456789"])
    };
    let delivered = 0;
    const handler = createUnifiedToolHandler({
      loadConfig: () => config,
      deliver: async (): Promise<UnifiedDeliveryReceipt> => {
        delivered += 1;
        return { mode: "text", messageIds: [1] };
      },
      react: async (_config, chatId, messageId, state) => {
        reactions.push([chatId, messageId, state]);
        return true;
      }
    });

    const result = await handler("send_reply", {
      chat_id: "123456789",
      message_id: "51",
      content: "x".repeat(100_001)
    });

    expect(result.isError).toBe(true);
    expect(delivered).toBe(0);
    expect(reactions).toEqual([["123456789", "51", "failure"]]);
  });

  test("leaves the acknowledgement untouched when Telegram's outcome is unknown", async () => {
    let reactions = 0;
    const config: RuntimeConfig = {
      token: TEST_TOKEN,
      allowedChatIds: new Set(["123456789"])
    };
    const handler = createUnifiedToolHandler({
      loadConfig: () => config,
      deliver: async () => {
        throw new TelegramUncertainOutcomeError("Telegram text delivery outcome unknown; no retry sent");
      },
      react: async () => {
        reactions += 1;
        return true;
      }
    });

    const result = await handler("send_reply", {
      chat_id: "123456789",
      message_id: "51",
      content: "done"
    });

    expect(result.isError).toBe(true);
    expect(reactions).toBe(0);
  });

  test("marks a definitive delivery rejection as a failure", async () => {
    const reactions: string[] = [];
    const config: RuntimeConfig = {
      token: TEST_TOKEN,
      allowedChatIds: new Set(["123456789"])
    };
    const handler = createUnifiedToolHandler({
      loadConfig: () => config,
      deliver: async () => {
        throw new Error("Telegram delivery rejected");
      },
      react: async (_config, _chatId, _messageId, state) => {
        reactions.push(state);
        return true;
      }
    });

    await handler("send_reply", {
      chat_id: "123456789",
      message_id: "51",
      content: "done"
    });

    expect(reactions).toEqual(["failure"]);
  });
});
