/**
 * Durable Memory Harness review receipt store (handoff doc section A2).
 *
 * A receipt binds review authority to one exact verified Telegram turn. It never holds a
 * transcript body, tool output, chat text, or credential. It is the single source of truth
 * for "has this (session_id, prompt_id) already been queued for review" (singleflight) and
 * for the eventual queued -> reviewed | failed status transition performed by the isolated
 * worker.
 *
 * Filesystem discipline mirrors the session-title state store: a descriptor-anchored 0700
 * directory, 0600 single-link regular files, O_NOFOLLOW on every open, and atomic
 * create/fsync/rename/readback. Nothing here ever touches Claude Code's native memory tree.
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createHash as nodeCreateHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openDirectoryFd } from "./fs-safety.js";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PROMPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const RECEIPT_KEY_RE = /^[0-9a-f]{64}$/;
const STATUSES = ["queued", "reviewed", "failed"] as const;
export type MemoryReviewReceiptStatus = (typeof STATUSES)[number];

export const MEMORY_REVIEW_RECEIPT_SCHEMA_VERSION = 3;
export const MEMORY_REVIEW_MAX_ATTEMPTS = 2;
export const MEMORY_REVIEW_FAILURE_PHASES = ["generate", "parse", "snapshot", "proposal_store", "receipt_transition", "review_claim", "worker"] as const;
export type MemoryReviewFailurePhase = (typeof MEMORY_REVIEW_FAILURE_PHASES)[number];
export const MEMORY_REVIEW_FAILURE_REASONS = ["timeout", "rate_limited", "command_failed", "invalid_output", "binding_mismatch", "unavailable", "busy", "invalid_record"] as const;
export type MemoryReviewFailureReason = (typeof MEMORY_REVIEW_FAILURE_REASONS)[number];
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BYTES = 8 * 1024;
export const MEMORY_REVIEW_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MEMORY_REVIEW_RECEIPT_MAX_ENTRIES = 2_048;

export interface MemoryReviewReceipt {
  schema: 3;
  session_id: string;
  prompt_id: string;
  last_assistant_message_sha256: string;
  snapshot_sha256: string;
  transcript_path: string;
  telegram_message_id: number;
  release_sha: string;
  tool_iterations: number;
  created_at: number;
  status: MemoryReviewReceiptStatus;
  attempts: number;
  failure_phase?: MemoryReviewFailurePhase;
  failure_reason?: MemoryReviewFailureReason;
}

export function defaultMemoryReviewReceiptDirectory(): string {
  return join(homedir(), ".local", "state", "claude-code-telegram-kit", "memory-review", "receipts");
}

// The NUL separator between sessionId and promptId (a UUID and a bounded charset-restricted
// string, respectively) is a deliberate hash-collision guard: without an unambiguous separator,
// two distinct (session_id, prompt_id) pairs could concatenate to the same string. It is written
// as the \x00 escape sequence rather than a literal embedded byte so this file stays plain text
// to git diff, grep, and other NUL-naive tooling.
export function memoryReviewReceiptKey(sessionId: string, promptId: string): string {
  return nodeCreateHash("sha256").update(`${sessionId}\x00${promptId}`).digest("hex");
}

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function openDirectory(path: string, expectedUid: number | undefined): number {
  return openDirectoryFd(path, expectedUid, DIRECTORY_MODE, "receipt directory");
}

export interface MemoryReviewReceiptStoreOptions {
  directory?: string;
  expectedUid?: number;
  /** Overrides MEMORY_REVIEW_RECEIPT_MAX_ENTRIES; used only by tests exercising the cap. */
  maxEntries?: number;
}

function resolveDirectory(options: MemoryReviewReceiptStoreOptions): { path: string; expectedUid: number | undefined } {
  return { path: resolve(options.directory ?? defaultMemoryReviewReceiptDirectory()), expectedUid: options.expectedUid ?? uid() };
}

function withDirectory<T>(options: MemoryReviewReceiptStoreOptions, action: (dirfd: number, expectedUid: number | undefined) => T): T {
  const { path, expectedUid } = resolveDirectory(options);
  const dirfd = openDirectory(path, expectedUid);
  try {
    return action(dirfd, expectedUid);
  } finally {
    closeSync(dirfd);
  }
}

function assertBounds(receipt: Omit<MemoryReviewReceipt, "schema" | "status">): void {
  if (!SESSION_UUID.test(receipt.session_id)) throw new Error("invalid receipt session_id");
  if (!PROMPT_ID_RE.test(receipt.prompt_id)) throw new Error("invalid receipt prompt_id");
  if (!SHA256_RE.test(receipt.last_assistant_message_sha256)) throw new Error("invalid receipt digest");
  if (!SHA256_RE.test(receipt.snapshot_sha256)) throw new Error("invalid receipt snapshot digest");
  if (typeof receipt.transcript_path !== "string" || !receipt.transcript_path.startsWith("/") || receipt.transcript_path.length > 4_096) {
    throw new Error("invalid receipt transcript_path");
  }
  if (!Number.isSafeInteger(receipt.telegram_message_id) || receipt.telegram_message_id < 1) {
    throw new Error("invalid receipt telegram_message_id");
  }
  if (!RELEASE_SHA_RE.test(receipt.release_sha)) throw new Error("invalid receipt release_sha");
  if (!Number.isSafeInteger(receipt.tool_iterations) || receipt.tool_iterations < 0 || receipt.tool_iterations > 10_000) {
    throw new Error("invalid receipt tool_iterations");
  }
  if (!Number.isSafeInteger(receipt.created_at) || receipt.created_at < 0) throw new Error("invalid receipt created_at");
}

export function validateMemoryReviewReceiptShape(value: unknown): MemoryReviewReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid receipt shape");
  const record = value as Record<string, unknown>;
  const baseAllowed = ["schema", "session_id", "prompt_id", "last_assistant_message_sha256", "snapshot_sha256", "transcript_path", "telegram_message_id", "release_sha", "tool_iterations", "created_at", "status"];
  const v3Allowed = [...baseAllowed, "attempts", "failure_phase", "failure_reason"];
  const keys = Object.keys(record);
  if (record.schema === 2) {
    if (keys.length !== baseAllowed.length || baseAllowed.some(key => !(key in record))) throw new Error("invalid receipt field shape");
  } else if (keys.some(key => !v3Allowed.includes(key)) || baseAllowed.some(key => !(key in record))) throw new Error("invalid receipt field shape");
  if (record.schema !== 2 && record.schema !== MEMORY_REVIEW_RECEIPT_SCHEMA_VERSION) throw new Error("invalid receipt schema version");
  if (typeof record.status !== "string" || !STATUSES.includes(record.status as MemoryReviewReceiptStatus)) throw new Error("invalid receipt status");
  const candidate = {
    session_id: record.session_id,
    prompt_id: record.prompt_id,
    last_assistant_message_sha256: record.last_assistant_message_sha256,
    snapshot_sha256: record.snapshot_sha256,
    transcript_path: record.transcript_path,
    telegram_message_id: record.telegram_message_id,
    release_sha: record.release_sha,
    tool_iterations: record.tool_iterations,
    created_at: record.created_at
  } as Omit<MemoryReviewReceipt, "schema" | "status">;
  assertBounds(candidate);
  const attempts = record.schema === 2 ? 0 : record.attempts as number;
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > MEMORY_REVIEW_MAX_ATTEMPTS) throw new Error("invalid receipt attempts");
  const hasFailurePhase = record.schema === 3 && record.failure_phase !== undefined;
  const hasFailureReason = record.schema === 3 && record.failure_reason !== undefined;
  if (hasFailurePhase !== hasFailureReason) throw new Error("invalid receipt failure telemetry");
  if (record.schema !== 2 && (record.failure_phase !== undefined && !MEMORY_REVIEW_FAILURE_PHASES.includes(record.failure_phase as MemoryReviewFailurePhase))) throw new Error("invalid receipt failure phase");
  if (record.schema !== 2 && (record.failure_reason !== undefined && !MEMORY_REVIEW_FAILURE_REASONS.includes(record.failure_reason as MemoryReviewFailureReason))) throw new Error("invalid receipt failure reason");
  return { schema: MEMORY_REVIEW_RECEIPT_SCHEMA_VERSION, ...candidate, status: record.status as MemoryReviewReceiptStatus, attempts,
    ...(record.schema === 3 && record.failure_phase !== undefined ? { failure_phase: record.failure_phase as MemoryReviewFailurePhase } : {}),
    ...(record.schema === 3 && record.failure_reason !== undefined ? { failure_reason: record.failure_reason as MemoryReviewFailureReason } : {}) };
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("short receipt write");
    offset += count;
  }
}

function canonicalBytes(receipt: MemoryReviewReceipt): Buffer {
  const bytes = Buffer.from(JSON.stringify(receipt));
  if (bytes.length > MAX_BYTES) throw new Error("receipt exceeds size limit");
  return bytes;
}

function readLeaf(dirfd: number, name: string, expectedUid: number | undefined): MemoryReviewReceipt | null {
  const path = join(`/proc/self/fd/${dirfd}`, name);
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== FILE_MODE ||
      (expectedUid !== undefined && before.uid !== expectedUid) || before.size > MAX_BYTES) {
    throw new Error("unsafe receipt file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
        (opened.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && opened.uid !== expectedUid) || opened.size > MAX_BYTES) {
      throw new Error("receipt file changed during read");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count <= 0) throw new Error("short receipt read");
      offset += count;
    }
    return validateMemoryReviewReceiptShape(JSON.parse(buffer.toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

// pruneExpired does a full synchronous open/fstat/read/JSON.parse/validate pass over every
// entry -- correct, but too expensive to pay on every single create when the store is nowhere
// near its cap. countReceiptFiles is the cheap alternative: a plain directory listing, no
// per-entry I/O at all. createMemoryReviewReceipt only pays for the full validating pass once
// the raw file count is within PRUNE_SCAN_MARGIN of the cap; below that, the raw count is used
// directly as a safe (if slightly stale) upper bound on "live" entries -- it can only ever be
// >= the true validated-and-unexpired count, so the fail-closed-at-capacity guarantee still
// holds exactly, and TTL-expired entries still get physically pruned once nearby.
const PRUNE_SCAN_MARGIN = 64;

function countReceiptFiles(dirfd: number): number {
  try {
    return readdirSync(`/proc/self/fd/${dirfd}`).filter(name => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function pruneExpired(dirfd: number, expectedUid: number | undefined, now: number): number {
  let entries: string[];
  try {
    entries = readdirSync(`/proc/self/fd/${dirfd}`).filter(name => name.endsWith(".json"));
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of entries) {
    let receipt: MemoryReviewReceipt | null;
    try {
      receipt = readLeaf(dirfd, name, expectedUid);
    } catch {
      // A corrupt or tampered entry never blocks other receipts; it is simply not counted live.
      continue;
    }
    if (receipt === null) continue;
    if (now - receipt.created_at > MEMORY_REVIEW_RECEIPT_RETENTION_MS) {
      try {
        unlinkSync(join(`/proc/self/fd/${dirfd}`, name));
      } catch {
        // Best-effort prune; a failed unlink is counted against the cap instead.
        live += 1;
      }
      continue;
    }
    live += 1;
  }
  return live;
}

export interface CreateMemoryReviewReceiptInput {
  sessionId: string;
  promptId: string;
  lastAssistantMessageSha256: string;
  snapshotSha256: string;
  transcriptPath: string;
  telegramMessageId: number;
  releaseSha: string;
  toolIterations: number;
  createdAt?: number;
}

export type CreateMemoryReviewReceiptResult =
  | { outcome: "created"; receipt: MemoryReviewReceipt }
  | { outcome: "duplicate" }
  | { outcome: "capacity" };

/**
 * Creates a receipt if and only if no receipt already exists for this exact
 * (session_id, prompt_id) pair. Singleflight is enforced by O_CREAT|O_EXCL on the key file,
 * not by a prior existence check, so two concurrent enqueue attempts race safely to exactly
 * one winner. Fails closed (no receipt) once the retention-pruned store is at capacity.
 */
export function createMemoryReviewReceipt(
  input: CreateMemoryReviewReceiptInput,
  options: MemoryReviewReceiptStoreOptions = {}
): CreateMemoryReviewReceiptResult {
  const createdAt = input.createdAt ?? Date.now();
  const receipt: MemoryReviewReceipt = {
    schema: MEMORY_REVIEW_RECEIPT_SCHEMA_VERSION,
    session_id: input.sessionId,
    prompt_id: input.promptId,
    last_assistant_message_sha256: input.lastAssistantMessageSha256,
    snapshot_sha256: input.snapshotSha256,
    transcript_path: input.transcriptPath,
    telegram_message_id: input.telegramMessageId,
    release_sha: input.releaseSha,
    tool_iterations: input.toolIterations,
    created_at: createdAt,
    status: "queued",
    attempts: 0
  };
  assertBounds(receipt);

  return withDirectory(options, (dirfd, expectedUid) => {
    const maxEntries = options.maxEntries ?? MEMORY_REVIEW_RECEIPT_MAX_ENTRIES;
    const key = memoryReviewReceiptKey(input.sessionId, input.promptId);
    if (!RECEIPT_KEY_RE.test(key)) throw new Error("invalid receipt key");
    const name = `${key}.json`;
    const path = join(`/proc/self/fd/${dirfd}`, name);

    // Detect an existing receipt for this exact key first -- this is a single targeted read,
    // never a full-store scan, so it stays cheap regardless of whether the lazy prune below
    // runs. A still-live existing receipt is a duplicate enqueue (no-op). One that has already
    // passed its retention TTL is deleted right here so retrying the exact same key is never
    // blocked by a stale entry the lazy full prune hasn't reached yet.
    const existing = readLeaf(dirfd, name, expectedUid);
    if (existing !== null) {
      if (createdAt - existing.created_at <= MEMORY_REVIEW_RECEIPT_RETENTION_MS) {
        return { outcome: "duplicate" };
      }
      try { unlinkSync(path); fsyncSync(dirfd); } catch { /* best effort; EEXIST below still guards */ }
    }

    const rawCount = countReceiptFiles(dirfd);
    const live = rawCount + PRUNE_SCAN_MARGIN >= maxEntries
      ? pruneExpired(dirfd, expectedUid, createdAt)
      : rawCount;
    if (live >= maxEntries) return { outcome: "capacity" };

    let fd: number;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { outcome: "duplicate" };
      throw error;
    }
    try {
      writeAll(fd, canonicalBytes(receipt));
      fsyncSync(fd);
    } catch (error) {
      try { unlinkSync(path); } catch { /* best effort cleanup */ }
      throw error;
    } finally {
      closeSync(fd);
    }
    fsyncSync(dirfd);

    const readback = readLeaf(dirfd, name, expectedUid);
    if (readback === null || readback.session_id !== receipt.session_id || readback.prompt_id !== receipt.prompt_id ||
        readback.status !== "queued") {
      throw new Error("receipt readback failed");
    }
    return { outcome: "created", receipt: readback };
  });
}

export function readMemoryReviewReceipt(
  sessionId: string,
  promptId: string,
  options: MemoryReviewReceiptStoreOptions = {}
): MemoryReviewReceipt | null {
  const key = memoryReviewReceiptKey(sessionId, promptId);
  return withDirectory(options, (dirfd, expectedUid) => readLeaf(dirfd, `${key}.json`, expectedUid));
}

/**
 * Transitions an existing "queued" receipt to a terminal status. Refuses to touch a receipt
 * that is not currently queued, so a slow duplicate worker can never clobber a result that
 * already landed.
 */
export function transitionMemoryReviewReceipt(
  sessionId: string,
  promptId: string,
  status: "reviewed" | "failed",
  options: MemoryReviewReceiptStoreOptions = {}
): boolean {
  const key = memoryReviewReceiptKey(sessionId, promptId);
  return withDirectory(options, (dirfd, expectedUid) => {
    const name = `${key}.json`;
    const current = readLeaf(dirfd, name, expectedUid);
    if (current === null || current.status !== "queued") return false;
    const next: MemoryReviewReceipt = { ...current, status };
    const anchoredDirectory = `/proc/self/fd/${dirfd}`;
    const tempName = `.${key}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const temp = join(anchoredDirectory, tempName);
    const target = join(anchoredDirectory, name);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    try {
      writeAll(fd, canonicalBytes(next));
      fsyncSync(fd);
      closeSync(fd);
      renameSync(temp, target);
      fsyncSync(dirfd);
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(temp); } catch { /* best effort cleanup */ }
      throw error;
    }
    const readback = readLeaf(dirfd, name, expectedUid);
    return readback !== null && readback.status === status;
  });
}

function mutateQueuedReceipt(sessionId: string, promptId: string, updater: (receipt: MemoryReviewReceipt) => MemoryReviewReceipt | null, options: MemoryReviewReceiptStoreOptions = {}): MemoryReviewReceipt | null {
  const key = memoryReviewReceiptKey(sessionId, promptId);
  return withDirectory(options, (dirfd, expectedUid) => {
    const name = `${key}.json`;
    const current = readLeaf(dirfd, name, expectedUid);
    if (current === null || current.status !== "queued") return null;
    const next = updater(current);
    if (next === null) return null;
    validateMemoryReviewReceiptShape(next);
    const temp = join(`/proc/self/fd/${dirfd}`, `.${key}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    try { writeAll(fd, canonicalBytes(next)); fsyncSync(fd); closeSync(fd); renameSync(temp, join(`/proc/self/fd/${dirfd}`, name)); fsyncSync(dirfd); }
    catch (error) { try { closeSync(fd); } catch {} try { unlinkSync(temp); } catch {} throw error; }
    return readLeaf(dirfd, name, expectedUid);
  });
}

/** Atomically claims one model attempt, upgrading a legacy v2 receipt on write. */
export function beginMemoryReviewAttempt(sessionId: string, promptId: string, options: MemoryReviewReceiptStoreOptions = {}): MemoryReviewReceipt | null {
  return mutateQueuedReceipt(sessionId, promptId, receipt => {
    if (receipt.attempts >= MEMORY_REVIEW_MAX_ATTEMPTS) return null;
    return { ...receipt, attempts: receipt.attempts + 1 };
  }, options);
}

/** Stores only allowlisted, privacy-safe failure telemetry. */
export function recordMemoryReviewFailure(sessionId: string, promptId: string, phase: MemoryReviewFailurePhase, reason: MemoryReviewFailureReason, terminal: boolean, options: MemoryReviewReceiptStoreOptions = {}): MemoryReviewReceipt | null {
  return mutateQueuedReceipt(sessionId, promptId, receipt => ({ ...receipt, status: terminal ? "failed" : "queued", failure_phase: phase, failure_reason: reason }), options);
}

// Re-exported so callers that only need a stable content digest do not need their own
// crypto import for this narrow purpose.
export function sha256Hex(value: string): string {
  return nodeCreateHash("sha256").update(value).digest("hex");
}
