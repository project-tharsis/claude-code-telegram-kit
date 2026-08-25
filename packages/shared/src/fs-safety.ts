/** Shared directory-FD-anchored open primitives. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";

function walkDirectory(
  path: string,
  expectedUid: number | undefined,
  label: string,
  createMissing: boolean,
  createMode: number,
  finalMode: (mode: number) => boolean,
): number {
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
        if (!createMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(child, createMode);
        before = lstatSync(child);
      }
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error(`${label} is not a real directory`);
      }
      const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = fstatSync(next);
      if (!opened.isDirectory() || opened.ino !== before.ino || opened.dev !== before.dev) {
        closeSync(next);
        throw new Error(`${label} changed during open`);
      }
      closeSync(fd);
      fd = next;
    }
    const final = fstatSync(fd);
    if (!final.isDirectory() || !finalMode(final.mode & 0o7777) ||
        (expectedUid !== undefined && final.uid !== expectedUid)) {
      throw new Error(`${label} validation failed`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Opens `path`, creating missing segments as 0700 directories. The final directory must be exact
 * `directoryMode`; the caller owns the returned descriptor.
 */
export function openDirectoryFd(
  path: string,
  expectedUid: number | undefined,
  directoryMode = 0o700,
  label = "directory",
): number {
  const mode = directoryMode & 0o7777;
  const fd = walkDirectory(path, expectedUid, label, true, mode, candidate => candidate === mode);
  const final = fstatSync(fd);
  if ((final.mode & 0o7777) !== mode) {
    closeSync(fd);
    throw new Error(`${label} validation failed`);
  }
  return fd;
}

/**
 * Opens an existing user-owned directory without creating any segment. Final group/other write
 * bits are forbidden, while normal native-memory modes such as 0755 are accepted.
 */
export function openExistingDirectoryFd(
  path: string,
  expectedUid: number | undefined,
  label = "directory",
): number {
  return walkDirectory(path, expectedUid, label, false, 0o700, mode => (mode & 0o022) === 0);
}
