function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render the wire-bounded internal progress model as Telegram-safe HTML. */
export function formatProgressHtml(text: string): string {
  if (text === "") return "";
  return text.split("\n").map((line, index) => {
    if (index === 0) return `<b>${escapeHtml(line)}</b>`;
    if (/^… \+\d+ more steps$/u.test(line)) return `<i>${escapeHtml(line)}</i>`;

    const step = /^(• (?:…|✓|✕) )(.+)$/u.exec(line);
    if (step === null) return escapeHtml(line);
    const prefix = step[1]!;
    const display = step[2]!;
    const separator = display.indexOf(" — ");
    if (separator === -1) return `${prefix}<b>${escapeHtml(display)}</b>`;

    const label = display.slice(0, separator);
    const preview = display.slice(separator + 3);
    return `${prefix}<b>${escapeHtml(label)}</b>\n<code>${escapeHtml(preview)}</code>`;
  }).join("\n");
}
