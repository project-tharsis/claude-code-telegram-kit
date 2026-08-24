import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  type Stats
} from "node:fs";
import { basename, isAbsolute } from "node:path";
import { parseDirectTelegramEnvelope } from "@project-tharsis/claude-code-telegram-shared";
import { parseControlCommand } from "./control-command.js";
import type { ControlHookInput } from "./control-input.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_EVENT_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export interface ControlMessageClaims {
  claim: (chatId: string, messageId: string) => boolean;
}

export function isAttestedUsageQueueRuntime(env: Record<string, string | undefined>): boolean {
  const release = env.CLAUDE_RUNTIME_RELEASE_SHA;
  const generation = env.CLAUDE_RUNTIME_GENERATION;
  if (release === undefined && generation === undefined) return false;
  if (!/^[0-9a-f]{40}$/.test(release ?? "") || !/^[0-9a-f]{32}$/.test(generation ?? "")) {
    throw new Error("runtime attestation is incomplete");
  }
  return true;
}

export function createControlMessageClaims(maxEntries = 4_096): ControlMessageClaims {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4_096) {
    throw new Error("invalid control claim bound");
  }
  const claimed = new Set<string>();
  return {
    claim: (chatId, messageId) => {
      const key = `${chatId}/${messageId}`;
      if (claimed.has(key)) return false;
      if (claimed.size >= maxEntries) return false;
      claimed.add(key);
      return true;
    }
  };
}

export function parseQueuedUsageEvent(
  line: string,
  transcriptSessionId: string,
  nowMs = Date.now()
): ControlHookInput | null {
  if (!SESSION_ID.test(transcriptSessionId) || line.length === 0 || line.length > 64 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 5 || keys.some(key => ![
    "type", "operation", "timestamp", "sessionId", "content"
  ].includes(key))) return null;
  if (row.type !== "queue-operation" || row.operation !== "enqueue"
    || row.sessionId !== transcriptSessionId || typeof row.content !== "string"
    || typeof row.timestamp !== "string" || !ISO_TIME.test(row.timestamp)) return null;
  const observedAt = Date.parse(row.timestamp);
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== row.timestamp
    || observedAt < nowMs - MAX_EVENT_AGE_MS || observedAt > nowMs + MAX_FUTURE_SKEW_MS) return null;
  const envelope = parseDirectTelegramEnvelope(row.content);
  if (envelope === null || parseControlCommand(envelope.body).kind !== "usage") return null;
  return {
    session_id: transcriptSessionId,
    prompt_id: `queue:${envelope.messageId}`,
    prompt: row.content,
    hook_event_name: "UserPromptSubmit"
  };
}

const TRANSCRIPT = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/;
const MAX_TRANSCRIPTS = 64;
const MAX_SCAN_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const POLL_MS = 250;

interface ScheduleHandle { cancel: () => void }
type Schedule = (callback: () => void, delayMs: number) => ScheduleHandle;

export interface QueuedUsageWatcherOptions {
  directory: string;
  dispatch: (input: ControlHookInput) => Promise<unknown>;
  expectedUid?: number;
  now?: () => number;
  schedule?: Schedule;
}

export interface QueuedUsageWatcher {
  poll: () => Promise<void>;
  close: () => void;
}

interface TrackedTranscript {
  fd: number;
  sessionId: string;
  identity: Stats;
  offset: number;
  pending: Buffer;
  skipOversizedLine: boolean;
}

function defaultSchedule(callback: () => void, delayMs: number): ScheduleHandle {
  const handle = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(handle) };
}

function openPinnedDirectory(path: string, expectedUid: number): number {
  if (!isAbsolute(path)) throw new Error("sessions directory must be absolute");
  const parts = path.split("/").slice(1);
  if (parts.some(part => part.length === 0 || part === "." || part === "..")) {
    throw new Error("sessions directory must be canonical");
  }
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts) {
      const next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      closeSync(fd);
      fd = next;
    }
    const info = fstatSync(fd);
    if (!info.isDirectory() || info.uid !== expectedUid || (info.mode & 0o7022) !== 0) {
      throw new Error("sessions directory metadata is invalid");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openTranscript(directoryFd: number, name: string, expectedUid: number): TrackedTranscript | null {
  const match = TRANSCRIPT.exec(name);
  if (match === null || basename(name) !== name) return null;
  let fd: number;
  try {
    fd = openSync(`/proc/self/fd/${directoryFd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  const info = fstatSync(fd);
  if (!info.isFile() || info.uid !== expectedUid || info.nlink !== 1 || (info.mode & 0o7022) !== 0
    || !Number.isSafeInteger(info.size) || info.size < 0) {
    closeSync(fd);
    return null;
  }
  return {
    fd,
    sessionId: match[1]!,
    identity: info,
    offset: info.size,
    pending: Buffer.alloc(0),
    skipOversizedLine: false
  };
}

function sameIdentity(current: Stats, original: Stats): boolean {
  return current.dev === original.dev && current.ino === original.ino && current.uid === original.uid
    && current.mode === original.mode && current.nlink === original.nlink && current.isFile();
}

function readAppendedLines(transcript: TrackedTranscript, current: Stats): string[] {
  if (!Number.isSafeInteger(current.size)) throw new Error("transcript size is invalid");
  const growth = current.size - transcript.offset;
  if (growth <= 0) return [];
  if (growth > MAX_SCAN_BYTES) {
    const last = Buffer.alloc(1);
    const count = readSync(transcript.fd, last, 0, 1, current.size - 1);
    transcript.offset = current.size;
    transcript.pending = Buffer.alloc(0);
    transcript.skipOversizedLine = count !== 1 || last[0] !== 0x0a;
    return [];
  }
  const chunk = Buffer.allocUnsafe(growth);
  let filled = 0;
  while (filled < growth) {
    const count = readSync(transcript.fd, chunk, filled, growth - filled, transcript.offset + filled);
    if (count <= 0) break;
    filled += count;
  }
  transcript.offset += filled;
  let pending = Buffer.concat([transcript.pending, chunk.subarray(0, filled)]);
  const lines: string[] = [];
  let newline: number;
  while ((newline = pending.indexOf(0x0a)) >= 0) {
    const line = pending.subarray(0, newline);
    pending = pending.subarray(newline + 1);
    if (transcript.skipOversizedLine) {
      transcript.skipOversizedLine = false;
    } else if (line.length > 0 && line.length <= MAX_LINE_BYTES) {
      lines.push(line.toString("utf8"));
    }
  }
  if (pending.length > MAX_LINE_BYTES) {
    transcript.pending = Buffer.alloc(0);
    transcript.skipOversizedLine = true;
  } else {
    transcript.pending = pending;
  }
  return lines;
}

export function watchQueuedUsageControls(options: QueuedUsageWatcherOptions): QueuedUsageWatcher {
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined) throw new Error("service uid is unavailable");
  const directoryFd = openPinnedDirectory(options.directory, expectedUid);
  const tracked = new Map<string, TrackedTranscript>();
  try {
    const names = readdirSync(`/proc/self/fd/${directoryFd}`).sort();
    if (names.length > 4_096) throw new Error("sessions directory is too large");
    const transcriptNames = names.filter(name => TRANSCRIPT.test(name));
    if (transcriptNames.length === 0 || transcriptNames.length > MAX_TRANSCRIPTS) {
      throw new Error("tracked transcript count is invalid");
    }
    for (const name of transcriptNames) {
      const transcript = openTranscript(directoryFd, name, expectedUid);
      if (transcript === null) throw new Error("transcript metadata is invalid");
      tracked.set(name, transcript);
    }
  } catch (error) {
    for (const transcript of tracked.values()) {
      try { closeSync(transcript.fd); } catch { /* constructor is already failing */ }
    }
    throw error;
  } finally {
    closeSync(directoryFd);
  }

  const schedule = options.schedule ?? defaultSchedule;
  let timer: ScheduleHandle | null = null;
  let closed = false;
  let running: Promise<void> | null = null;

  const pollOnce = async (): Promise<void> => {
    for (const [name, transcript] of tracked) {
      let current: Stats;
      try { current = fstatSync(transcript.fd); } catch {
        try { closeSync(transcript.fd); } catch { /* descriptor already failed */ }
        tracked.delete(name);
        continue;
      }
      if (!sameIdentity(current, transcript.identity) || current.size < transcript.offset) {
        try { closeSync(transcript.fd); } catch { /* already unusable */ }
        tracked.delete(name);
        continue;
      }
      let lines: string[];
      try {
        lines = readAppendedLines(transcript, current);
      } catch {
        try { closeSync(transcript.fd); } catch { /* descriptor already failed */ }
        tracked.delete(name);
        continue;
      }
      for (const line of lines) {
        const input = parseQueuedUsageEvent(
          line, transcript.sessionId, options.now?.() ?? Date.now()
        );
        if (input !== null) {
          try { await options.dispatch(input); } catch { /* exact row consumed; never retry uncertain send */ }
        }
      }
    }
  };

  const poll = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running !== null) return running;
    running = pollOnce().finally(() => { running = null; });
    return running;
  };
  const scheduleNext = (): void => {
    if (closed) return;
    timer = schedule(() => {
      timer = null;
      void poll().finally(scheduleNext);
    }, POLL_MS);
  };
  scheduleNext();

  return {
    poll,
    close: () => {
      if (closed) return;
      closed = true;
      timer?.cancel();
      timer = null;
      for (const transcript of tracked.values()) {
        try { closeSync(transcript.fd); } catch { /* best effort at shutdown */ }
      }
      tracked.clear();
    }
  };
}
