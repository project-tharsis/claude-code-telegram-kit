import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { formatRuntimeFailureMessage, type RuntimeFailure } from "./runtime-failure-watcher.js";

const MAX_CACHE_BYTES = 64 * 1024;
const MAX_CACHE_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_CAPTURE_MS = 5 * 60_000;
const MAX_RESET_FUTURE_MS = 7 * 24 * 60 * 60_000;

export const DEFAULT_SUBSCRIPTION_USAGE_CACHE = join(
  homedir(), ".local", "state", "claude-code-telegram-kit", "subscription-usage.json"
);

export interface RuntimeFailureResetOptions {
  path?: string;
  now?: () => number;
  expectedUid?: number;
  timeZone?: string;
  /** Test hook proving leaf access stays anchored after a pathname swap. */
  onDirectoryOpened?: () => void;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isDuplicateFreeJson(text: string): boolean {
  let index = 0;
  const whitespace = (): void => {
    while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  };
  const string = (): string => {
    const start = index;
    if (text[index] !== '"') throw new Error("expected string");
    index += 1;
    while (index < text.length) {
      const char = text[index++]!;
      if (char === '"') {
        const parsed = JSON.parse(text.slice(start, index)) as unknown;
        if (typeof parsed !== "string") throw new Error("invalid string");
        return parsed;
      }
      if (char === "\\") {
        const escape = text[index++];
        if (escape === undefined) throw new Error("invalid escape");
        if (escape === "u") {
          const code = text.slice(index, index + 4);
          if (!/^[0-9a-f]{4}$/iu.test(code)) throw new Error("invalid unicode escape");
          index += 4;
        }
      } else if (char.charCodeAt(0) < 0x20) {
        throw new Error("invalid control character");
      }
    }
    throw new Error("unterminated string");
  };
  function value(depth: number): void {
    if (depth > 16) throw new Error("JSON nesting is too deep");
    whitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      whitespace();
      if (text[index] === "}") { index += 1; return; }
      const keys = new Set<string>();
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate key");
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") throw new Error("expected colon");
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("expected object separator");
      }
    }
    if (char === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("expected array separator");
      }
    }
    if (char === '"') { string(); return; }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) { index += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (number === null) throw new Error("invalid JSON value");
    index += number[0].length;
  }
  try {
    value(0);
    whitespace();
    return index === text.length;
  } catch {
    return false;
  }
}

function parseResetAt(text: string, nowMs: number): number | undefined {
  if (text.length === 0 || text.length > MAX_CACHE_BYTES || !isDuplicateFreeJson(text)) return undefined;
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (!hasOnlyKeys(snapshot, ["version", "captured_at", "windows"]) || snapshot.version !== 1) return undefined;
  if (typeof snapshot.captured_at !== "number" || !Number.isSafeInteger(snapshot.captured_at)) return undefined;
  const capturedMs = snapshot.captured_at * 1_000;
  const ageMs = nowMs - capturedMs;
  if (ageMs < -MAX_FUTURE_CAPTURE_MS || ageMs > MAX_CACHE_AGE_MS) return undefined;
  if (!snapshot.windows || typeof snapshot.windows !== "object" || Array.isArray(snapshot.windows)) return undefined;
  const windows = snapshot.windows as Record<string, unknown>;
  if (!hasOnlyKeys(windows, ["five_hour", "seven_day"])) return undefined;
  const exhaustedResets: number[] = [];
  for (const name of ["five_hour", "seven_day"] as const) {
    const value = windows[name];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const window = value as Record<string, unknown>;
    if (!hasOnlyKeys(window, ["used_percentage", "resets_at"])) return undefined;
    if (typeof window.used_percentage !== "number" || !Number.isFinite(window.used_percentage)
      || window.used_percentage < 0 || window.used_percentage > 100) return undefined;
    if (typeof window.resets_at !== "number" || !Number.isSafeInteger(window.resets_at)) return undefined;
    const resetMs = window.resets_at * 1_000;
    if (resetMs < capturedMs - 60 * 60_000 || resetMs > capturedMs + 8 * 24 * 60 * 60_000) return undefined;
    if (window.used_percentage === 100 && resetMs > nowMs && resetMs <= nowMs + MAX_RESET_FUTURE_MS) {
      exhaustedResets.push(window.resets_at);
    }
  }
  return exhaustedResets.length === 0 ? undefined : Math.max(...exhaustedResets);
}

function openPrivateDirectory(path: string, expectedUid: number): number {
  if (!isAbsolute(path)) throw new Error("snapshot parent must be absolute");
  const parts = path.split("/").slice(1);
  if (parts.some(part => part.length === 0 || part === "." || part === "..")) {
    throw new Error("snapshot parent is not canonical");
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
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.uid !== expectedUid || (opened.mode & 0o7777) !== 0o700) {
      throw new Error("snapshot parent metadata is invalid");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readResetAt(options: RuntimeFailureResetOptions): number | undefined {
  const path = options.path ?? process.env.CLAUDE_SUBSCRIPTION_USAGE_CACHE ?? DEFAULT_SUBSCRIPTION_USAGE_CACHE;
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined || !isAbsolute(path)) return undefined;
  const name = basename(path);
  if (name.length === 0 || name === "." || name === "..") return undefined;
  const directoryFd = openPrivateDirectory(dirname(path), expectedUid);
  try {
    options.onDirectoryOpened?.();
    const fileFd = openSync(`/proc/self/fd/${directoryFd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fileFd);
      if (!opened.isFile() || opened.uid !== expectedUid || (opened.mode & 0o7777) !== 0o600
        || opened.nlink !== 1 || opened.size <= 0 || opened.size > MAX_CACHE_BYTES) return undefined;
      return parseResetAt(readFileSync(fileFd, "utf8"), options.now?.() ?? Date.now());
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(directoryFd);
  }
}

export function enrichRuntimeFailureWithUsageReset(
  failure: RuntimeFailure,
  options: RuntimeFailureResetOptions = {}
): RuntimeFailure {
  if (failure.error !== "rate_limit" || failure.resetsAt !== undefined) return failure;
  try {
    const resetsAt = readResetAt(options);
    return resetsAt === undefined ? failure : { ...failure, resetsAt };
  } catch {
    return failure;
  }
}

export function formatRuntimeFailureNotice(
  failure: RuntimeFailure,
  options: RuntimeFailureResetOptions = {}
): string {
  const nowMs = options.now?.() ?? Date.now();
  const enriched = enrichRuntimeFailureWithUsageReset(failure, { ...options, now: () => nowMs });
  return formatRuntimeFailureMessage(enriched, options.timeZone, nowMs);
}
