import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BindTurnInput } from "./hook-contract.js";

const MAX_APPEND_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 64;
const MAX_TEXT = 2_000;

export interface CommentaryBlock { key: string; text: string; }
export interface CommentaryTracker {
  collectBeforeTool(toolUseId: string): CommentaryBlock[];
  reserve(key: string): void;
  close(): void;
}
interface Identity { dev: number; ino: number; uid: number; }
function trusted(s: Stats, uid: number): boolean {
  return s.isFile() && !s.isSymbolicLink() && s.uid === uid && s.nlink === 1 && (s.mode & 0o022) === 0;
}
function same(i: Identity, s: Stats): boolean { return i.dev === s.dev && i.ino === s.ino && i.uid === s.uid; }

function parseRows(buffer: Buffer, sessionId: string, base: number, toolUseId: string): CommentaryBlock[] {
  const blocks: CommentaryBlock[] = [];
  let rowStart = 0;
  while (rowStart < buffer.length) {
    const newline = buffer.indexOf(10, rowStart);
    if (newline < 0) break;
    const line = buffer.subarray(rowStart, newline);
    const absolute = base + rowStart;
    rowStart = newline + 1;
    if (line.length === 0) continue;
    try {
      const row = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
      const message = row.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (row.type !== "assistant" || message?.role !== "assistant" || !Array.isArray(content)) continue;
      for (let index = 0; index < content.length; index += 1) {
        const item = content[index];
        if (typeof item !== "object" || item === null) continue;
        const value = item as Record<string, unknown>;
        if (value.type === "tool_use" && value.id === toolUseId) return blocks;
        if (value.type !== "text" || typeof value.text !== "string" || blocks.length >= MAX_BLOCKS) continue;
        const text = Array.from(value.text.trim()).slice(0, MAX_TEXT).join("");
        if (text) blocks.push({ key: `${sessionId}:${absolute}:${index}`, text });
      }
    } catch { /* malformed rows fail closed */ }
  }
  return blocks;
}

export function startCommentaryTranscriptTracker(input: BindTurnInput, options: { expectedRoot: string; uid?: number }): CommentaryTracker | null {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || input.transcript_path === undefined || !isAbsolute(options.expectedRoot) || !isAbsolute(input.transcript_path)) return null;
  if (input.transcript_path !== join(options.expectedRoot, `${input.session_id}.jsonl`)) return null;
  let fd: number | undefined;
  try {
    const root = lstatSync(options.expectedRoot);
    const before = lstatSync(input.transcript_path);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== uid || (root.mode & 0o022) !== 0 || realpathSync.native(options.expectedRoot) !== options.expectedRoot || !trusted(before, uid)) return null;
    fd = openSync(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!trusted(opened, uid) || opened.dev !== before.dev || opened.ino !== before.ino) { closeSync(fd); return null; }
    const identity: Identity = { dev: opened.dev, ino: opened.ino, uid: opened.uid };
    const offset = opened.size;
    const reserved = new Set<string>();
    let closed = false;
    const close = () => { if (closed) return; closed = true; if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; } };
    return {
      close,
      reserve: (key: string) => { reserved.add(key); },
      collectBeforeTool: (toolUseId: string) => {
        if (closed || fd === undefined || !/^[A-Za-z0-9_.:-]{1,128}$/.test(toolUseId)) return [];
        try {
          const current = fstatSync(fd);
          if (!trusted(current, uid) || !same(identity, current) || current.size < offset || current.size - offset > MAX_APPEND_BYTES) return [];
          const bytes = Buffer.alloc(current.size - offset);
          let read = 0;
          while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, offset + read); if (n <= 0) return []; read += n; }
          const after = fstatSync(fd);
          if (!trusted(after, uid) || !same(identity, after) || after.size !== current.size) return [];
          return parseRows(bytes, input.session_id, offset, toolUseId).filter(block => !reserved.has(block.key));
        } catch { return []; }
      }
    };
  } catch { if (fd !== undefined) { try { closeSync(fd); } catch {} } return null; }
}
