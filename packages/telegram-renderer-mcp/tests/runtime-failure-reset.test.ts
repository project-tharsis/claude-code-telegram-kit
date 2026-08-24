import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrichRuntimeFailureWithUsageReset,
  formatRuntimeFailureNotice
} from "../src/runtime-failure-reset.js";

const roots: string[] = [];
const UID = process.getuid?.();
if (UID === undefined) throw new Error("tests require a POSIX uid");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function secureSnapshot(snapshot: unknown, directory?: string): string {
  const root = directory ?? mkdtempSync(join(tmpdir(), "runtime-failure-reset-"));
  if (directory === undefined) roots.push(root);
  chmodSync(root, 0o700);
  const path = join(root, "subscription-usage.json");
  writeFileSync(path, typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot), { mode: 0o600 });
  return path;
}

describe("runtime failure reset enrichment", () => {
  test("adds the future five-hour reset from a secure exhausted snapshot", () => {
    const path = secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: {
        five_hour: { used_percentage: 100, resets_at: 3_000 },
        seven_day: { used_percentage: 36, resets_at: 5_000 }
      }
    });

    expect(enrichRuntimeFailureWithUsageReset(
      { error: "rate_limit" },
      { path, now: () => 2_000_000, expectedUid: UID }
    )).toEqual({ error: "rate_limit", resetsAt: 3_000 });
  });

  test("uses the latest reset when multiple subscription windows are exhausted", () => {
    const path = secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: {
        five_hour: { used_percentage: 100, resets_at: 3_000 },
        seven_day: { used_percentage: 100, resets_at: 5_000 }
      }
    });

    expect(enrichRuntimeFailureWithUsageReset(
      { error: "rate_limit" },
      { path, now: () => 2_000_000, expectedUid: UID }
    )).toEqual({ error: "rate_limit", resetsAt: 5_000 });
  });

  test("keeps the generic notice unless a secure cache proves exhaustion", () => {
    const nonExhausted = secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: { five_hour: { used_percentage: 99, resets_at: 3_000 } }
    });
    const stale = secureSnapshot({
      version: 1,
      captured_at: 1,
      windows: { five_hour: { used_percentage: 100, resets_at: 3_000 } }
    });
    const insecure = secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: { five_hour: { used_percentage: 100, resets_at: 3_000 } }
    });
    chmodSync(insecure, 0o644);

    for (const [path, now] of [
      [nonExhausted, 2_000_000],
      [stale, 100_000_000],
      [insecure, 2_000_000]
    ] as const) {
      expect(enrichRuntimeFailureWithUsageReset(
        { error: "rate_limit" },
        { path, now: () => now, expectedUid: UID }
      )).toEqual({ error: "rate_limit" });
    }
  });

  test("rejects special mode bits and duplicate object keys", () => {
    const specialMode = secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: { five_hour: { used_percentage: 100, resets_at: 3_000 } }
    });
    execFileSync("/bin/chmod", ["1600", specialMode]);
    const duplicate = secureSnapshot(
      '{"version":1,"captured_at":1000,"windows":{"five_hour":{"used_percentage":99,"used\\u005fpercentage":100,"resets_at":3000}}}\n'
    );

    expect(enrichRuntimeFailureWithUsageReset(
      { error: "rate_limit" },
      { path: specialMode, now: () => 2_000_000, expectedUid: UID }
    )).toEqual({ error: "rate_limit" });
    expect(enrichRuntimeFailureWithUsageReset(
      { error: "rate_limit" },
      { path: duplicate, now: () => 2_000_000, expectedUid: UID }
    )).toEqual({ error: "rate_limit" });
  });

  test("keeps reading the pinned directory if its pathname is swapped", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-failure-reset-race-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const live = join(root, "live");
    const attacker = join(root, "attacker");
    mkdirSync(live, { mode: 0o700 });
    mkdirSync(attacker, { mode: 0o700 });
    const path = secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: { five_hour: { used_percentage: 100, resets_at: 3_000 } }
    }, live);
    secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: { five_hour: { used_percentage: 100, resets_at: 5_000 } }
    }, attacker);
    let swapped = false;

    const enriched = enrichRuntimeFailureWithUsageReset(
      { error: "rate_limit" },
      {
        path,
        now: () => 2_000_000,
        expectedUid: UID,
        onDirectoryOpened: () => {
          renameSync(live, join(root, "moved"));
          symlinkSync(attacker, live);
          swapped = true;
        }
      }
    );

    expect(swapped).toBe(true);
    expect(enriched).toEqual({ error: "rate_limit", resetsAt: 3_000 });
  });

  test("renders the trusted reset time instead of the generic retry text", () => {
    const path = secureSnapshot({
      version: 1,
      captured_at: 1_000,
      windows: { five_hour: { used_percentage: 100, resets_at: 3_000 } }
    });

    const notice = formatRuntimeFailureNotice(
      { error: "rate_limit" },
      { path, now: () => 2_000_000, expectedUid: UID, timeZone: "UTC" }
    );

    expect(notice).toContain("(UTC)");
    expect(notice).not.toContain("Retry after the limit resets.");
  });
});
