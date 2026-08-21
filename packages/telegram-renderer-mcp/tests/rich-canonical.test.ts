import { describe, expect, test } from "bun:test";
import { canonicalizeRichMarkdown } from "../src/rich-canonical.js";

describe("canonical Rich Markdown", () => {
  test("escapes CommonMark-literal delimiters", () => {
    const input = "数学：2 * 3 = 6，a_b_c 不该变斜体，*这个* 才该是斜体。\n\n连续星号 ****，连续下划线 ____，孤立反引号 ` ，未闭合的 *星号，未闭合的 [方括号。";
    expect(canonicalizeRichMarkdown(input)).toBe(
      "数学：2 \\* 3 = 6，a\\_b\\_c 不该变斜体，*这个* 才该是斜体。\n\n连续星号 \\*\\*\\*\\*，连续下划线 \\_\\_\\_\\_，孤立反引号 \\` ，未闭合的 \\*星号，未闭合的 \\[方括号。"
    );
  });

  test("preserves Telegram underline while retaining standard and nested emphasis", () => {
    expect(canonicalizeRichMarkdown(
      "**粗体** *斜体* __下划线 *斜体* 和 **粗体** 与 `code_x`__ ~~删除~~ ||隐藏||"
    )).toBe(
      "**粗体** *斜体* __下划线 *斜体* 和 **粗体** 与 `code_x`__ ~~删除~~ ||隐藏||"
    );
    expect(canonicalizeRichMarkdown("___both___")).toBe("***both***");
    expect(canonicalizeRichMarkdown("literal\n| - | - |\nend"))
      .toBe("literal\n\\| - | - |\nend");
  });

  test("makes CJK-adjacent emphasis safe for a standard downstream parser", () => {
    expect(canonicalizeRichMarkdown("**#3 对比图降级、改 caption。**图本身留着"))
      .toBe("**#3 对比图降级、改 caption。** 图本身留着");
    expect(canonicalizeRichMarkdown("前文**（重点）**"))
      .toBe("前文 **（重点）**");
    expect(canonicalizeRichMarkdown("[x](u)**中。**x"))
      .toBe("[x](u) **中。** x");
    expect(canonicalizeRichMarkdown("`x`**中。**x"))
      .toBe("`x` **中。** x");
    for (const canonical of [
      "**#3 对比图降级、改 caption。** 图本身留着",
      "前文 **（重点）**",
      "[x](u) **中。** x",
      "`x` **中。** x"
    ]) expect(canonicalizeRichMarkdown(canonical)).toBe(canonical);
  });

  test("preserves Rich-only and GFM structures while canonicalizing tables", () => {
    const input = [
      "[Anthropic](https://anthropic.com?a=1&b=2)",
      "",
      "```python",
      "x_y = 2 * 3",
      "```",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- [x] done",
      "",
      "<details>",
      "<summary>More</summary>",
      "Body",
      "</details>",
      "",
      "$$x^2$$"
    ].join("\n");
    const output = canonicalizeRichMarkdown(input)!;
    expect(output).toContain("[Anthropic](https://anthropic.com?a=1\\&b=2)");
    expect(output).toContain("```python\nx_y = 2 * 3\n```");
    expect(output).toContain("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(output).toContain("* [x] done");
    expect(output).toContain("<details>\n<summary>More</summary>\nBody\n</details>");
    expect(output).toContain("$$x^2$$");
  });
});
