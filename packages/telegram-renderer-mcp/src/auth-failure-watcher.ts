import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats
} from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_SCAN_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_DURATION_MS = 5_000;
const POLL_MS = 100;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type TimerHandle = unknown;

export interface AuthFailureWatcherScheduler {
  setTimeout(callback: () => void, delayMs?: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface AuthFailureWatcherReader {
  open(path: string, flags: number): number;
  stat(fd: number): Stats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export interface AuthFailureTranscriptInput {
  session_id: string;
  transcript_path: string;
}

export interface AuthFailureWatcherOptions {
  expectedRoot: string;
  onAuthFailure: () => void;
  scheduler?: AuthFailureWatcherScheduler;
  reader?: AuthFailureWatcherReader;
  now?: () => number;
  durationMs?: number;
}

const systemScheduler: AuthFailureWatcherScheduler = {
  setTimeout: (callback, delayMs = 0) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

const systemReader: AuthFailureWatcherReader = {
  open: (path, flags) => openSync(path, flags),
  stat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd)
};

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function trustedFile(stat: Stats, uid: number | undefined): boolean {
  return stat.isFile()
    && stat.nlink === 1
    && (stat.mode & 0o022) === 0
    && (uid === undefined || stat.uid === uid);
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
}

function isFailureRow(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as { type?: unknown; error?: unknown };
  return row.type === "assistant" && row.error === "authentication_failed";
}

function scanLine(line: string, onFailure: () => void): void {
  try {
    if (isFailureRow(JSON.parse(line))) onFailure();
  } catch {
    // Malformed transcript rows are deliberately ignored.
  }
}

/** Watch only bytes appended after this call for one bounded turn. */
export function watchAuthFailureTranscript(
  input: AuthFailureTranscriptInput,
  options: AuthFailureWatcherOptions
): () => void {
  let fd: number | undefined;
  let timer: TimerHandle | undefined;
  let cancelled = false;
  let delivered = false;

  const scheduler = options.scheduler ?? systemScheduler;
  const reader = options.reader ?? systemReader;
  const now = options.now ?? Date.now;
  const durationMs = Math.min(Math.max(options.durationMs ?? DEFAULT_DURATION_MS, 0), DEFAULT_DURATION_MS);

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== undefined) {
      try { scheduler.clearTimeout(timer); } catch { /* fail silent */ }
      timer = undefined;
    }
    if (fd !== undefined) {
      try { reader.close(fd); } catch { /* fail silent */ }
      fd = undefined;
    }
  };

  try {
    if (!isAbsolute(options.expectedRoot) || !isAbsolute(input.transcript_path)) return cancel;
    if (!SESSION_ID.test(input.session_id)) return cancel;
    const expectedPath = join(options.expectedRoot, `${input.session_id}.jsonl`);
    if (input.transcript_path !== expectedPath) return cancel;

    const root = lstatSync(options.expectedRoot);
    const uid = currentUid();
    if (
      !root.isDirectory()
      || (uid !== undefined && root.uid !== uid)
      || (root.mode & 0o022) !== 0
      || realpathSync.native(options.expectedRoot) !== options.expectedRoot
    ) return cancel;
    const before = lstatSync(input.transcript_path);
    if (!trustedFile(before, uid)) return cancel;

    // O_NOFOLLOW prevents a leaf replacement from being followed at open time.
    fd = reader.open(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = reader.stat(fd);
    if (!trustedFile(after, uid) || !sameIdentity(before, after)) return cancel;

    let offset = after.size;
    let pending = "";
    let scanned = 0;
    const deadline = now() + durationMs;

    const poll = (): void => {
      timer = undefined;
      if (cancelled || delivered) return;
      try {
        const current = reader.stat(fd as number);
        if (!trustedFile(current, uid) || !sameIdentity(after, current) || current.size < offset) return cancel();
        const growth = current.size - offset;
        if (growth > MAX_SCAN_BYTES - scanned) return cancel();
        if (growth > 0) {
          const bytes = Buffer.alloc(growth);
          let read = 0;
          while (read < growth) {
            const count = reader.read(fd as number, bytes, read, growth - read, offset + read);
            if (count <= 0) return cancel();
            read += count;
          }
          offset = current.size;
          scanned += growth;
          pending += bytes.toString("utf8");
          if (pending.length > MAX_LINE_BYTES && !pending.includes("\n")) return cancel();
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) continue;
            scanLine(line, () => {
              delivered = true;
              options.onAuthFailure();
            });
            if (delivered) return cancel();
          }
          if (Buffer.byteLength(pending, "utf8") > MAX_LINE_BYTES) pending = "";
        }
        if (now() >= deadline) return cancel();
        timer = scheduler.setTimeout(poll, Math.min(POLL_MS, Math.max(0, deadline - now())));
      } catch {
        cancel();
      }
    };

    timer = scheduler.setTimeout(poll, Math.min(POLL_MS, durationMs));
  } catch {
    cancel();
  }
  return cancel;
}
