import { describe, expect, test } from "bun:test";
import { createUnifiedToolHandler, SEND_REPLY_TOOL } from "../src/unified-tool.js";
import type { UnifiedReplyInput } from "../src/unified-contract.js";
import type { UnifiedDeliveryReceipt } from "../src/unified-delivery.js";
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
      }
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
});
