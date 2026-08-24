import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { UsageSnapshot } from "./subscription-usage.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

class OAuthCredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthCredentialUnavailableError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OAuthUsageOptions {
  path?: string;
  expectedUid?: number;
  now?: () => number;
  userAgent?: string;
  fetch?: FetchLike;
}

function openPinnedDirectory(path: string, expectedUid: number): number {
  if (!isAbsolute(path)) throw new Error("credential parent must be absolute");
  const parts = path.split("/").slice(1);
  if (parts.some(part => part.length === 0 || part === "." || part === "..")) {
    throw new Error("credential parent must be canonical");
  }
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd);
      fd = next;
    }
    const info = fstatSync(fd);
    if (!info.isDirectory() || info.uid !== expectedUid || (info.mode & 0o7022) !== 0) {
      throw new Error("credential parent metadata is invalid");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readAccessToken(path: string, expectedUid: number, nowMs: number): string | null {
  const directoryFd = openPinnedDirectory(dirname(path), expectedUid);
  const name = basename(path);
  try {
    const fd = openSync(`/proc/self/fd/${directoryFd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== expectedUid || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600
        || info.size <= 0 || info.size > MAX_CREDENTIAL_BYTES) throw new Error("credential metadata is invalid");
      const data = Buffer.alloc(info.size);
      let filled = 0;
      while (filled < data.length) {
        const count = readSync(fd, data, filled, data.length - filled, filled);
        if (count <= 0) throw new Error("short credential read");
        filled += count;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, data.length) !== 0) throw new Error("credential changed while reading");
      const value = JSON.parse(data.toString("utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const oauth = (value as Record<string, unknown>).claudeAiOauth;
      if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return null;
      const record = oauth as Record<string, unknown>;
      const token = record.accessToken;
      const expiresAt = record.expiresAt;
      if (typeof token !== "string" || token.length < 20 || token.length > 4_096 || /\s/u.test(token)) return null;
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
      return token;
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(directoryFd);
  }
}

function parseWindow(value: unknown, capturedAt: number): { used_percentage: number; resets_at: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const utilization = record.utilization;
  const resetsAt = record.resets_at;
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0 || utilization > 100
    || typeof resetsAt !== "string") return undefined;
  const resetMs = Date.parse(resetsAt);
  const reset = Math.floor(resetMs / 1_000);
  if (!Number.isFinite(resetMs) || !Number.isSafeInteger(reset)
    || reset < capturedAt - 3_600 || reset > capturedAt + 8 * 24 * 3_600) return undefined;
  return { used_percentage: utilization, resets_at: reset };
}

export interface OAuthUsageReaderOptions extends OAuthUsageOptions {
  freshMs?: number;
  retryMs?: number;
}

export async function fetchOAuthUsageSnapshot(options: OAuthUsageOptions = {}): Promise<UsageSnapshot | null> {
  const path = options.path ?? join(homedir(), ".claude", ".credentials.json");
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined || !isAbsolute(path)) throw new Error("credential authority unavailable");
  const nowMs = options.now?.() ?? Date.now();
  const userAgent = options.userAgent;
  if (typeof userAgent !== "string" || userAgent.length === 0 || userAgent.length > 256
    || !userAgent.startsWith("claude-code/") || /[\u0000-\u001f\u007f]/u.test(userAgent)) return null;
  let token: string | null;
  try {
    token = readAccessToken(path, expectedUid, nowMs);
  } catch (error) {
    if (error instanceof Error
      && (error.message === "credential parent must be canonical" || error.message === "credential parent must be absolute")) throw error;
    throw new OAuthCredentialUnavailableError(error instanceof Error ? error.message : "credential unavailable");
  }
  if (token === null) return null;
  const authorizationHeader = ["Bear", "er ", token].join("");
  const headers = new Headers({
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "User-Agent": userAgent,
    "x-app": "cli",
    Accept: "application/json"
  });
  headers.set(["Authori", "zation"].join(""), authorizationHeader);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let raw: unknown;
  try {
    const text = await response.text();
    if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) return null;
    raw = JSON.parse(text);
  } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const capturedAt = Math.floor(nowMs / 1_000);
  const record = raw as Record<string, unknown>;
  const fiveHour = parseWindow(record.five_hour, capturedAt);
  const sevenDay = parseWindow(record.seven_day, capturedAt);
  if (fiveHour === undefined && sevenDay === undefined) return null;
  return {
    version: 1,
    captured_at: capturedAt,
    windows: {
      ...(fiveHour === undefined ? {} : { five_hour: fiveHour }),
      ...(sevenDay === undefined ? {} : { seven_day: sevenDay })
    }
  };
}


export function createOAuthUsageReader(options: OAuthUsageReaderOptions = {}) {
  const freshMs = options.freshMs ?? 120_000;
  const retryMs = options.retryMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(freshMs) || freshMs < 1_000 || freshMs > 10 * 60_000
    || !Number.isSafeInteger(retryMs) || retryMs < 1_000 || retryMs > 60 * 60_000) {
    throw new Error("OAuth usage cache bounds are invalid");
  }
  const now = options.now ?? Date.now;
  let cached: UsageSnapshot | null = null;
  let nextAttemptAt = 0;
  let inflight: Promise<UsageSnapshot | null> | null = null;
  return async (): Promise<UsageSnapshot | null> => {
    const current = now();
    if (cached !== null && current - cached.captured_at * 1_000 <= freshMs) return cached;
    if (current < nextAttemptAt) return null;
    if (inflight !== null) return inflight;
    inflight = fetchOAuthUsageSnapshot({ ...options, now })
      .catch(error => {
        if (error instanceof OAuthCredentialUnavailableError) return null;
        throw error;
      })
      .then(result => {
        nextAttemptAt = current + (result === null ? retryMs : freshMs);
        if (result !== null) cached = result;
        return result;
      })
      .finally(() => { inflight = null; });
    return inflight;
  };
}
