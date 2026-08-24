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
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openDirectoryFd } from "@project-tharsis/claude-code-telegram-shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 8 * 1024;
const MAX_TITLE_CHARS = 60;
const STATE_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type Status = "claimed" | "auto_applied" | "failed" | "user_locked";
export type SessionTitleFailurePhase = "generate" | "parse" | "rename" | "readback" | "lock";
export type SessionTitleFailureReason = "timeout" | "command_failed" | "invalid_output" | "rename_failed" | "readback_failed" | "lock_failed" | "state_failed";

const FAILURE_REASONS_BY_PHASE: Record<SessionTitleFailurePhase, readonly SessionTitleFailureReason[]> = {
  generate: ["timeout", "command_failed"],
  parse: ["invalid_output"],
  rename: ["rename_failed"],
  readback: ["readback_failed", "state_failed"],
  lock: ["lock_failed", "state_failed"]
};

export function isRetryableTitleFailure(
  phase: SessionTitleFailurePhase,
  reason: SessionTitleFailureReason
): boolean {
  return (phase === "generate" && (reason === "timeout" || reason === "command_failed"))
    || (phase === "parse" && reason === "invalid_output");
}

function isValidFailureTuple(
  phase: SessionTitleFailurePhase,
  reason: SessionTitleFailureReason
): boolean {
  return FAILURE_REASONS_BY_PHASE[phase].includes(reason);
}

export interface SessionTitleState {
  version: 1;
  sessionId: string;
  status: Status;
  attempts: 1 | 2;
  title?: string;
  phase?: SessionTitleFailurePhase;
  reason?: SessionTitleFailureReason;
  retryAt?: number;
  updatedAt: number;
}

export interface SessionTitleStateOptions {
  directory?: string;
  sessionId: string;
  expectedUid?: number;
}

export function defaultSessionTitleStateDirectory(): string {
  return join(homedir(), ".local", "state", "claude-code-telegram-kit", "session-titles");
}

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) throw new Error("invalid session UUID");
}

function assertTitle(title: string): void {
  if (typeof title !== "string") throw new Error("invalid session title");
  const chars = Array.from(title);
  if (chars.length < 1 || chars.length > MAX_TITLE_CHARS) throw new Error("invalid session title");
  if (chars.some(character => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) throw new Error("invalid session title");
}

function expectedDirectory(options: SessionTitleStateOptions): { path: string; expectedUid: number | undefined } {
  const path = resolve(options.directory ?? defaultSessionTitleStateDirectory());
  return { path, expectedUid: options.expectedUid ?? uid() };
}

function openDirectory(path: string, expectedUid: number | undefined): number {
  return openDirectoryFd(path, expectedUid, DIRECTORY_MODE, "state directory");
}

function statePath(directory: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(directory, `${sessionId}.json`);
}

function validateState(value: unknown, sessionId: string): SessionTitleState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid title state");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = record.status === "auto_applied" || record.status === "user_locked"
    ? ["version", "sessionId", "status", "attempts", "title", "updatedAt"]
    : record.status === "failed"
      ? ["version", "sessionId", "status", "attempts", "phase", "reason", "retryAt", "updatedAt"]
      : ["version", "sessionId", "status", "attempts", "updatedAt"];
  const diagnosticKeys = ["phase", "reason", "retryAt"];
  const required = record.status === "failed" && ("phase" in record || "reason" in record || "retryAt" in record)
    ? allowed.filter(key => key !== "retryAt")
    : allowed.filter(key => !diagnosticKeys.includes(key));
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !(key in record))) {
    throw new Error("invalid title state schema");
  }
  if (record.version !== STATE_VERSION || record.sessionId !== sessionId ||
      (record.status !== "claimed" && record.status !== "auto_applied" && record.status !== "failed" && record.status !== "user_locked") ||
      (record.attempts !== 1 && record.attempts !== 2) || typeof record.updatedAt !== "number" || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
    throw new Error("invalid title state schema");
  }
  if (record.status === "auto_applied" || record.status === "user_locked") {
    if (typeof record.title !== "string") throw new Error("invalid title state schema");
    assertTitle(record.title);
  }
  if (record.status === "failed" && (record.phase !== undefined || record.reason !== undefined || record.retryAt !== undefined)) {
    if (typeof record.phase !== "string" || !["generate", "parse", "rename", "readback", "lock"].includes(record.phase) ||
        typeof record.reason !== "string" || !["timeout", "command_failed", "invalid_output", "rename_failed", "readback_failed", "lock_failed", "state_failed"].includes(record.reason) ||
        (record.retryAt !== undefined && (typeof record.retryAt !== "number" || !Number.isSafeInteger(record.retryAt) || record.retryAt < 0))) {
      throw new Error("invalid title state schema");
    }
    const phase = record.phase as SessionTitleFailurePhase;
    const reason = record.reason as SessionTitleFailureReason;
    if (!isValidFailureTuple(phase, reason)
        || (record.retryAt !== undefined && !isRetryableTitleFailure(phase, reason))
        || (record.attempts === 2 && record.retryAt !== undefined)) {
      throw new Error("invalid title state schema");
    }
  }
  return record as unknown as SessionTitleState;
}

function readLeaf(path: string, expectedUid: number | undefined, sessionId: string): SessionTitleState | null {
  let before;
  try { before = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== FILE_MODE ||
      (expectedUid !== undefined && before.uid !== expectedUid) || before.size > MAX_BYTES) {
    throw new Error("unsafe title state file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
        (opened.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && opened.uid !== expectedUid) || opened.size > MAX_BYTES) {
      throw new Error("title state file changed");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count <= 0) throw new Error("short title state read");
      offset += count;
    }
    return validateState(JSON.parse(buffer.toString("utf8")), sessionId);
  } finally { closeSync(fd); }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("short title state write");
    offset += count;
  }
}

function canonicalState(state: SessionTitleState): Buffer {
  const value: Record<string, unknown> = { version: 1, sessionId: state.sessionId, status: state.status, attempts: state.attempts };
  if (state.title !== undefined) value.title = state.title;
  if (state.phase !== undefined) value.phase = state.phase;
  if (state.reason !== undefined) value.reason = state.reason;
  if (state.retryAt !== undefined) value.retryAt = state.retryAt;
  value.updatedAt = state.updatedAt;
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BYTES) throw new Error("title state exceeds size limit");
  return bytes;
}

function closeAndSyncDirectory(fd: number): void {
  fsyncSync(fd);
  closeSync(fd);
}

function withDirectory<T>(options: SessionTitleStateOptions, action: (directory: string, dirfd: number, expectedUid: number | undefined) => T): T {
  assertSessionId(options.sessionId);
  const { path, expectedUid } = expectedDirectory(options);
  const dirfd = openDirectory(path, expectedUid);
  try { return action(path, dirfd, expectedUid); } finally { closeSync(dirfd); }
}

export function readSessionTitleState(options: SessionTitleStateOptions): SessionTitleState | null {
  return withDirectory(options, (_directory, dirfd, expectedUid) =>
    readLeaf(join(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId));
}

export function claimAutoTitle(options: SessionTitleStateOptions): boolean {
  return withDirectory(options, (_directory, dirfd, _expectedUid) => {
    const leafPath = join(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`);
    let fd: number;
    try {
      fd = openSync(leafPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      writeAll(fd, canonicalState({ version: 1, sessionId: options.sessionId, status: "claimed", attempts: 1, updatedAt: Date.now() }));
      fsyncSync(fd);
    } catch (error) {
      try { closeSync(fd); } finally { try { unlinkSync(leafPath); } catch {} }
      throw error;
    }
    closeSync(fd);
    fsyncSync(dirfd);
    return true;
  });
}

function transition(options: SessionTitleStateOptions & { phase?: SessionTitleFailurePhase; reason?: SessionTitleFailureReason; retryAt?: number }, status: "auto_applied" | "failed", title?: string): boolean {
  if (status === "auto_applied") { if (title === undefined) throw new Error("applied title is required"); assertTitle(title); }
  return withDirectory(options, (directory, dirfd, expectedUid) => {
    const path = statePath(directory, options.sessionId);
    const current = readLeaf(join(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId);
    if (current === null || current.status !== "claimed") return false;
    const next: SessionTitleState = { version: 1, sessionId: options.sessionId, status, attempts: current.attempts, updatedAt: Date.now() };
    if (title !== undefined) next.title = title;
    if (status === "failed" && options.phase !== undefined && options.reason !== undefined) {
      next.phase = options.phase;
      next.reason = options.reason;
      if (current.attempts === 1 && options.retryAt !== undefined) next.retryAt = options.retryAt;
    }
    replaceLeaf(directory, dirfd, path, next);
    return true;
  });
}

export function completeAutoTitle(options: SessionTitleStateOptions & { title: string }): boolean {
  return transition(options, "auto_applied", options.title);
}

export function failAutoTitle(options: SessionTitleStateOptions & { phase?: SessionTitleFailurePhase; reason?: SessionTitleFailureReason; retryAt?: number }): boolean {
  return transition(options, "failed");
}

export function retryAutoTitle(options: SessionTitleStateOptions, now = Date.now()): boolean {
  return withDirectory(options, (directory, dirfd, expectedUid) => {
    const current = readLeaf(join(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId);
    if (current === null || current.status !== "failed" || current.attempts !== 1
        || current.phase === undefined || current.reason === undefined
        || !isRetryableTitleFailure(current.phase, current.reason)
        || current.retryAt === undefined || current.retryAt > now) return false;
    replaceLeaf(directory, dirfd, statePath(directory, options.sessionId), { version: 1, sessionId: options.sessionId, status: "claimed", attempts: 2, updatedAt: Date.now() });
    return true;
  });
}

export function lockUserTitle(options: SessionTitleStateOptions & { title: string }): boolean {
  assertTitle(options.title);
  return withDirectory(options, (directory, dirfd, expectedUid) => {
    const path = statePath(directory, options.sessionId);
    // Validate an existing leaf before replacement; every valid state may be superseded by the user.
    readLeaf(join(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId);
    replaceLeaf(directory, dirfd, path, {
      version: 1, sessionId: options.sessionId, status: "user_locked", attempts: 1, title: options.title, updatedAt: Date.now()
    });
    return true;
  });
}

/** Serialize automatic and user-directed title mutations for one exact session across processes. */
export async function withSessionTitleLock<T>(
  options: SessionTitleStateOptions,
  action: () => Promise<T>,
  timeoutMs = 20_000
): Promise<T> {
  assertSessionId(options.sessionId);
  const boundedTimeout = Math.max(1, Math.min(timeoutMs, 60_000));
  const { path, expectedUid } = expectedDirectory(options);
  const dirfd = openDirectory(path, expectedUid);
  let lockFd: number | null = null;
  try {
    const lockPath = `/proc/self/fd/${dirfd}/${options.sessionId}.lock`;
    lockFd = openSync(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      FILE_MODE
    );
    const opened = fstatSync(lockFd);
    const named = lstatSync(lockPath);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino ||
        opened.nlink !== 1 || (opened.mode & 0o7777) !== FILE_MODE ||
        (expectedUid !== undefined && opened.uid !== expectedUid) || opened.size > 1024) {
      throw new Error("unsafe title lock file");
    }
  } catch (error) {
    if (lockFd !== null) {
      closeSync(lockFd);
      lockFd = null;
    }
    throw error;
  } finally {
    closeSync(dirfd);
  }

  try {
    await new Promise<void>((resolveLock, rejectLock) => {
      const child = spawn(
        "/usr/bin/flock",
        ["-x", "-w", (boundedTimeout / 1000).toFixed(3), "3"],
        { stdio: ["ignore", "ignore", "ignore", lockFd as number] }
      );
      child.once("error", () => rejectLock(new Error("session title lock unavailable")));
      child.once("exit", code => {
        if (code === 0) resolveLock();
        else rejectLock(new Error("session title lock timeout"));
      });
    });
    return await action();
  } finally {
    if (lockFd !== null) closeSync(lockFd);
  }
}

function replaceLeaf(directory: string, dirfd: number, path: string, state: SessionTitleState): void {
  const tempName = `.${state.sessionId}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const anchoredDirectory = `/proc/self/fd/${dirfd}`;
  const temp = join(anchoredDirectory, tempName);
  const target = join(anchoredDirectory, path.slice(directory.length + 1));
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    writeAll(fd, canonicalState(state));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, target);
    fsyncSync(dirfd);
  } catch (error) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}
