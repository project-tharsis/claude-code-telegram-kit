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
const MAX_DATE_SECONDS = 8_640_000_000_000;
const MAX_RESET_NOTICE_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const RUNTIME_FAILURE_TYPES = [
  "rate_limit", "overloaded", "authentication_failed", "oauth_org_not_allowed", "billing_error",
  "invalid_request", "model_not_found", "server_error", "max_output_tokens", "unknown"
] as const;
export type RuntimeFailureType = (typeof RUNTIME_FAILURE_TYPES)[number];
export interface RuntimeFailure { error: RuntimeFailureType; resetsAt?: number }
const RUNTIME_FAILURE_SET = new Set<string>(RUNTIME_FAILURE_TYPES);
const QUOTA_LIMIT_KEYS = new Set([
  "remainingPercentage", "resetsAt", "rateLimitType", "isUsingOverage", "overageStatus",
  "surpassedThreshold", "isPerModel", "isShowingWeeklyRefresh", "isShowingFiveHourRefresh"
]);

type TimerHandle = unknown;

export interface RuntimeFailureWatcherScheduler {
  setTimeout(callback: () => void, delayMs?: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface RuntimeFailureWatcherReader {
  open(path: string, flags: number): number;
  stat(fd: number): Stats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export interface RuntimeFailureTranscriptInput {
  session_id: string;
  transcript_path: string;
}

export interface RuntimeFailureWatcherOptions {
  expectedRoot: string;
  onFailure: (failure: RuntimeFailure) => void;
  scheduler?: RuntimeFailureWatcherScheduler;
  reader?: RuntimeFailureWatcherReader;
  now?: () => number;
  durationMs?: number;
}

const systemScheduler: RuntimeFailureWatcherScheduler = {
  setTimeout: (callback, delayMs = 0) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

const systemReader: RuntimeFailureWatcherReader = {
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

function parseFailureRow(value: unknown): RuntimeFailure | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.type !== "assistant" || row.isApiErrorMessage !== true || typeof row.error !== "string") return null;
  if (!RUNTIME_FAILURE_SET.has(row.error)) return null;
  const message = row.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const envelope = message as Record<string, unknown>;
  if (envelope.role !== "assistant" || !Array.isArray(envelope.content)) return null;
  const quota = row.quotaLimits;
  let resetsAt: number | undefined;
  if (quota !== undefined) {
    if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
    const limits = quota as Record<string, unknown>;
    if (Object.keys(limits).some(key => !QUOTA_LIMIT_KEYS.has(key))) return null;
    const reset = limits.resetsAt;
    if (typeof reset !== "number" || !Number.isSafeInteger(reset)
      || reset <= 0 || reset > MAX_DATE_SECONDS) return null;
    resetsAt = reset;
  }
  return { error: row.error as RuntimeFailureType, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

function scanLine(line: string, onFailure: (failure: RuntimeFailure) => void): void {
  try {
    const failure = parseFailureRow(JSON.parse(line));
    if (failure !== null) onFailure(failure);
  } catch {
    // Malformed transcript rows are deliberately ignored.
  }
}

export function formatRuntimeFailureMessage(
  failure: RuntimeFailure,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  now = Date.now()
): string {
  if (failure.error === "rate_limit") {
    const resetMs = failure.resetsAt === undefined ? 0 : failure.resetsAt * 1_000;
    let reset: string | null = null;
    let zone = timeZone;
    if (resetMs > now && resetMs <= now + MAX_RESET_NOTICE_MS) {
      try {
        reset = new Intl.DateTimeFormat("en-CA", {
          timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hourCycle: "h23"
        }).format(new Date(resetMs));
      } catch {
        zone = "UTC";
        reset = new Intl.DateTimeFormat("en-CA", {
          timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hourCycle: "h23"
        }).format(new Date(resetMs));
      }
    }
    const retry = reset === null ? "Retry after the limit resets." : `Retry after ${reset} (${zone}).`;
    return `Claude Code hit a usage or rate limit.\n\nCurrent work is paused. ${retry}\nMessages sent before recovery will not replay automatically.`;
  }
  if (failure.error === "authentication_failed") {
    return "Claude Code authentication failed.\n\nRe-authenticate Claude Code on the host, then resend this message.";
  }
  if (failure.error === "overloaded" || failure.error === "server_error") {
    return "Claude Code is temporarily unavailable.\n\nThis turn stopped before completion. Retry shortly.";
  }
  if (failure.error === "max_output_tokens") {
    return "Claude Code hit the response output limit.\n\nAsk for a shorter result.";
  }
  return "Claude Code failed before completing this turn.\n\nCheck the host runtime, then resend this message.";
}

/** Watch only bytes appended after this call for one bounded turn. */
export function watchRuntimeFailureTranscript(
  input: RuntimeFailureTranscriptInput,
  options: RuntimeFailureWatcherOptions
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
            scanLine(line, failure => {
              delivered = true;
              options.onFailure(failure);
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
