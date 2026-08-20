import { describe, expect, test } from "bun:test";
import { needsRichRendering, normalizeRichMarkdown } from "../src/router.js";

describe("Hermes-style deterministic routing", () => {
  test.each([
    ["pipe table", "| A | B |\n|---|---|\n| 1 | 2 |"],
    ["task list", "- [x] shipped\n- [ ] verify"],
    ["details", "<details>\n<summary>More</summary>\nBody\n</details>"],
    ["block math", "$$x^2 + y^2$$"]
  ])("routes %s to Rich Message", (_name, content) => {
    expect(needsRichRendering(content)).toBe(true);
  });

  test("keeps ordinary markdown and isolated delimiter lookalikes on the MarkdownV2 path", () => {
    expect(needsRichRendering("## 标题\n\n**重点**和普通列表\n\n- 一\n- 二")).toBe(false);
    expect(needsRichRendering("literal\n| - | - |\nend")).toBe(false);
    expect(needsRichRendering("| A | B |\n| - | - |")).toBe(true);
  });

  test("does not downgrade rich CJK content", () => {
    expect(needsRichRendering("## 持仓\n\n| 项目 | 状态 |\n|---|---|\n| 早盘 | 正常 |")).toBe(true);
  });

  test("routes oversized rich content to the legacy path", () => {
    const content = `| A | B |\n|---|---|\n| ${"x".repeat(32_768)} | y |`;
    expect(needsRichRendering(content)).toBe(false);
  });

  test("rejects a Rich candidate whose canonical escaping expands past the native limit", () => {
    const content = `| A | B |\n|---|---|\n| ${"*".repeat(17_000)} | y |`;
    expect(needsRichRendering(content)).toBe(true);
    expect(normalizeRichMarkdown(content)).toBeNull();
  });

  test("normalizes prose newlines but preserves code and table rows", () => {
    const content = [
      "Line 1",
      "Line 2",
      "",
      "```bash",
      "echo one",
      "echo two",
      "```",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |"
    ].join("\n");
    expect(normalizeRichMarkdown(content)).toBe([
      "Line 1  ",
      "Line 2",
      "",
      "```bash",
      "echo one",
      "echo two",
      "```",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |"
    ].join("\n"));
  });

  test("protects every line of an unlabeled fenced code block", () => {
    const content = "```\nline * literal\nnext_line\n```\nAfter\ntext";
    expect(normalizeRichMarkdown(content)).toBe(
      "```\nline * literal\nnext_line\n```\n\nAfter  \ntext"
    );
  });
});
