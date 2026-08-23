import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import telegramifyMarkdown from "telegramify-markdown";

interface PositionedNode {
  type?: string;
  children?: PositionedNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function escapedAt(source: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Protect literal range tildes without changing GFM `~~strikethrough~~` markers or code/link destinations. */
export function protectLiteralTildes(content: string): string {
  const tree = fromMarkdown(content, {
    extensions: [gfm({ singleTilde: false })],
    mdastExtensions: [gfmFromMarkdown()]
  }) as PositionedNode;
  const offsets: number[] = [];
  const visit = (node: PositionedNode): void => {
    if (node.type === "text") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start === "number" && typeof end === "number") {
        for (let offset = start; offset < end; offset += 1) {
          if (content[offset] === "~" && !escapedAt(content, offset)) offsets.push(offset);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  let protectedText = content;
  for (const offset of offsets.sort((a, b) => b - a)) {
    protectedText = `${protectedText.slice(0, offset)}\\${protectedText.slice(offset)}`;
  }
  return protectedText;
}

export function toMarkdownV2(content: string): string {
  return telegramifyMarkdown(protectLiteralTildes(content), "escape").trimEnd();
}
