/**
 * Read-only inventory of Claude Code's configured native auto-memory directory.
 *
 * This module never creates, removes, renames, chmods, or writes anything below the native
 * memory root. Every directory and Markdown leaf is opened through a pinned directory FD and
 * revalidated after open. Returned inventories contain hashes and metadata only, never memory
 * bodies.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const MARKDOWN_LEAF_RE = /^[^/\\\0]{1,255}\.md$/;
const SETTINGS_MAX_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 256;
export const MAX_NATIVE_MEMORY_FILES = 64;
export const MAX_NATIVE_MEMORY_FILE_BYTES = 64 * 1024;

export interface NativeMemoryFileInventory {
  path: string;
  sha256: string;
  size: number;
  mtime_ns: string;
  provenance: "claude_native_auto_memory";
}

export interface NativeMemoryObservation {
  schema: 1;
  /** Runtime-only authority used to keep the independent ledger outside this root. */
  memoryDirectory: string;
  directory_sha256: string;
  observed_at: number;
  release_sha: string;
  watermark: string;
  files: NativeMemoryFileInventory[];
}

export interface AutoMemorySettingsOptions {
  settingsPath: string;
  expectedUid?: number;
}

export interface ObserveNativeMemoryOptions {
  memoryDirectory: string;
  releaseSha: string;
  expectedUid?: number;
  now?: number;
  maxFiles?: number;
  maxFileBytes?: number;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readAll(fd: number, size: number, label: string): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count <= 0) throw new Error(`short ${label} read`);
    offset += count;
  }
  return buffer;
}

function secureReadSettings(path: string, expectedUid: number | undefined): Buffer {
  const resolved = resolve(path);
  const dirfd = openExistingDirectory(dirname(resolved), expectedUid, "settings directory");
  try {
    const leaf = basename(resolved);
    const pinned = `/proc/self/fd/${dirfd}/${leaf}`;
    let before;
    try {
      before = lstatSync(pinned);
    } catch {
      throw new Error("unsafe settings file");
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (before.mode & 0o022) !== 0 || (expectedUid !== undefined && before.uid !== expectedUid) ||
        before.size < 1 || before.size > SETTINGS_MAX_BYTES) {
      throw new Error("unsafe settings file");
    }
    const fd = openSync(pinned, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
          (opened.mode & 0o022) !== 0 || (expectedUid !== undefined && opened.uid !== expectedUid) ||
          opened.size < 1 || opened.size > SETTINGS_MAX_BYTES) {
        throw new Error("unsafe settings file");
      }
      return readAll(fd, opened.size, "settings");
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(dirfd);
  }
}

/**
 * Resolves the explicit `autoMemoryDirectory` in one Claude settings file. PR2 deliberately
 * requires an explicit absolute setting: silently reconstructing Claude's internal fallback path
 * would create a second authority that can drift from the CLI.
 */
export function resolveConfiguredAutoMemoryDirectory(options: AutoMemorySettingsOptions): string {
  const expectedUid = options.expectedUid ?? currentUid();
  const bytes = secureReadSettings(resolve(options.settingsPath), expectedUid);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid Claude settings JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid Claude settings shape");
  }
  const value = (parsed as Record<string, unknown>).autoMemoryDirectory;
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\0")) {
    throw new Error("configured autoMemoryDirectory is required");
  }
  if (!isAbsolute(value)) throw new Error("autoMemoryDirectory must be absolute");
  return resolve(value);
}

function openExistingDirectory(path: string, expectedUid: number | undefined, label: string): number {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const child = `/proc/self/fd/${fd}/${part}`;
      let before;
      try {
        before = lstatSync(child);
      } catch {
        throw new Error(`unsafe ${label}`);
      }
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`unsafe ${label}`);
      const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = fstatSync(next);
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
        closeSync(next);
        throw new Error(`unsafe ${label}`);
      }
      closeSync(fd);
      fd = next;
    }
    const final = fstatSync(fd);
    if (!final.isDirectory() || (final.mode & 0o022) !== 0 ||
        (expectedUid !== undefined && final.uid !== expectedUid)) {
      throw new Error(`unsafe ${label}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readMemoryLeaf(
  dirfd: number,
  name: string,
  expectedUid: number | undefined,
  maxFileBytes: number
): NativeMemoryFileInventory {
  if (!MARKDOWN_LEAF_RE.test(name)) throw new Error("invalid memory filename");
  const path = `/proc/self/fd/${dirfd}/${name}`;
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    throw new Error("unsafe memory file");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      (before.mode & 0o22n) !== 0n || (expectedUid !== undefined && before.uid !== BigInt(expectedUid)) ||
      before.size > BigInt(maxFileBytes)) {
    throw new Error(before.size > BigInt(maxFileBytes) ? "memory file exceeds size limit" : "unsafe memory file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n ||
        (opened.mode & 0o22n) !== 0n || (expectedUid !== undefined && opened.uid !== BigInt(expectedUid)) ||
        opened.size > BigInt(maxFileBytes)) {
      throw new Error(opened.size > BigInt(maxFileBytes) ? "memory file exceeds size limit" : "unsafe memory file");
    }
    const size = Number(opened.size);
    const bytes = readAll(fd, size, "memory file");
    return {
      path: name,
      sha256: sha256(bytes),
      size,
      mtime_ns: opened.mtimeNs.toString(),
      provenance: "claude_native_auto_memory"
    };
  } finally {
    closeSync(fd);
  }
}

export function observeNativeMemory(options: ObserveNativeMemoryOptions): NativeMemoryObservation {
  if (!RELEASE_SHA_RE.test(options.releaseSha)) throw new Error("invalid observer release SHA");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid observation time");
  const maxFiles = options.maxFiles ?? MAX_NATIVE_MEMORY_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_NATIVE_MEMORY_FILE_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_NATIVE_MEMORY_FILES ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_NATIVE_MEMORY_FILE_BYTES) {
    throw new Error("invalid observer limits");
  }

  const memoryDirectory = resolve(options.memoryDirectory);
  const expectedUid = options.expectedUid ?? currentUid();
  const dirfd = openExistingDirectory(memoryDirectory, expectedUid, "memory directory");
  try {
    const entries = readdirSync(`/proc/self/fd/${dirfd}`);
    if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error("memory directory entry cap exceeded");
    const names = entries.filter(name => name.endsWith(".md")).sort();
    if (names.length > maxFiles) throw new Error("native memory file count exceeds limit");
    const files = names.map(name => readMemoryLeaf(dirfd, name, expectedUid, maxFileBytes));
    const canonical = JSON.stringify(files.map(file => [file.path, file.sha256, file.size, file.mtime_ns]));
    return {
      schema: 1,
      memoryDirectory,
      directory_sha256: sha256(memoryDirectory),
      observed_at: now,
      release_sha: options.releaseSha,
      watermark: sha256(canonical),
      files
    };
  } finally {
    closeSync(dirfd);
  }
}
