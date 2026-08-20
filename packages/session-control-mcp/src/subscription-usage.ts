import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_SUBSCRIPTION_USAGE_CACHE = join(
  homedir(), ".local", "state", "claude-code-telegram-kit", "subscription-usage.json"
);
const MAX_CACHE_BYTES = 64 * 1024;
const MAX_CACHE_AGE_MS = 24 * 60 * 60_000;
const FRESH_CACHE_AGE_MS = 60 * 60_000;
const WINDOW_NAMES = ["five_hour", "seven_day"] as const;

type WindowName = (typeof WINDOW_NAMES)[number];
interface UsageWindow { used_percentage: number; resets_at: number }
interface UsageSnapshot { version: 1; captured_at: number; windows: Partial<Record<WindowName, UsageWindow>> }

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && new Set(Object.keys(value)).size === Object.keys(value).length;
}

function parseWindow(value: unknown): UsageWindow | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid usage window");
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, ["used_percentage", "resets_at"])) throw new Error("invalid usage window");
  const percentage = raw.used_percentage;
  if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("invalid usage percentage");
  }
  const reset = raw.resets_at;
  if (typeof reset !== "number" || !Number.isSafeInteger(reset)) throw new Error("invalid reset time");
  return { used_percentage: percentage, resets_at: reset };
}

export function parseUsageSnapshot(text: string, nowMs = Date.now()): UsageSnapshot {
  if (text.length === 0 || text.length > MAX_CACHE_BYTES) throw new Error("invalid usage cache");
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid usage cache");
  const object = raw as Record<string, unknown>;
  if (!exactKeys(object, ["version", "captured_at", "windows"]) || object.version !== 1) {
    throw new Error("invalid usage cache");
  }
  if (!Number.isSafeInteger(object.captured_at) || typeof object.captured_at !== "number") throw new Error("invalid usage cache time");
  const ageMs = nowMs - object.captured_at * 1_000;
  if (ageMs < -5 * 60_000 || ageMs > MAX_CACHE_AGE_MS) throw new Error("usage cache is stale");
  if (typeof object.windows !== "object" || object.windows === null || Array.isArray(object.windows)) {
    throw new Error("invalid usage windows");
  }
  const rawWindows = object.windows as Record<string, unknown>;
  if (!exactKeys(rawWindows, WINDOW_NAMES)) throw new Error("invalid usage windows");
  const windows: Partial<Record<WindowName, UsageWindow>> = {};
  for (const name of WINDOW_NAMES) {
    const parsed = parseWindow(rawWindows[name]);
    if (parsed !== null) {
      if (parsed.resets_at < object.captured_at - 3600 || parsed.resets_at > object.captured_at + 8 * 24 * 3600) {
        throw new Error("invalid usage reset time");
      }
      windows[name] = parsed;
    }
  }
  if (windows.five_hour === undefined && windows.seven_day === undefined) throw new Error("usage windows unavailable");
  return { version: 1, captured_at: object.captured_at, windows };
}

function resetText(value: UsageWindow["resets_at"]): string {
  const date = new Date(value * 1_000);
  return `Resets ${new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short"
  }).format(date)}`;
}

function percent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function usageBar(value: number): string {
  const filled = value <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(value / 10)));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function formatUsageSnapshot(snapshot: UsageSnapshot, nowMs = Date.now()): string {
  const lines = ["<b>Claude Code subscription usage</b>"];
  const labels: Array<[WindowName, string]> = [
    ["five_hour", "Current session"],
    ["seven_day", "Current week (all models)"],
  ];
  for (const [name, label] of labels) {
    const window = snapshot.windows[name];
    if (window === undefined) continue;
    lines.push(
      "",
      `<b>${escapeHtml(label)}</b>`,
      `<code>${usageBar(window.used_percentage)}</code> <b>${percent(window.used_percentage)}%</b>`,
      `<i>${escapeHtml(resetText(window.resets_at))}</i>`
    );
  }
  if (nowMs - snapshot.captured_at * 1_000 > FRESH_CACHE_AGE_MS) {
    lines.push("", `<i>Last known · as of ${escapeHtml(new Date(snapshot.captured_at * 1_000).toLocaleString())}</i>`);
  }
  return lines.join("\n");
}

export interface SubscriptionUsageOptions { path?: string; now?: () => number; expectedUid?: number }

export async function readSubscriptionUsage(options: SubscriptionUsageOptions = {}): Promise<string> {
  const path = options.path ?? process.env.CLAUDE_SUBSCRIPTION_USAGE_CACHE ?? DEFAULT_SUBSCRIPTION_USAGE_CACHE;
  const parent = dirname(path);
  if (realpathSync.native(parent) !== resolve(parent)) throw new Error("usage cache parent is unsafe");
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined) throw new Error("usage cache owner unavailable");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > MAX_CACHE_BYTES) {
    throw new Error("usage cache metadata is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1) {
      throw new Error("usage cache changed during validation");
    }
    const text = readFileSync(fd, "utf8");
    const nowMs = options.now?.() ?? Date.now();
    return formatUsageSnapshot(parseUsageSnapshot(text, nowMs), nowMs);
  } finally {
    closeSync(fd);
  }
}
