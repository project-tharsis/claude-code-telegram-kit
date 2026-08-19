import { chmodSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { formatUsageSnapshot, parseUsageSnapshot, readSubscriptionUsage } from "../src/subscription-usage.js";

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
    expect(formatUsageSnapshot(parsed, 1_100_000)).toContain("Current session: 1% used");
    expect(formatUsageSnapshot(parsed, 1_100_000)).toContain("Current week (all models): 11.5% used");
  });

  test("marks last-known snapshots and rejects expired/future/bad shapes", () => {
    expect(formatUsageSnapshot(parseUsageSnapshot(JSON.stringify(snapshot()), 4_700_000), 4_700_000)).toContain("last-known");
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
