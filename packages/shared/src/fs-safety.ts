/**
 * Shared symlink-safe, directory-fd-anchored directory-open primitive.
 *
 * Every durable Memory Harness / session-title state store (memory-review-receipt.ts,
 * memory-review-snapshot-store.ts in session-control-mcp, session-title-state.ts) walks its
 * configured directory path one segment at a time through `/proc/self/fd/<fd>/<segment>`, so a
 * symlink swapped in mid-walk can never redirect a later segment outside the intended tree, and
 * verifies the final directory's mode/uid before returning its descriptor. This was previously
 * copy-pasted byte-for-byte into all three call sites; it now lives in exactly one place so a
 * future hardening fix (or a bug fix) to this security boundary cannot silently drift out of
 * sync between them. Every check here (O_NOFOLLOW, ino/dev pinning, symlink rejection, mode/uid
 * validation) is preserved exactly as it was in each of the three original copies.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opens `path`, creating any missing segments along the way, anchored through
 * `/proc/self/fd/<fd>/<segment>` at every step so a symlink swap mid-walk can never redirect a
 * later segment outside the intended tree. Returns an open directory file descriptor the caller
 * owns and must close. Throws if any segment is not a real (non-symlink) directory, if the
 * directory changes identity (ino/dev) between creation-check and open, or if the final
 * directory's mode or owning uid does not match `directoryMode` / `expectedUid`.
 */
export function openDirectoryFd(path: string, expectedUid: number | undefined, directoryMode = 0o700, label = "directory"): number {
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
        mkdirSync(child, directoryMode);
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
    if ((final.mode & 0o7777) !== directoryMode || (expectedUid !== undefined && final.uid !== expectedUid)) {
      throw new Error(`${label} validation failed`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
