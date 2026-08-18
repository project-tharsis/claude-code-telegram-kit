const RICH_MESSAGE_MAX_CHARS = 32_768;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TASK_LIST = /^\s*[-*]\s+\[[ xX]\]\s+/m;
const DETAILS = /^\s*<\/?(?:details|summary)\b/mi;

function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function needsRichRendering(content: string): boolean {
  if (!content.trim() || codePointLength(content) > RICH_MESSAGE_MAX_CHARS) return false;
  if (content.split("\n").some(line => TABLE_DELIMITER.test(line))) return true;
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
    if (!inFence && match) {
      inFence = true;
      fenceMarker = match[1]![0]!;
    }
    if (inFence) protectedLine[index] = true;
    if (inFence && match && match[1]![0] === fenceMarker && trimmed.slice(match[1]!.length).trim() === "") {
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

export function normalizeRichMarkdown(content: string): string {
  const lines = content.split("\n");
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

  return output;
}
