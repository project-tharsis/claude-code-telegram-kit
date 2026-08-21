import { describe, expect, test } from "bun:test";
import { formatProgressHtml } from "../src/progress-html.js";

describe("Telegram progress HTML", () => {
  test("keeps friendly emoji steps inline and renders only terminal commands as shell blocks", () => {
    expect(formatProgressHtml([
      "Working…",
      "📖 Reading auth.ts L82-111",
      "💻 terminal",
      "```shell",
      "ls -la",
      "```",
      "📚 Reading skill requesting-code-review"
    ].join("\n"))).toBe([
      "<b>Working…</b>",
      "📖 Reading auth.ts L82-111",
      "💻 terminal",
      "<pre><code class=\"language-shell\">ls -la</code></pre>",
      "📚 Reading skill requesting-code-review"
    ].join("\n"));
  });

  test("escapes inline and command text while keeping overflow quiet", () => {
    expect(formatProgressHtml([
      "Failed",
      "❌ 🔧 Editing <x>&y",
      "💻 terminal",
      "```shell",
      "echo <x> && a&b",
      "```",
      "… +2 more steps"
    ].join("\n"))).toBe([
      "<b>Failed</b>",
      "❌ 🔧 Editing &lt;x&gt;&amp;y",
      "💻 terminal",
      "<pre><code class=\"language-shell\">echo &lt;x&gt; &amp;&amp; a&amp;b</code></pre>",
      "<i>… +2 more steps</i>"
    ].join("\n"));
  });

  test("treats a command that equals a closing fence as content", () => {
    expect(formatProgressHtml("Working…\n💻 terminal\n```shell\n```\n```"))
      .toContain("<pre><code class=\"language-shell\">```</code></pre>");
  });
});
