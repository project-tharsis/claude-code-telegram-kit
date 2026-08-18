import { describe, expect, test } from "bun:test";
import { UnifiedReplyInputSchema } from "../src/unified-contract.js";
import { toMarkdownV2 } from "../src/markdown.js";

describe("canonical raw Markdown contract", () => {
  test("accepts one raw Markdown document and applies bounded defaults", () => {
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      content: "## 状态\n\n**在线**"
    });
    expect(input).toEqual({
      chat_id: "123456789",
      content: "## 状态\n\n**在线**",
      disable_notification: false
    });
  });

  test("rejects empty or unbounded content", () => {
    expect(() => UnifiedReplyInputSchema.parse({ chat_id: "1", content: "   " })).toThrow();
    expect(() => UnifiedReplyInputSchema.parse({
      chat_id: "1",
      content: "x".repeat(100_001)
    })).toThrow("content exceeds 100000 characters");
  });

  test("converts ordinary CommonMark to valid Telegram MarkdownV2", () => {
    expect(toMarkdownV2("## 标题\n\n**重点**和普通列表\n\n- 一\n- 二")).toBe(
      "*标题*\n\n*重点*和普通列表\n\n•   一\n•   二"
    );
  });

  test("preserves fallback table data even without native Rich rendering", () => {
    const rendered = toMarkdownV2("| Layer | State |\n|---|---|\n| Claude | online |");
    expect(rendered).toContain("Layer");
    expect(rendered).toContain("State");
    expect(rendered).toContain("Claude");
    expect(rendered).toContain("online");
  });
});
