/**
 * Durable, single-writer/single-reader handoff for one exact bounded review snapshot.
 *
 * The broker's wire protocol carries only `(session_id, prompt_id)` (see runtime.ts's
 * `BrokerRequest`), and the root helper (claude_code_session_reset.py) must feed the bounded
 * snapshot to the isolated worker's stdin without itself ever holding a Claude Code / TypeScript
 * runtime. This store is the file both sides agree on: `handleMemoryReviewCommand` (running
 * unprivileged, at Stop-hook time, where the untrusted-transcript-derived text is actually
 * available) builds and writes the already-bounded-and-redacted snapshot bytes here; root's
 * `memory_review_session()` opens the same file with the same directory-fd-anchored discipline
 * used everywhere else in that script and pipes the bytes straight to the worker's stdin,
 * without ever parsing or interpreting them.
 *
 * Filesystem discipline mirrors memory-review-receipt.ts exactly: a descriptor-anchored 0700
 * directory, 0600 single-link regular files, O_NOFOLLOW on every open, atomic
 * create/fsync/rename. A snapshot is retained until its receipt reaches a terminal, non-retryable
 * status so a retried review can still find it; cleanup of stale entries is out of scope for this
 * spike (see the PR report for this documented gap).
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
  fsyncSync,
  unlinkSync
} from "node:fs";
import { sha256Hex } from "@project-tharsis/claude-code-telegram-shared";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SNAPSHOT_KEY_RE = /^[0-9a-f]{64}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
export const MAX_MEMORY_REVIEW_SNAPSHOT_BYTES = 32 * 1024;

export function defaultMemoryReviewSnapshotDirectory(): string {
  return join(homedir(), ".local", "state", "claude-code-telegram-kit", "memory-review", "snapshots");
}

export function memoryReviewSnapshotKey(sessionId: string, promptId: string): string {
  return sha256Hex(`${sessionId} ${promptId}`);
}

export interface MemoryReviewSnapshotStoreOptions {
  directory?: string;
  expectedUid?: number;
}

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

// Identical directory-anchoring discipline to memory-review-receipt.ts's openDirectory: every
// path segment is opened through /proc/self/fd/<fd>/<segment> so a symlink swap mid-walk can
// never redirect a later segment outside the intended tree.
function openDirectory(path: string, expectedUid: number | undefined): number {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const child = `/proc/self/fd/${fd}/${part}`;
      let before;
      try {
        before = lstatSync(child);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(child, DIRECTORY_MODE);
        before = lstatSync(child);
      }
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error("snapshot directory is not a real directory");
      }
      const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = fstatSync(next);
      if (!opened.isDirectory() || opened.ino !== before.ino || opened.dev !== before.dev) {
        closeSync(next);
        throw new Error("snapshot directory changed during open");
      }
      closeSync(fd);
      fd = next;
    }
    const final = fstatSync(fd);
    if ((final.mode & 0o7777) !== DIRECTORY_MODE || (expectedUid !== undefined && final.uid !== expectedUid)) {
      throw new Error("snapshot directory validation failed");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function resolveDirectory(options: MemoryReviewSnapshotStoreOptions): { path: string; expectedUid: number | undefined } {
  return { path: resolve(options.directory ?? defaultMemoryReviewSnapshotDirectory()), expectedUid: options.expectedUid ?? uid() };
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("short snapshot write");
    offset += count;
  }
}

function keyFor(sessionId: string, promptId: string): string {
  if (!SESSION_UUID.test(sessionId)) throw new Error("invalid snapshot session_id");
  if (!PROMPT_ID_RE.test(promptId)) throw new Error("invalid snapshot prompt_id");
  const key = memoryReviewSnapshotKey(sessionId, promptId);
  if (!SNAPSHOT_KEY_RE.test(key)) throw new Error("invalid snapshot key");
  return key;
}

/**
 * Atomically writes the exact bytes serializeMemoryReviewSnapshot produced. Overwrites any
 * stale prior snapshot for the same (session_id, prompt_id) -- the receipt store's singleflight
 * already guarantees at most one *active* review per key, so a leftover snapshot here can only
 * be a stale one from a since-finalized receipt.
 */
export function writeMemoryReviewSnapshot(
  sessionId: string,
  promptId: string,
  bytes: Buffer,
  options: MemoryReviewSnapshotStoreOptions = {}
): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEMORY_REVIEW_SNAPSHOT_BYTES) {
    throw new Error("invalid snapshot payload size");
  }
  const key = keyFor(sessionId, promptId);
  const { path, expectedUid } = resolveDirectory(options);
  const dirfd = openDirectory(path, expectedUid);
  try {
    const anchored = `/proc/self/fd/${dirfd}`;
    const name = `${key}.json`;
    const tempName = `.${key}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const temp = join(anchored, tempName);
    const target = join(anchored, name);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
      throw error;
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    fsyncSync(dirfd);
  } finally {
    closeSync(dirfd);
  }
}

/** Secure read used only by tests to verify what writeMemoryReviewSnapshot actually persisted. */
export function readMemoryReviewSnapshot(
  sessionId: string,
  promptId: string,
  options: MemoryReviewSnapshotStoreOptions = {}
): Buffer | null {
  const key = keyFor(sessionId, promptId);
  const { path, expectedUid } = resolveDirectory(options);
  const dirfd = openDirectory(path, expectedUid);
  try {
    const name = `${key}.json`;
    const filePath = join(`/proc/self/fd/${dirfd}`, name);
    let before;
    try {
      before = lstatSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== FILE_MODE ||
        (expectedUid !== undefined && before.uid !== expectedUid) || before.size > MAX_MEMORY_REVIEW_SNAPSHOT_BYTES) {
      throw new Error("unsafe snapshot file");
    }
    const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
          (opened.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && opened.uid !== expectedUid) ||
          opened.size > MAX_MEMORY_REVIEW_SNAPSHOT_BYTES) {
        throw new Error("snapshot file changed during read");
      }
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (count <= 0) throw new Error("short snapshot read");
        offset += count;
      }
      return buffer;
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(dirfd);
  }
}
