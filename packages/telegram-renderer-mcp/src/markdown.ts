import telegramifyMarkdown from "telegramify-markdown";

export interface MarkdownChunk {
  raw: string;
  rendered: string;
}

export function toMarkdownV2(content: string): string {
  return telegramifyMarkdown(content, "escape").trimEnd();
}

function largestFittingPrefix(chars: string[], maxLength: number): number {
  let low = 1;
  let high = chars.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const rendered = toMarkdownV2(chars.slice(0, middle).join(""));
    if (rendered.length <= maxLength) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function preferNaturalBoundary(chars: string[], take: number): number {
  if (take >= chars.length) return take;
  const candidate = chars.slice(0, take).join("");
  const minimum = Math.floor(candidate.length * 0.5);
  for (const delimiter of ["\n\n", "\n", " "]) {
    const index = candidate.lastIndexOf(delimiter);
    if (index >= minimum) return Array.from(candidate.slice(0, index + delimiter.length)).length;
  }
  return take;
}

export function splitMarkdownV2(content: string, maxLength = 4_096): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let remaining = Array.from(content);

  while (remaining.length > 0) {
    const whole = remaining.join("");
    const renderedWhole = toMarkdownV2(whole);
    if (renderedWhole.length <= maxLength) {
      chunks.push({ raw: whole, rendered: renderedWhole });
      break;
    }

    let take = largestFittingPrefix(remaining, maxLength);
    if (take <= 0) throw new Error("unable to split Markdown within Telegram limit");
    take = preferNaturalBoundary(remaining, take);
    const raw = remaining.slice(0, take).join("");
    const rendered = toMarkdownV2(raw);
    if (rendered.length > maxLength) throw new Error("Markdown split exceeded Telegram limit");
    chunks.push({ raw, rendered });
    remaining = remaining.slice(take);
  }

  return chunks;
}
