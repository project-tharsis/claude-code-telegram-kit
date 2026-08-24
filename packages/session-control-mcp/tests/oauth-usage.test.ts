import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuthUsageReader, fetchOAuthUsageSnapshot } from "../src/oauth-usage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function credential(expiresAt = 2_000_000): string {
  const root = mkdtempSync(join(tmpdir(), "oauth-usage-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const path = join(root, ".credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: {
    accessToken: "opaque-test-token-1234567890",
    refreshToken: "must-not-be-used",
    expiresAt
  } }), { mode: 0o600 });
  return path;
}

describe("on-demand OAuth usage", () => {
  test("returns a normalized fresh snapshot from one read-only request", async () => {
    let authorization = "";
    const result = await fetchOAuthUsageSnapshot({
      path: credential(),
      expectedUid: process.getuid!(),
      now: () => 1_000_000,
      userAgent: "claude-code/test",
      fetch: async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({
          five_hour: { utilization: 74, resets_at: "1970-01-01T00:33:20.000Z" },
          seven_day: { utilization: 12.5, resets_at: "1970-01-01T00:50:00.000Z" }
        }), { status: 200 });
      }
    });
    expect(authorization).toBe("Bearer opaque-test-token-1234567890");
    expect(result).toEqual({
      version: 1,
      captured_at: 1_000,
      windows: {
        five_hour: { used_percentage: 74, resets_at: 2_000 },
        seven_day: { used_percentage: 12.5, resets_at: 3_000 }
      }
    });
  });

  test("does not refresh tokens and fails closed on 429 or unsafe credentials", async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; return new Response("{}", { status: 429 }); };
    await expect(fetchOAuthUsageSnapshot({
      path: credential(), expectedUid: process.getuid!(), now: () => 1_000_000,
      userAgent: "claude-code/test", fetch
    })).resolves.toBeNull();
    const unsafe = credential();
    chmodSync(unsafe, 0o644);
    await expect(fetchOAuthUsageSnapshot({
      path: unsafe, expectedUid: process.getuid!(), now: () => 1_000_000,
      userAgent: "claude-code/test", fetch
    })).rejects.toThrow("metadata");
    expect(calls).toBe(1);
  });

  test("coalesces failed on-demand reads behind a cooldown", async () => {
    const path = credential();
    let calls = 0;
    let now = 1_000_000;
    const read = createOAuthUsageReader({
      path,
      expectedUid: process.getuid!(),
      now: () => now,
      retryMs: 300_000,
      userAgent: "claude-code/test",
      fetch: async () => { calls += 1; return new Response("", { status: 429 }); }
    });
    await expect(read()).resolves.toBeNull();
    await expect(read()).resolves.toBeNull();
    expect(calls).toBe(1);
    now += 300_001;
    await expect(read()).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  test("cools down rejected credential reads before retrying", async () => {
    const path = credential();
    chmodSync(path, 0o644);
    let calls = 0;
    let now = 1_000_000;
    const read = createOAuthUsageReader({
      path, expectedUid: process.getuid!(), now: () => now, retryMs: 300_000,
      userAgent: "claude-code/test",
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          five_hour: { utilization: 50, resets_at: "1970-01-01T00:33:20.000Z" }
        }), { status: 200 });
      }
    });
    await expect(read()).resolves.toBeNull();
    chmodSync(path, 0o600);
    await expect(read()).resolves.toBeNull();
    expect(calls).toBe(0);
    now += 300_001;
    await expect(read()).resolves.toMatchObject({ windows: { five_hour: { used_percentage: 50 } } });
    expect(calls).toBe(1);
  });

  test("does not hide credential authority configuration errors", async () => {
    const read = createOAuthUsageReader({
      path: "relative/.credentials.json",
      expectedUid: process.getuid!(),
      userAgent: "claude-code/test"
    });
    await expect(read()).rejects.toThrow("credential authority unavailable");
  });
});
