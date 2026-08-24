import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { join, resolve } from "node:path";
import {
  parseTerminalTaskNotification,
  parseDirectTelegramEnvelope
} from "@project-tharsis/claude-code-telegram-shared";
import { parseControlCommand } from "./control-command.js";

/**
 * Reads the configured Claude Code project sessions directory and nothing else. The directory
 * is fixed server configuration; no path ever comes from the model. Every bound below exists so
 * a hostile or merely enormous transcript directory cannot stall or exhaust the control MCP.
 */

export const MAX_LISTED_SESSIONS = 10;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 1_000;
/** Above this a transcript is treated as unlistable rather than partially parsed. */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Only the tail is parsed: the freshest title and session marker are always at the end. */
const DEFAULT_TAIL_BYTES = 256 * 1024;
/** Parsing is the expensive step, so it runs only on the newest candidates. */
const DEFAULT_MAX_PARSED_FILES = 24;
const DEFAULT_MAX_SCAN_MS = 2_000;
const MAX_TITLE_CHARS = 60;
const TASK_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_TASK_SCAN_LINE_BYTES = 1024 * 1024;
const MAX_TRACKED_BACKGROUND_TASKS = 256;
const CONVERSATION_FALLBACK = "Conversation with Claudio";
const CONTROL_ONLY_FALLBACK = "Control-only session";

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/;

/** Title and coarse activity only. No transcript body, no path, no prompt. */
export interface SessionCatalogEntry {
  sessionId: string;
  title: string;
  lastActivityMs: number;
}

export interface SessionCatalogOptions {
  directory: string;
  currentSessionId?: string;
  expectedUid?: number;
  maxDirectoryEntries?: number;
  maxFileBytes?: number;
  tailBytes?: number;
  maxParsedFiles?: number;
  maxScanMs?: number;
  now?: () => number;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function sanitizeTitle(raw: string, fallback: string): string {
  const collapsed = Array.from(raw)
    .map(character => (character.codePointAt(0)! < 0x20 || character.codePointAt(0) === 0x7f ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return fallback;
  const characters = Array.from(collapsed);
  if (characters.length <= MAX_TITLE_CHARS) return collapsed;
  return `${characters.slice(0, MAX_TITLE_CHARS).join("")}…`;
}

/** Reads at most `tailBytes` from the end of an already validated descriptor. */
function readTail(fd: number, size: number, tailBytes: number): string {
  const length = Math.min(size, tailBytes);
  const offset = size - length;
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, offset + filled);
    if (read <= 0) break;
    filled += read;
  }
  const text = buffer.subarray(0, filled).toString("utf8");
  // A tail read can start mid-line; drop that fragment instead of misparsing it.
  return offset > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

/**
 * Titles are usually written near the start of a Claude transcript while the newest session
 * marker is at the end. Reading both bounded windows preserves titles without ever loading a
 * large transcript into memory. Tail records come last so a later title still wins.
 */
function readHeadAndTail(fd: number, size: number, windowBytes: number): string {
  const headLength = Math.min(size, windowBytes);
  const head = Buffer.allocUnsafe(headLength);
  let filled = 0;
  while (filled < headLength) {
    const read = readSync(fd, head, filled, headLength - filled, filled);
    if (read <= 0) break;
    filled += read;
  }
  const headText = head.subarray(0, filled).toString("utf8");
  if (size <= windowBytes) return headText;
  return `${headText}\n${readTail(fd, size, windowBytes)}`;
}

interface ParsedTranscript {
  title: string;
  belongsToSession: boolean;
}

function parseTranscript(text: string, sessionId: string): ParsedTranscript {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let belongsToSession = false;
  let hasConcreteAssistant = false;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // Malformed and truncated lines are expected and simply skipped.
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as {
      type?: unknown;
      aiTitle?: unknown;
      sessionId?: unknown;
      message?: { model?: unknown };
    };
    if (typed.sessionId === sessionId) belongsToSession = true;
    if (
      typed.type === "assistant"
      && typeof typed.message?.model === "string"
      && !typed.message.model.startsWith("<")
    ) hasConcreteAssistant = true;
    if (typed.type === "custom-title" && typeof (typed as { customTitle?: unknown }).customTitle === "string") {
      customTitle = (typed as { customTitle: string }).customTitle;
    } else if (typed.type === "ai-title" && typeof typed.aiTitle === "string") {
      aiTitle = typed.aiTitle;
    }
  }
  const fallback = hasConcreteAssistant ? CONVERSATION_FALLBACK : CONTROL_ONLY_FALLBACK;
  const title = customTitle ?? aiTitle;
  return { title: title === null ? fallback : sanitizeTitle(title, fallback), belongsToSession };
}

function openValidatedTranscript(
  path: string,
  expectedUid: number | undefined,
  maxFileBytes: number
): { fd: number; size: number } | null {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    return null;
  }
  if (!before.isFile() || before.isSymbolicLink()) return null;
  if (before.nlink !== 1 || (before.mode & 0o022) !== 0) return null;
  if (before.size === 0 || before.size > maxFileBytes) return null;
  if (expectedUid !== undefined && before.uid !== expectedUid) return null;

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  const opened = fstatSync(fd);
  if (
    !opened.isFile()
    || opened.dev !== before.dev
    || opened.ino !== before.ino
    || opened.size === 0
    || opened.size > maxFileBytes
    || opened.nlink !== 1
    || (opened.mode & 0o022) !== 0
    || (expectedUid !== undefined && opened.uid !== expectedUid)
  ) {
    closeSync(fd);
    return null;
  }
  return { fd, size: opened.size };
}

export function scanResumableSessions(options: SessionCatalogOptions): SessionCatalogEntry[] {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxScanMs ?? DEFAULT_MAX_SCAN_MS);
  const expectedUid = options.expectedUid ?? currentUid();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;

  const directory = resolve(options.directory);
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    if (realpathSync(directory) !== directory) return [];
  } catch {
    return [];
  }

  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const candidates: Array<{ sessionId: string; path: string; lastActivityMs: number }> = [];
  const entryBudget = options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES;
  for (const name of names.slice(0, entryBudget)) {
    const match = SESSION_FILE.exec(name);
    if (match === null) continue;
    const sessionId = match[1]!;
    if (sessionId === options.currentSessionId) continue;
    const path = join(directory, name);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.nlink !== 1 || (info.mode & 0o022) !== 0) continue;
    if (info.size === 0 || info.size > maxFileBytes) continue;
    if (expectedUid !== undefined && info.uid !== expectedUid) continue;
    candidates.push({ sessionId, path, lastActivityMs: info.mtimeMs });
  }

  candidates.sort((left, right) => right.lastActivityMs - left.lastActivityMs);

  const entries: SessionCatalogEntry[] = [];
  const parseBudget = options.maxParsedFiles ?? DEFAULT_MAX_PARSED_FILES;
  for (const candidate of candidates.slice(0, parseBudget)) {
    if (entries.length >= MAX_LISTED_SESSIONS || now() > deadline) break;
    const opened = openValidatedTranscript(candidate.path, expectedUid, maxFileBytes);
    if (opened === null) continue;
    let parsed: ParsedTranscript;
    try {
      parsed = parseTranscript(readHeadAndTail(opened.fd, opened.size, tailBytes), candidate.sessionId);
    } catch {
      continue;
    } finally {
      closeSync(opened.fd);
    }
    // A transcript whose records name a different session is corrupt or misplaced.
    if (!parsed.belongsToSession) continue;
    entries.push({
      sessionId: candidate.sessionId,
      title: parsed.title,
      lastActivityMs: candidate.lastActivityMs
    });
  }
  return entries;
}

/** Coarse, bounded, and never more precise than the minute. */
export function formatActivity(lastActivityMs: number, nowMs: number): string {
  const elapsed = nowMs - lastActivityMs;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(lastActivityMs).toISOString().slice(0, 10);
}

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface UsableTranscriptOptions {
  directory: string;
  sessionId: string;
  expectedUid?: number;
  maxFileBytes?: number;
  tailBytes?: number;
}

function readUsableSessionTranscript(options: UsableTranscriptOptions): string {
  if (typeof options.sessionId !== "string" || !UUID_ONLY.test(options.sessionId)) {
    throw new Error("invalid session UUID");
  }
  const expectedUid = options.expectedUid ?? currentUid();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const directory = resolve(options.directory);
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("configured sessions directory is not a real directory");
  }
  if (realpathSync(directory) !== directory) {
    throw new Error("configured sessions directory must not traverse symlinks");
  }
  const path = join(directory, `${options.sessionId}.jsonl`);
  const opened = openValidatedTranscript(path, expectedUid, maxFileBytes);
  if (opened === null) throw new Error("selected session transcript is not usable");
  try {
    const text = readHeadAndTail(opened.fd, opened.size, options.tailBytes ?? DEFAULT_TAIL_BYTES);
    if (!parseTranscript(text, options.sessionId).belongsToSession) {
      throw new Error("selected session transcript belongs to another session");
    }
    return text;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Revalidates a selected session immediately before a resume is scheduled. The snapshot proved
 * the user chose this UUID; this proves the file behind it is still a plain, owned transcript
 * belonging to this workspace, and not something swapped in since the list was rendered.
 */
export function assertUsableSessionTranscript(options: UsableTranscriptOptions): void {
  readUsableSessionTranscript(options);
}

/** Read the latest concrete assistant model from one already-authorized session transcript. */
export function readLatestSessionModel(options: {
  directory: string;
  sessionId: string;
  expectedUid?: number;
}): string | null {
  const text = readUsableSessionTranscript({ ...options, tailBytes: 512 * 1024 });
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { type?: unknown; message?: { model?: unknown } };
      const model = row.type === "assistant" ? row.message?.model : undefined;
      if (
        typeof model === "string"
        && model.length >= 1
        && model.length <= 128
        && !model.startsWith("<")
      ) return model;
    } catch {
      // Tail chunks can start on a partial JSONL row.
    }
  }
  return null;
}

export interface SessionTitleContext {
  customTitle: string | null;
  aiTitle: string | null;
  chatId: string | null;
  chatMessageId?: string | null;
  userPrompt: string | null;
  assistantText: string;
  toolNames: string[];
  hasIncompleteForkedTask?: boolean;
}

function contentBlocks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null
  );
}

function updateBackgroundTaskState(row: Record<string, unknown>, taskIds: Set<string>): boolean {
  if (row.type !== "user") return false;
  const message = typeof row.message === "object" && row.message !== null
    ? row.message as Record<string, unknown> : null;
  if (message === null) return false;
  const result = typeof row.toolUseResult === "object" && row.toolUseResult !== null
    ? row.toolUseResult as Record<string, unknown> : null;
  if (result?.status === "forked") {
    for (const block of contentBlocks(message.content)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (taskIds.size >= MAX_TRACKED_BACKGROUND_TASKS && !taskIds.has(block.tool_use_id)) return true;
      taskIds.add(block.tool_use_id);
    }
  }
  const values = typeof message.content === "string" ? [message.content] : contentBlocks(message.content)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string);
  for (const value of values) {
    const notification = parseTerminalTaskNotification(value);
    if (notification !== null) taskIds.delete(notification.toolUseId);
  }
  return false;
}

function boundedText(value: string, maxChars: number): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim())
    .slice(0, maxChars)
    .join("");
}

function scanIncompleteBackgroundTasks(options: {
  directory: string;
  sessionId: string;
  expectedUid?: number;
}): boolean {
  const opened = openValidatedTranscript(
    join(resolve(options.directory), `${options.sessionId}.jsonl`),
    options.expectedUid ?? currentUid(),
    DEFAULT_MAX_FILE_BYTES
  );
  if (opened === null) return true;
  const taskIds = new Set<string>();
  let overflow = false;
  let pending = Buffer.alloc(0);
  let skipOversizedLine = false;
  const consume = (line: Buffer) => {
    if (line.length === 0 || line.length > MAX_TASK_SCAN_LINE_BYTES) return;
    try {
      const row = JSON.parse(line.toString("utf8")) as unknown;
      if (typeof row === "object" && row !== null && updateBackgroundTaskState(row as Record<string, unknown>, taskIds)) {
        overflow = true;
      }
    } catch { /* malformed transcript rows are ignored */ }
  };
  try {
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(TASK_SCAN_CHUNK_BYTES, opened.size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const count = readSync(opened.fd, chunk, 0, length, offset);
      if (count <= 0) break;
      offset += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (skipOversizedLine) skipOversizedLine = false;
        else consume(line);
      }
      if (pending.length > MAX_TASK_SCAN_LINE_BYTES) {
        pending = Buffer.alloc(0);
        skipOversizedLine = true;
      }
    }
    if (!skipOversizedLine) consume(pending);
    return overflow || taskIds.size > 0;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Reads only bounded semantic context needed for one session-title suggestion. Never returns
 * tool inputs, tool outputs, transcript paths, or session identifiers.
 */
export function readSessionTitleContext(options: {
  directory: string;
  sessionId: string;
  expectedUid?: number;
}): SessionTitleContext {
  const text = readUsableSessionTranscript({ ...options, tailBytes: 512 * 1024 });
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let chatId: string | null = null;
  let chatMessageId: string | null = null;
  let userPrompt: string | null = null;
  let assistantText = "";
  const toolNames: string[] = [];

  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (row.type === "custom-title" && typeof row.customTitle === "string") {
      customTitle = row.customTitle.trim() || null;
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") {
      aiTitle = row.aiTitle.trim() || null;
      continue;
    }

    const message = typeof row.message === "object" && row.message !== null
      ? row.message as Record<string, unknown>
      : null;
    if (message === null) continue;

    if (row.type === "user" && userPrompt === null) {
      const candidates = typeof message.content === "string"
        ? [message.content]
        : contentBlocks(message.content)
          .filter(block => block.type === "text" && typeof block.text === "string")
          .map(block => block.text as string);
      for (const candidate of candidates) {
        const envelope = parseDirectTelegramEnvelope(candidate);
        if (envelope === null || parseControlCommand(envelope.body).kind !== "other") continue;
        const prompt = boundedText(envelope.body, 1_200);
        if (prompt) {
          chatId = envelope.chatId;
          chatMessageId = envelope.messageId;
          userPrompt = prompt;
          break;
        }
      }
      continue;
    }

    if (
      row.type === "assistant"
      && userPrompt !== null
      && typeof message.model === "string"
      && !message.model.startsWith("<")
    ) {
      for (const block of contentBlocks(message.content)) {
        if (block.type === "text" && typeof block.text === "string" && assistantText.length < 1_200) {
          assistantText = boundedText(`${assistantText} ${block.text}`, 1_200);
        } else if (
          block.type === "tool_use"
          && typeof block.name === "string"
          && toolNames.length < 5
          && !toolNames.includes(block.name)
        ) {
          toolNames.push(boundedText(block.name, 40));
        }
      }
    }
  }

  return {
    customTitle,
    aiTitle,
    chatId,
    chatMessageId,
    userPrompt,
    assistantText,
    toolNames,
    hasIncompleteForkedTask: scanIncompleteBackgroundTasks(options)
  };
}
