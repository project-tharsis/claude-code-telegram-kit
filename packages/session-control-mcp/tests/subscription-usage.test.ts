import { chmodSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import {
  formatUnavailableUsage,
  formatUsageSnapshot,
  parseUsageSnapshot,
  readSubscriptionUsage
} from "../src/subscription-usage.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function snapshot(capturedAt = 1_000) {
  return {
    version: 1 as const,
    captured_at: capturedAt,
    windows: {
      five_hour: { used_percentage: 1, resets_at: 2_000 },
      seven_day: { used_percentage: 11.5, resets_at: 3_000 }
    }
  };
}

describe("subscription usage cache", () => {
  test("parses and formats bounded plan windows", () => {
    const parsed = parseUsageSnapshot(JSON.stringify(snapshot()), 1_100_000);
    const html = formatUsageSnapshot(parsed, 1_100_000);
    expect(html).toContain("<b>Claude Code subscription usage</b>");
    expect(html).toContain("<b>5-hour limit</b>");
    expect(html).toContain("<code>█░░░░░░░░░</code> <b>1%</b>");
    expect(html).toContain("<b>7-day limit (all models)</b>");
    expect(html).toContain("<b>11.5%</b>");
  });

  test("hides stale percentages under active quota state", () => {
    const parsed = parseUsageSnapshot(JSON.stringify(snapshot()), 1_100_000);
    const html = formatUsageSnapshot(parsed, 1_100_000, { resetsAt: 2_000, window: "five_hour" });
    expect(html).toContain("<b>Current status</b>");
    expect(html).toContain("<b>5-hour limit reached</b>");
    expect(html).not.toContain("<b>1%</b>");
    expect(html).not.toContain("last known");
  });

  test("labels weekly active quota from structured window", () => {
    const current = { ...snapshot(), windows: { ...snapshot().windows, five_hour: { used_percentage: 100, resets_at: 2_000 } } };
    const parsed = parseUsageSnapshot(JSON.stringify(current), 1_050_000);
    const html = formatUsageSnapshot(parsed, 1_050_000, { resetsAt: 3_000, window: "seven_day" });
    expect(html).toContain("<b>Weekly limit reached</b>");
    expect(html).not.toContain("<b>100%</b>");
  });

  test("shows OAuth live percentages under active quota", () => {
    const current = { ...snapshot(), windows: { ...snapshot().windows, five_hour: { used_percentage: 100, resets_at: 2_000 } } };
    const parsed = parseUsageSnapshot(JSON.stringify(current), 1_050_000);
    const html = formatUsageSnapshot(
      parsed, 1_050_000, { resetsAt: 2_000, window: "five_hour" }, true
    );
    expect(html).toContain("<b>5-hour limit reached</b>");
    expect(html).toContain("<b>100%</b>");
    expect(html).toContain("<b>11.5%</b>");
  });

  test("does not fall back to cached bars when OAuth is unavailable", () => {
    expect(formatUnavailableUsage(undefined, 1_050_000)).toBe(
      "<b>Claude Code subscription usage</b>\n\n<i>Live usage unavailable.</i>"
    );
    const active = formatUnavailableUsage({ resetsAt: 3_000, window: "seven_day" }, 1_050_000);
    expect(active).toContain("<b>Weekly limit reached</b>");
    expect(active).not.toContain("unavailable");
    expect(active).not.toContain("%");
  });

  test("renders truthful zero and full micro-bar endpoints", () => {
    const parsed = parseUsageSnapshot(JSON.stringify({
      version: 1,
      captured_at: 1_000,
      windows: {
        five_hour: { used_percentage: 0, resets_at: 2_000 },
        seven_day: { used_percentage: 100, resets_at: 3_000 }
      }
    }), 1_100_000);
    const html = formatUsageSnapshot(parsed, 1_100_000);
    expect(html).toContain("<code>░░░░░░░░░░</code> <b>0%</b>");
    expect(html).toContain("<code>██████████</code> <b>100%</b>");
  });

  test("marks last-known snapshots and rejects expired/future/bad shapes", () => {
    expect(formatUsageSnapshot(parseUsageSnapshot(JSON.stringify(snapshot()), 4_700_000), 4_700_000))
      .toContain("<i>Last known · as of");
    expect(() => parseUsageSnapshot(JSON.stringify(snapshot()), 100_000_000)).toThrow("stale");
    expect(() => parseUsageSnapshot(JSON.stringify(snapshot(2_000)), 1_000_000)).toThrow("stale");
    for (const bad of [
      { ...snapshot(), extra: true },
      { ...snapshot(), windows: { five_hour: { used_percentage: 101, resets_at: 1 } } },
      { ...snapshot(), windows: { five_hour: { used_percentage: 1, resets_at: 1, secret: "x" } } },
      { ...snapshot(), windows: { five_hour: { used_percentage: 1, resets_at: -9_999 } } },
      { version: 1, captured_at: 1_000, windows: {} }
    ]) expect(() => parseUsageSnapshot(JSON.stringify(bad), 1_100_000)).toThrow();
  });

  test("reads only a private user-owned single-link regular file", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-cache-")); roots.push(root);
    chmodSync(root, 0o700);
    const path = join(root, "usage.json");
    writeFileSync(path, JSON.stringify(snapshot()) + "\n", { mode: 0o600 });
    await expect(readSubscriptionUsage({ path, now: () => 1_100_000, expectedUid: process.getuid!() })).resolves.toContain("subscription usage");
    chmodSync(path, 0o644);
    await expect(readSubscriptionUsage({ path, now: () => 1_100_000, expectedUid: process.getuid!() })).rejects.toThrow("metadata");
  });

  test("rejects symlinks and extra hardlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-cache-")); roots.push(root);
    chmodSync(root, 0o700);
    const real = join(root, "real.json");
    writeFileSync(real, JSON.stringify(snapshot()), { mode: 0o600 });
    const link = join(root, "link.json");
    symlinkSync(real, link);
    await expect(readSubscriptionUsage({ path: link, now: () => 1_100_000, expectedUid: process.getuid!() })).rejects.toThrow();
    const hard = join(root, "hard.json");
    linkSync(real, hard);
    await expect(readSubscriptionUsage({ path: real, now: () => 1_100_000, expectedUid: process.getuid!() })).rejects.toThrow("metadata");
  });
});
