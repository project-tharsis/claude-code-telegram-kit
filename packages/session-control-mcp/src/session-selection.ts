import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The numbered list a user sees in Telegram is bound to exact session UUIDs here, in a
 * user-private file, and nowhere else. `/resume N` resolves N through this snapshot, so a
 * session UUID never has to be accepted from the model.
 */

export const SELECTION_TTL_MS = 10 * 60_000;
export const MAX_SELECTION_ENTRIES = 10;
/** Rejects snapshots stamped ahead of local time, which would otherwise bypass the TTL. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const SNAPSHOT_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SelectionEntry {
  index: number;
  sessionId: string;
}

export interface SelectionSnapshot {
  chatId: string;
  /** The session that produced the list, so a resume can refuse to target itself. */
  sessionId: string;
  createdAt: number;
  entries: SelectionEntry[];
}

export function defaultSelectionDirectory(): string {
  return process.env.CLAUDE_SESSION_SELECTION_DIR
    ?? join(homedir(), ".local", "state", "claude-code-telegram-kit", "session-selections");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** One snapshot per chat, named so a chat ID never appears in the filesystem. */
function snapshotName(chatId: string): string {
  return `${createHash("sha256").update(`selection:${chatId}`).digest("hex").slice(0, 32)}.json`;
}

function assertPrivateDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("selection directory must be a real directory");
  }
  if ((info.mode & 0o777) !== 0o700) throw new Error("selection directory must have mode 0700");
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error("selection directory must be owned by the sidecar user");
  }
}

function validateEntries(entries: readonly SelectionEntry[]): void {
  if (entries.length === 0 || entries.length > MAX_SELECTION_ENTRIES) {
    throw new Error("selection must contain 1 to 10 sessions");
  }
  entries.forEach((entry, offset) => {
    if (entry.index !== offset + 1) throw new Error("selection indices must be sequential from 1");
    if (typeof entry.sessionId !== "string" || !UUID.test(entry.sessionId)) {
      throw new Error("selection entries must be session UUIDs");
    }
  });
}

export function writeSelectionSnapshot(options: {
  directory: string;
  chatId: string;
  sessionId: string;
  entries: readonly SelectionEntry[];
  now?: () => number;
}): void {
  const now = options.now ?? Date.now;
  if (!/^-?\d+$/.test(options.chatId)) throw new Error("invalid chat ID");
  if (!UUID.test(options.sessionId)) throw new Error("invalid session UUID");
  validateEntries(options.entries);

  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(directory);

  const payload = `${JSON.stringify({
    version: SNAPSHOT_VERSION,
    chat_id: options.chatId,
    session_id: options.sessionId,
    created_at: now(),
    entries: options.entries.map(entry => ({ index: entry.index, session_id: entry.sessionId }))
  })}\n`;

  const target = join(directory, snapshotName(options.chatId));
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone; nothing further to clean up.
    }
    throw error;
  }
}

export function readSelectionSnapshot(options: {
  directory: string;
  chatId: string;
  now?: () => number;
}): SelectionSnapshot | null {
  const now = options.now ?? Date.now;
  try {
    const directory = resolve(options.directory);
    assertPrivateDirectory(directory);
    const path = join(directory, snapshotName(options.chatId));

    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    if (before.nlink !== 1) return null;
    if ((before.mode & 0o777) !== 0o600) return null;
    if (before.size > MAX_SNAPSHOT_BYTES) return null;
    const uid = currentUid();
    if (uid !== undefined && before.uid !== uid) return null;

    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) return null;
      if (opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600) return null;
      if (opened.size > MAX_SNAPSHOT_BYTES) return null;
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }

    const parsed = JSON.parse(raw) as {
      version?: unknown;
      chat_id?: unknown;
      session_id?: unknown;
      created_at?: unknown;
      entries?: unknown;
    };
    if (parsed.version !== SNAPSHOT_VERSION) return null;
    if (parsed.chat_id !== options.chatId) return null;
    if (typeof parsed.session_id !== "string" || !UUID.test(parsed.session_id)) return null;
    if (typeof parsed.created_at !== "number" || !Number.isFinite(parsed.created_at)) return null;
    if (parsed.created_at > now() + MAX_CLOCK_SKEW_MS) return null;
    if (now() - parsed.created_at >= SELECTION_TTL_MS) return null;
    if (!Array.isArray(parsed.entries)) return null;

    const entries: SelectionEntry[] = [];
    for (const raw of parsed.entries) {
      if (typeof raw !== "object" || raw === null) return null;
      const { index, session_id: sessionId } = raw as { index?: unknown; session_id?: unknown };
      if (typeof index !== "number" || typeof sessionId !== "string") return null;
      entries.push({ index, sessionId });
    }
    validateEntries(entries);

    return {
      chatId: parsed.chat_id,
      sessionId: parsed.session_id,
      createdAt: parsed.created_at,
      entries
    };
  } catch {
    return null;
  }
}

/** The only path from a user-visible index to an exact session UUID. */
export function resolveSelection(snapshot: SelectionSnapshot, index: number): string | null {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_SELECTION_ENTRIES) return null;
  return snapshot.entries.find(entry => entry.index === index)?.sessionId ?? null;
}
