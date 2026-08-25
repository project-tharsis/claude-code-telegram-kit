/** Small directory-FD-anchored JSON leaf store for private runtime evidence. */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { openDirectoryFd } from "./fs-safety.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LEAF_RE = /^[A-Za-z0-9._-]{1,180}$/;

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function validateLeaf(name: string): void {
  if (!LEAF_RE.test(name) || name.includes("..")) throw new Error("invalid secure state leaf");
}

function readAll(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error("short secure state read");
    offset += count;
  }
  return bytes;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("short secure state write");
    offset += count;
  }
}

export function openSecureStateDirectory(directory: string, label: string): number {
  return openDirectoryFd(resolve(directory), uid(), DIRECTORY_MODE, label);
}

export function readSecureStateLeafFd(dirfd: number, name: string, maxBytes: number): Buffer | null {
  validateLeaf(name);
  const path = `/proc/self/fd/${dirfd}/${name}`;
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const expectedUid = uid();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o7777) !== FILE_MODE ||
    (expectedUid !== undefined && before.uid !== expectedUid) ||
    before.size < 1 ||
    before.size > maxBytes
  ) throw new Error("unsafe secure state leaf");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      (opened.mode & 0o7777) !== FILE_MODE ||
      opened.size !== before.size ||
      (expectedUid !== undefined && opened.uid !== expectedUid)
    ) throw new Error("secure state leaf changed during read");
    const bytes = readAll(fd, opened.size);
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error("secure state leaf changed during read");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function writeSecureStateLeafFd(dirfd: number, name: string, bytes: Buffer, maxBytes: number): void {
  validateLeaf(name);
  if (bytes.length < 1 || bytes.length > maxBytes) throw new Error("secure state leaf exceeds limit");
  const anchored = `/proc/self/fd/${dirfd}`;
  const tempName = `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const tempPath = join(anchored, tempName);
  const target = join(anchored, name);
  const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, target);
  fsyncSync(dirfd);
  const readback = readSecureStateLeafFd(dirfd, name, maxBytes);
  if (readback === null || !readback.equals(bytes)) throw new Error("secure state readback failed");
}

export function removeSecureStateLeafFd(dirfd: number, name: string, maxBytes: number): boolean {
  if (readSecureStateLeafFd(dirfd, name, maxBytes) === null) return false;
  unlinkSync(`/proc/self/fd/${dirfd}/${name}`);
  fsyncSync(dirfd);
  return true;
}

export function listSecureStateLeavesFd(dirfd: number, suffix: string, maxEntries: number): string[] {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new Error("invalid state entry cap");
  const names = readdirSync(`/proc/self/fd/${dirfd}`).filter(name => name.endsWith(suffix)).sort();
  if (names.length > maxEntries) throw new Error("secure state entry cap exceeded");
  for (const name of names) validateLeaf(name);
  return names;
}
