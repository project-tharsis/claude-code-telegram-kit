import { describe, expect, test } from "bun:test";
import { formatProgressHtml } from "../src/progress-html.js";

describe("Telegram progress HTML", () => {
  test("keeps friendly emoji steps inline and renders only terminal commands as shell blocks", () => {
    expect(formatProgressHtml([
      "Tinkering…",
      "📖 Reading auth.ts L82-111",
      "💻 terminal",
      "```shell",
      "ls -la",
      "```",
      "📚 Reading skill requesting-code-review"
    ].join("\n"))).toBe([
      "<b>✦ Tinkering…</b>",
      "",
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
      "",
      "❌ 🔧 Editing &lt;x&gt;&amp;y",
      "💻 terminal",
      "<pre><code class=\"language-shell\">echo &lt;x&gt; &amp;&amp; a&amp;b</code></pre>",
      "<i>… +2 more steps</i>"
    ].join("\n"));
  });

  test("marks a completed whimsical verb and separates it from the steps", () => {
    expect(formatProgressHtml("Cogitated\n📖 Reading"))
      .toBe("<b>✓ Cogitated</b>\n\n📖 Reading");
  });

  test("marks background lifecycle headers as active and complete", () => {
    expect(formatProgressHtml("Background work · 1 running…\n👥 reviewer · Running"))
      .toStartWith("<b>✦ Background work · 1 running…</b>");
    expect(formatProgressHtml("Background work · Finalizing…\n✅ reviewer · Done"))
      .toStartWith("<b>✦ Background work · Finalizing…</b>");
    expect(formatProgressHtml("Background work · Done\n✅ reviewer · Done"))
      .toStartWith("<b>✓ Background work · Done</b>");
  });

  test("treats a command that equals a closing fence as content", () => {
    expect(formatProgressHtml("Tinkering…\n💻 terminal\n```shell\n```\n```"))
      .toContain("<pre><code class=\"language-shell\">```</code></pre>");
  });
});
