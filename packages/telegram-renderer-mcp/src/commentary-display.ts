import type { MessageDisplayInput } from "./hook-contract.js";

export interface CommentaryBlock {
  key: string;
  text: string;
}

export interface CommentaryBuffer {
  add(input: MessageDisplayInput): void;
  collectBeforeTool(toolUseId: string): CommentaryBlock[];
  reserve(key: string): void;
  close(): void;
}

const MAX_MESSAGES = 16;
const MAX_DELTAS_PER_MESSAGE = 128;
const MAX_MESSAGE_CHARS = 8_000;

interface MessageBuffer {
  readonly messageId: string;
  readonly chunks: string[];
  complete: boolean;
  totalChars: number;
}

/** In-memory display-only capture. It never reads or writes Claude's JSONL transcript. */
export function createCommentaryDisplayBuffer(sessionId: string): CommentaryBuffer {
  const messages = new Map<string, MessageBuffer>();
  const rejected = new Set<string>();
  const reserved = new Set<string>();
  let activeTurnId: string | null = null;
  let closed = false;

  return {
    add(input): void {
      if (closed || input.session_id !== sessionId) return;
      if (activeTurnId === null) activeTurnId = input.turn_id;
      if (input.turn_id !== activeTurnId || rejected.has(input.message_id)) return;

      let message = messages.get(input.message_id);
      if (message === undefined) {
        if (messages.size >= MAX_MESSAGES || input.index !== 0) {
          rejected.add(input.message_id);
          return;
        }
        message = { messageId: input.message_id, chunks: [], complete: false, totalChars: 0 };
        messages.set(input.message_id, message);
      }

      if (message.complete) return;
      if (input.index < message.chunks.length) return; // replayed batch
      if (input.index !== message.chunks.length || input.index >= MAX_DELTAS_PER_MESSAGE) {
        messages.delete(input.message_id);
        rejected.add(input.message_id);
        return;
      }
      if (message.totalChars + input.delta.length > MAX_MESSAGE_CHARS) {
        messages.delete(input.message_id);
        rejected.add(input.message_id);
        return;
      }

      message.chunks.push(input.delta);
      message.totalChars += input.delta.length;
      if (input.final) message.complete = true;
    },

    collectBeforeTool(_toolUseId): CommentaryBlock[] {
      if (closed || activeTurnId === null) return [];
      const blocks: CommentaryBlock[] = [];
      for (const message of messages.values()) {
        if (!message.complete) continue;
        const key = `${sessionId}:${activeTurnId}:${message.messageId}`;
        if (reserved.has(key)) continue;
        const text = message.chunks.join("").trim();
        if (text) blocks.push({ key, text });
      }
      return blocks;
    },

    reserve(key): void {
      reserved.add(key);
    },

    close(): void {
      closed = true;
      messages.clear();
      rejected.clear();
      reserved.clear();
      activeTurnId = null;
    }
  };
}
