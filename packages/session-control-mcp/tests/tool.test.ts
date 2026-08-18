import { describe, expect, test } from "bun:test";
import { CONFIRMATION } from "../src/control.js";
import { createToolHandler, RESET_TOOL } from "../src/tool.js";

describe("control MCP tool", () => {
  test("exposes one destructive exact-confirmation tool", async () => {
    let request: unknown;
    const handler = createToolHandler(async value => {
      request = value;
      return { status: "scheduled", ackMessageId: 71, unit: "claude-session-reset-test" };
    });

    const result = await handler("schedule_session_reset", {
      chat_id: "123456789",
      confirmation: CONFIRMATION
    });

    expect(RESET_TOOL.name).toBe("schedule_session_reset");
    expect(RESET_TOOL.annotations?.destructiveHint).toBe(true);
    expect(request).toEqual({ chat_id: "123456789", confirmation: CONFIRMATION });
    expect(result.isError).toBeUndefined();
    const first = result.content[0]!;
    expect(first.type).toBe("text");
    if (first.type !== "text") throw new Error("expected text receipt");
    expect(JSON.parse(first.text)).toEqual({
      status: "scheduled",
      ack_message_id: 71,
      unit: "claude-session-reset-test"
    });
  });
});
