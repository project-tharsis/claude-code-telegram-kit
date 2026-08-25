/**
 * Bounded durable provenance ledger for read-only observations of Claude native auto-memory.
 *
 * Only hashes and metadata are persisted. Native memory bodies and the native directory path are
 * never copied into this store. The ledger is an independent 0700/0600 atomic state file and is
 * rejected if configured inside the production memory root.
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { openDirectoryFd } from "./fs-safety.js";
import type { NativeMemoryFileInventory, NativeMemoryObservation } from "./native-memory-observer.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const MEMORY_PATH_RE = /^[^/\\\0]{1,255}\.md$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LEDGER_NAME = "ledger.json";
const MAX_LEDGER_BYTES = 256 * 1024;
export const MEMORY_OBSERVER_LEDGER_MAX_EVENTS = 2_048;
export const MEMORY_OBSERVER_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type MemoryObserverChangeKind = "created" | "modified" | "deleted";

export interface MemoryObserverLedgerFile extends NativeMemoryFileInventory {}

export interface MemoryObserverEvent {
  sequence: number;
  observed_at: number;
  path: string;
  kind: MemoryObserverChangeKind;
  before_sha256: string | null;
  after_sha256: string | null;
  provenance: "claude_native_auto_memory";
  release_sha: string;
}

export interface MemoryObserverLedger {
  schema: 1;
  recovery: null | "corrupt_ledger_rebuilt";
  next_sequence: number;
  latest: {
    observed_at: number;
    release_sha: string;
    directory_sha256: string;
    inventory_sha256: string;
    files: MemoryObserverLedgerFile[];
  };
  watermark: {
    sequence: number;
    observed_at: number;
    inventory_sha256: string;
  };
  events: MemoryObserverEvent[];
}

export interface MemoryObserverLedgerOptions {
  directory?: string;
  expectedUid?: number;
  maxEvents?: number;
  retentionMs?: number;
  nativeMemoryDirectory?: string;
}

class LedgerCorruptionError extends Error {
  constructor() {
    super("invalid ledger");
    this.name = "LedgerCorruptionError";
  }
}

export function defaultMemoryObserverLedgerDirectory(): string {
  return join(homedir(), ".local", "state", "claude-code-telegram-kit", "memory-observer");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertLimits(options: MemoryObserverLedgerOptions): { maxEvents: number; retentionMs: number } {
  const maxEvents = options.maxEvents ?? MEMORY_OBSERVER_LEDGER_MAX_EVENTS;
  const retentionMs = options.retentionMs ?? MEMORY_OBSERVER_LEDGER_RETENTION_MS;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MEMORY_OBSERVER_LEDGER_MAX_EVENTS ||
      !Number.isSafeInteger(retentionMs) || retentionMs < 1 || retentionMs > MEMORY_OBSERVER_LEDGER_RETENTION_MS) {
    throw new Error("invalid ledger limits");
  }
  return { maxEvents, retentionMs };
}

function assertOutsideNativeMemory(directory: string, nativeMemoryDirectory: string | undefined): void {
  if (nativeMemoryDirectory === undefined) return;
  const ledger = resolve(directory);
  const memory = resolve(nativeMemoryDirectory);
  const relation = relative(memory, ledger);
  if (relation === "" || (!relation.startsWith("..") && relation !== "..")) {
    throw new Error("ledger must remain outside native memory");
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("short ledger write");
    offset += count;
  }
}

function readAll(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, offset, size - offset, null);
    if (count <= 0) throw new Error("short ledger read");
    offset += count;
  }
  return buffer;
}

function validFile(value: unknown): value is MemoryObserverLedgerFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5 && MEMORY_PATH_RE.test(String(record.path)) &&
    SHA256_RE.test(String(record.sha256)) && Number.isSafeInteger(record.size) && Number(record.size) >= 0 &&
    typeof record.mtime_ns === "string" && /^\d+$/.test(record.mtime_ns) &&
    record.provenance === "claude_native_auto_memory";
}

function validEvent(value: unknown): value is MemoryObserverEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const nullableSha = (candidate: unknown): boolean => candidate === null || (typeof candidate === "string" && SHA256_RE.test(candidate));
  const kind = String(record.kind);
  const shapeMatchesKind =
    (kind === "created" && record.before_sha256 === null && typeof record.after_sha256 === "string" && SHA256_RE.test(record.after_sha256)) ||
    (kind === "modified" && typeof record.before_sha256 === "string" && SHA256_RE.test(record.before_sha256) &&
      typeof record.after_sha256 === "string" && SHA256_RE.test(record.after_sha256) && record.before_sha256 !== record.after_sha256) ||
    (kind === "deleted" && typeof record.before_sha256 === "string" && SHA256_RE.test(record.before_sha256) && record.after_sha256 === null);
  return Object.keys(record).length === 8 && Number.isSafeInteger(record.sequence) && Number(record.sequence) >= 1 &&
    Number.isSafeInteger(record.observed_at) && Number(record.observed_at) >= 0 &&
    MEMORY_PATH_RE.test(String(record.path)) && shapeMatchesKind &&
    nullableSha(record.before_sha256) && nullableSha(record.after_sha256) &&
    record.provenance === "claude_native_auto_memory" && RELEASE_SHA_RE.test(String(record.release_sha));
}

function validateLedger(value: unknown, maxEvents: number): MemoryObserverLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LedgerCorruptionError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 6 || record.schema !== 1 ||
      (record.recovery !== null && record.recovery !== "corrupt_ledger_rebuilt") ||
      !Number.isSafeInteger(record.next_sequence) || Number(record.next_sequence) < 1 ||
      typeof record.latest !== "object" || record.latest === null || Array.isArray(record.latest) ||
      typeof record.watermark !== "object" || record.watermark === null || Array.isArray(record.watermark) ||
      !Array.isArray(record.events) || record.events.length > maxEvents || !record.events.every(validEvent)) {
    throw new LedgerCorruptionError();
  }
  const latest = record.latest as Record<string, unknown>;
  const watermark = record.watermark as Record<string, unknown>;
  if (Object.keys(latest).length !== 5 || !Number.isSafeInteger(latest.observed_at) || Number(latest.observed_at) < 0 ||
      !RELEASE_SHA_RE.test(String(latest.release_sha)) || !SHA256_RE.test(String(latest.directory_sha256)) ||
      !SHA256_RE.test(String(latest.inventory_sha256)) || !Array.isArray(latest.files) || latest.files.length > 64 ||
      !latest.files.every(validFile) || Object.keys(watermark).length !== 3 ||
      !Number.isSafeInteger(watermark.sequence) || Number(watermark.sequence) < 0 ||
      !Number.isSafeInteger(watermark.observed_at) || Number(watermark.observed_at) < 0 ||
      !SHA256_RE.test(String(watermark.inventory_sha256))) {
    throw new LedgerCorruptionError();
  }
  const files = latest.files as MemoryObserverLedgerFile[];
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path >= files[index]!.path) throw new LedgerCorruptionError();
  }
  const events = record.events as MemoryObserverEvent[];
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence) throw new LedgerCorruptionError();
  }
  if (Number(watermark.observed_at) !== Number(latest.observed_at) ||
      String(watermark.inventory_sha256) !== String(latest.inventory_sha256)) throw new LedgerCorruptionError();
  const lastEventSequence = events.at(-1)?.sequence ?? 0;
  const highest = lastEventSequence > Number(watermark.sequence) ? lastEventSequence : Number(watermark.sequence);
  if (Number(record.next_sequence) <= highest) throw new LedgerCorruptionError();
  return value as MemoryObserverLedger;
}

function readLeaf(dirfd: number, expectedUid: number | undefined, maxEvents: number): MemoryObserverLedger | null {
  const path = `/proc/self/fd/${dirfd}/${LEDGER_NAME}`;
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      (before.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && before.uid !== expectedUid) ||
      before.size < 1 || before.size > MAX_LEDGER_BYTES) {
    throw new Error("unsafe ledger file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
        (opened.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && opened.uid !== expectedUid) ||
        opened.size < 1 || opened.size > MAX_LEDGER_BYTES) {
      throw new Error("unsafe ledger file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readAll(fd, opened.size).toString("utf8"));
    } catch {
      throw new LedgerCorruptionError();
    }
    return validateLedger(parsed, maxEvents);
  } finally {
    closeSync(fd);
  }
}

function canonicalBytes(ledger: MemoryObserverLedger): Buffer {
  const bytes = Buffer.from(JSON.stringify(ledger));
  if (bytes.length < 1 || bytes.length > MAX_LEDGER_BYTES) throw new Error("ledger exceeds size limit");
  return bytes;
}

function deltaEvents(
  previous: MemoryObserverLedger | null,
  observation: NativeMemoryObservation,
  startSequence: number
): MemoryObserverEvent[] {
  const before = new Map((previous?.latest.files ?? []).map(file => [file.path, file]));
  const after = new Map(observation.files.map(file => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const events: MemoryObserverEvent[] = [];
  let sequence = startSequence;
  for (const path of paths) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    let kind: MemoryObserverChangeKind | null = null;
    if (oldFile === undefined && newFile !== undefined) kind = "created";
    else if (oldFile !== undefined && newFile === undefined) kind = "deleted";
    else if (oldFile?.sha256 !== newFile?.sha256) kind = "modified";
    if (kind === null) continue;
    events.push({
      sequence,
      observed_at: observation.observed_at,
      path,
      kind,
      before_sha256: oldFile?.sha256 ?? null,
      after_sha256: newFile?.sha256 ?? null,
      provenance: "claude_native_auto_memory",
      release_sha: observation.release_sha
    });
    sequence += 1;
  }
  return events;
}

function writeLedger(dirfd: number, ledger: MemoryObserverLedger, expectedUid: number | undefined, maxEvents: number): void {
  const anchored = `/proc/self/fd/${dirfd}`;
  const temp = join(anchored, `.ledger.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const target = join(anchored, LEDGER_NAME);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    writeAll(fd, canonicalBytes(ledger));
    fsyncSync(fd);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  fsyncSync(dirfd);
  const readback = readLeaf(dirfd, expectedUid, maxEvents);
  if (readback === null || JSON.stringify(readback) !== JSON.stringify(ledger)) {
    throw new Error("ledger readback failed");
  }
}

export function readMemoryObserverLedger(options: MemoryObserverLedgerOptions = {}): MemoryObserverLedger | null {
  const { maxEvents } = assertLimits(options);
  const directory = resolve(options.directory ?? defaultMemoryObserverLedgerDirectory());
  assertOutsideNativeMemory(directory, options.nativeMemoryDirectory);
  const expectedUid = options.expectedUid ?? currentUid();
  const dirfd = openDirectoryFd(directory, expectedUid, DIRECTORY_MODE, "memory observer ledger directory");
  try {
    return readLeaf(dirfd, expectedUid, maxEvents);
  } finally {
    closeSync(dirfd);
  }
}

export function recordMemoryObservation(
  observation: NativeMemoryObservation,
  options: MemoryObserverLedgerOptions = {}
): MemoryObserverLedger {
  const { maxEvents, retentionMs } = assertLimits(options);
  const directory = resolve(options.directory ?? defaultMemoryObserverLedgerDirectory());
  assertOutsideNativeMemory(directory, observation.memoryDirectory);
  const expectedUid = options.expectedUid ?? currentUid();
  const dirfd = openDirectoryFd(directory, expectedUid, DIRECTORY_MODE, "memory observer ledger directory");
  try {
    let previous: MemoryObserverLedger | null;
    let recovery: MemoryObserverLedger["recovery"] = null;
    try {
      previous = readLeaf(dirfd, expectedUid, maxEvents);
      recovery = previous?.recovery ?? null;
    } catch (error) {
      if (!(error instanceof LedgerCorruptionError)) throw error;
      previous = null;
      recovery = "corrupt_ledger_rebuilt";
    }
    const startSequence = previous?.next_sequence ?? 1;
    const additions = deltaEvents(previous, observation, startSequence);
    const nextSequence = startSequence + additions.length;
    const cutoff = observation.observed_at - retentionMs;
    const events = [...(previous?.events ?? []), ...additions]
      .filter(event => event.observed_at >= cutoff)
      .slice(-maxEvents);
    const latestFiles = observation.files.map(file => ({ ...file }));
    const lastSequence = additions.at(-1)?.sequence ?? previous?.watermark.sequence ?? 0;
    const ledger: MemoryObserverLedger = {
      schema: 1,
      recovery,
      next_sequence: nextSequence,
      latest: {
        observed_at: observation.observed_at,
        release_sha: observation.release_sha,
        directory_sha256: observation.directory_sha256,
        inventory_sha256: observation.watermark,
        files: latestFiles
      },
      watermark: {
        sequence: lastSequence,
        observed_at: observation.observed_at,
        inventory_sha256: observation.watermark
      },
      events
    };
    validateLedger(ledger, maxEvents);
    writeLedger(dirfd, ledger, expectedUid, maxEvents);
    return ledger;
  } finally {
    closeSync(dirfd);
  }
}
