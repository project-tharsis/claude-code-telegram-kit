import telegramifyMarkdown from "telegramify-markdown";

export function toMarkdownV2(content: string): string {
  return telegramifyMarkdown(content, "escape").trimEnd();
}
