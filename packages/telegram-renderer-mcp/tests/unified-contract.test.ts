import { describe, expect, test } from "bun:test";
import { UnifiedReplyInputSchema } from "../src/unified-contract.js";
import { protectLiteralTildes, toMarkdownV2 } from "../src/markdown.js";

describe("canonical raw Markdown contract", () => {
  test("accepts one raw Markdown document and applies bounded defaults", () => {
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "## 状态\n\n**在线**"
    });
    expect(input).toEqual({
      chat_id: "123456789",
      message_id: "51",
      content: "## 状态\n\n**在线**",
      disable_notification: false
    });
  });

  test("rejects empty or unbounded content", () => {
    expect(() => UnifiedReplyInputSchema.parse({ chat_id: "1", message_id: "2", content: "   " })).toThrow();
    expect(() => UnifiedReplyInputSchema.parse({
      chat_id: "1",
      message_id: "2",
      content: "x".repeat(100_001)
    })).toThrow("content exceeds 100000 characters");
  });

  test("rejects unsafe Telegram message IDs before delivery", () => {
    expect(() => UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "9007199254740992",
      content: "done"
    })).toThrow();
    expect(() => UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      reply_to: "9007199254740993",
      content: "done"
    })).toThrow();
  });

  test("converts ordinary CommonMark to valid Telegram MarkdownV2", () => {
    expect(toMarkdownV2("## 标题\n\n**重点**和普通列表\n\n- 一\n- 二")).toBe(
      "*标题*\n\n*重点*和普通列表\n\n•   一\n•   二"
    );
  });

  test("escapes literal range tildes without breaking real strikethrough, code, or URLs", () => {
    const source = "纯驾驶5.5~6.5小时，徒步2~3小时。\n\n~~删除~~ `5~6` [profile](https://example.com/~user)";
    expect(protectLiteralTildes(source)).toBe(
      "纯驾驶5.5\\~6.5小时，徒步2\\~3小时。\n\n~~删除~~ `5~6` [profile](https://example.com/~user)"
    );
    expect(toMarkdownV2(source)).toBe(
      "纯驾驶5\\.5\\~6\\.5小时，徒步2\\~3小时。\n\n~删除~ `5~6` [profile](https://example.com/~user)"
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
