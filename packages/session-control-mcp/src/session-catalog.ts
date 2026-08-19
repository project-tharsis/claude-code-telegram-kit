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
const UNTITLED = "Untitled session";

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

function sanitizeTitle(raw: string): string {
  const collapsed = Array.from(raw)
    .map(character => (character.codePointAt(0)! < 0x20 || character.codePointAt(0) === 0x7f ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return UNTITLED;
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
  let title: string | null = null;
  let belongsToSession = false;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // Malformed and truncated lines are expected and simply skipped.
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as { type?: unknown; aiTitle?: unknown; sessionId?: unknown };
    if (typed.sessionId === sessionId) belongsToSession = true;
    if (typed.type === "custom-title" && typeof (typed as { customTitle?: unknown }).customTitle === "string") {
      title = (typed as { customTitle: string }).customTitle;
    } else if (typed.type === "ai-title" && typeof typed.aiTitle === "string") {
      title = typed.aiTitle;
    }
  }
  return { title: title === null ? UNTITLED : sanitizeTitle(title), belongsToSession };
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

/**
 * Revalidates a selected session immediately before a resume is scheduled. The snapshot proved
 * the user chose this UUID; this proves the file behind it is still a plain, owned transcript
 * belonging to this workspace, and not something swapped in since the list was rendered.
 */
export function assertUsableSessionTranscript(options: {
  directory: string;
  sessionId: string;
  expectedUid?: number;
  maxFileBytes?: number;
  tailBytes?: number;
}): void {
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
  let parsed: ParsedTranscript;
  try {
    parsed = parseTranscript(
      readHeadAndTail(opened.fd, opened.size, options.tailBytes ?? DEFAULT_TAIL_BYTES),
      options.sessionId
    );
  } finally {
    closeSync(opened.fd);
  }
  if (!parsed.belongsToSession) throw new Error("selected session transcript belongs to another session");
}
