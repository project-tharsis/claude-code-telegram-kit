function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render the wire-bounded internal progress model as Telegram-safe HTML. */
export function formatProgressHtml(text: string): string {
  if (text === "") return "";
  const lines = text.split("\n");
  const rendered: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index === 0) {
      const marked = line === "Failed" ? line : line.endsWith("…") ? `✦ ${line}` : `✓ ${line}`;
      rendered.push(`<b>${escapeHtml(marked)}</b>`, "");
      continue;
    }
    if (/^… \+\d+ more steps$/u.test(line)) {
      rendered.push(`<i>${escapeHtml(line)}</i>`);
      continue;
    }
    if (line === "```shell" && index + 2 < lines.length && lines[index + 2] === "```") {
      rendered.push(`<pre><code class="language-shell">${escapeHtml(lines[index + 1]!)}</code></pre>`);
      index += 2;
      continue;
    }
    rendered.push(escapeHtml(line));
  }
  return rendered.join("\n");
}
