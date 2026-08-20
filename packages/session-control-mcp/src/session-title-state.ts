import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 8 * 1024;
const MAX_TITLE_CHARS = 60;
const STATE_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type Status = "claimed" | "auto_applied" | "failed" | "user_locked";

export interface SessionTitleState {
  version: 1;
  sessionId: string;
  status: Status;
  attempts: 1;
  title?: string;
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
        throw new Error("state directory is not a real directory");
      }
      const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = fstatSync(next);
      if (!opened.isDirectory() || opened.ino !== before.ino || opened.dev !== before.dev) {
        closeSync(next);
        throw new Error("state directory changed");
      }
      closeSync(fd);
      fd = next;
    }
    const final = fstatSync(fd);
    if ((final.mode & 0o7777) !== DIRECTORY_MODE || (expectedUid !== undefined && final.uid !== expectedUid)) {
      throw new Error("state directory validation failed");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
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
    : ["version", "sessionId", "status", "attempts", "updatedAt"];
  if (keys.some(key => !allowed.includes(key)) || allowed.some(key => !(key in record))) {
    throw new Error("invalid title state schema");
  }
  if (record.version !== STATE_VERSION || record.sessionId !== sessionId ||
      (record.status !== "claimed" && record.status !== "auto_applied" && record.status !== "failed" && record.status !== "user_locked") ||
      record.attempts !== 1 || typeof record.updatedAt !== "number" || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
    throw new Error("invalid title state schema");
  }
  if (record.status === "auto_applied" || record.status === "user_locked") {
    if (typeof record.title !== "string") throw new Error("invalid title state schema");
    assertTitle(record.title);
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
  const value: Record<string, unknown> = { version: 1, sessionId: state.sessionId, status: state.status, attempts: 1 };
  if (state.title !== undefined) value.title = state.title;
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

function transition(options: SessionTitleStateOptions, status: "auto_applied" | "failed", title?: string): boolean {
  if (status === "auto_applied") { if (title === undefined) throw new Error("applied title is required"); assertTitle(title); }
  return withDirectory(options, (directory, dirfd, expectedUid) => {
    const path = statePath(directory, options.sessionId);
    const current = readLeaf(join(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId);
    if (current === null || current.status !== "claimed") return false;
    const next: SessionTitleState = { version: 1, sessionId: options.sessionId, status, attempts: 1, updatedAt: Date.now() };
    if (title !== undefined) next.title = title;
    replaceLeaf(directory, dirfd, path, next);
    return true;
  });
}

export function completeAutoTitle(options: SessionTitleStateOptions & { title: string }): boolean {
  return transition(options, "auto_applied", options.title);
}

export function failAutoTitle(options: SessionTitleStateOptions): boolean {
  return transition(options, "failed");
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
