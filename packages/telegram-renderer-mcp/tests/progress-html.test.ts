import { describe, expect, test } from "bun:test";
import { formatProgressHtml } from "../src/progress-html.js";

describe("Telegram progress HTML", () => {
  test("bolds the header and tool label while rendering the preview as a code block", () => {
    expect(formatProgressHtml("Working…\n• ✓ Run command — ls -la\n• … Read file"))
      .toBe("<b>Working…</b>\n• ✓ <b>Run command</b>\n<pre>ls -la</pre>\n• … <b>Read file</b>");
  });

  test("escapes every dynamic HTML character and keeps overflow quiet", () => {
    expect(formatProgressHtml("Failed\n• ✕ Run command — echo <x> && a&b\n… +2 more steps"))
      .toBe("<b>Failed</b>\n• ✕ <b>Run command</b>\n<pre>echo &lt;x&gt; &amp;&amp; a&amp;b</pre>\n<i>… +2 more steps</i>");
  });
});
