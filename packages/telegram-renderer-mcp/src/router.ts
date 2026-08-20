import { canonicalizeRichMarkdown } from "./rich-canonical.js";

const RICH_MESSAGE_MAX_CHARS = 32_768;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const TASK_LIST = /^\s*[-*]\s+\[[ xX]\]\s+/m;
const DETAILS = /^\s*<\/?(?:details|summary)\b/mi;

function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function needsRichRendering(content: string): boolean {
  if (!content.trim() || codePointLength(content) > RICH_MESSAGE_MAX_CHARS) return false;
  const lines = content.split("\n");
  if (lines.some((line, index) =>
    index > 0 && TABLE_DELIMITER.test(line) && lines[index - 1]!.includes("|")
  )) return true;
  if (TASK_LIST.test(content)) return true;
  if (DETAILS.test(content)) return true;
  return content.includes("$$");
}

function protectedLines(lines: string[]): boolean[] {
  const protectedLine = lines.map(() => false);
  let inFence = false;
  let fenceMarker = "";

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trimStart();
    const match = trimmed.match(/^(```+|~~~+)/);
    const wasInFence = inFence;
    if (!wasInFence && match) {
      inFence = true;
      fenceMarker = match[1]![0]!;
    }
    if (inFence) protectedLine[index] = true;
    if (wasInFence && match && match[1]![0] === fenceMarker && trimmed.slice(match[1]!.length).trim() === "") {
      inFence = false;
      fenceMarker = "";
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!TABLE_DELIMITER.test(lines[index]!)) continue;
    if (index > 0 && lines[index - 1]!.includes("|")) protectedLine[index - 1] = true;
    protectedLine[index] = true;
    for (let row = index + 1; row < lines.length && lines[row]!.includes("|") && lines[row]!.trim(); row += 1) {
      protectedLine[row] = true;
    }
  }

  return protectedLine;
}

export function normalizeRichMarkdown(content: string): string | null {
  const canonical = canonicalizeRichMarkdown(content);
  if (canonical === null) return null;
  const lines = canonical.split("\n");
  const protectedLine = protectedLines(lines);
  let output = "";

  for (let index = 0; index < lines.length; index += 1) {
    output += lines[index];
    if (index === lines.length - 1) break;
    const current = lines[index]!;
    const next = lines[index + 1]!;
    const hardBreak = current.length > 0
      && next.length > 0
      && !protectedLine[index]
      && !protectedLine[index + 1];
    output += hardBreak ? "  \n" : "\n";
  }

  return codePointLength(output) <= RICH_MESSAGE_MAX_CHARS ? output : null;
}
