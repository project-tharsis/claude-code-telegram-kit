import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";

interface PositionedNode {
  type: string;
  value?: string;
  children?: PositionedNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function emphasisIdentity(node: PositionedNode): string | null {
  if (node.type !== "strong" && node.type !== "emphasis") return null;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? `${node.type}:${start}:${end}` : null;
}

function collectEmphasis(node: PositionedNode, output: Set<string>): void {
  const identity = emphasisIdentity(node);
  if (identity !== null) output.add(identity);
  for (const child of node.children ?? []) collectEmphasis(child, output);
}

function spaceCjkOnlyEmphasis(node: PositionedNode, source: string, standard: ReadonlySet<string>): void {
  const children = node.children ?? [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const identity = emphasisIdentity(child);
    if (identity !== null && !standard.has(identity)) {
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      const previous = children[index - 1];
      if (typeof start === "number" && start > 0 && !/\s/u.test(source[start - 1] ?? "")) {
        if (previous?.type === "text" && typeof previous.value === "string") previous.value += " ";
        else {
          children.splice(index, 0, { type: "text", value: " " });
          index += 1;
        }
      }
      const following = children[index + 1];
      if (typeof end === "number" && end < source.length && !/\s/u.test(source[end] ?? "")) {
        if (following?.type === "text" && typeof following.value === "string") following.value = ` ${following.value}`;
        else children.splice(index + 1, 0, { type: "text", value: " " });
      }
    }
    spaceCjkOnlyEmphasis(child, source, standard);
  }
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
    const standardTree = fromMarkdown(content, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()]
    }) as PositionedNode;
    const standardEmphasis = new Set<string>();
    collectEmphasis(standardTree, standardEmphasis);
    const tree = fromMarkdown(content, {
      extensions: [cjkFriendlyExtension(), gfm()],
      mdastExtensions: [gfmFromMarkdown()]
    }) as PositionedNode;
    spaceCjkOnlyEmphasis(tree, content, standardEmphasis);
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
