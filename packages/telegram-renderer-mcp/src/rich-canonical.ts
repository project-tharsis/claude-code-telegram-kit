import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface PositionedNode {
  type: string;
  children?: PositionedNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function markTelegramUnderline(node: PositionedNode, source: string): void {
  if (node.type === "strong") {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (
      typeof start === "number"
      && typeof end === "number"
      && source.slice(start, start + 2) === "__"
      && source.slice(end - 2, end) === "__"
      && source[start - 1] !== "_"
      && source[end] !== "_"
    ) {
      node.type = "telegramUnderline";
    }
  }
  for (const child of node.children ?? []) markTelegramUnderline(child, source);
}

function telegramUnderline(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter("strong");
  const tracker = state.createTracker(info);
  const before = tracker.move("__");
  const between = tracker.move(state.containerPhrasing(node, {
    after: "_",
    before,
    ...tracker.current()
  }));
  const after = tracker.move("__");
  exit();
  return before + between + after;
}

/** Parse canonical GFM and serialize text delimiters safely for Telegram Rich Markdown. */
export function canonicalizeRichMarkdown(content: string): string | null {
  try {
    const tree = fromMarkdown(content, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()]
    }) as PositionedNode;
    markTelegramUnderline(tree, content);
    return toMarkdown(tree as any, {
      extensions: [gfmToMarkdown({
        stringLength: value => Math.max(3, Array.from(value).length)
      })],
      handlers: { telegramUnderline } as any
    }).trimEnd();
  } catch {
    return null;
  }
}
