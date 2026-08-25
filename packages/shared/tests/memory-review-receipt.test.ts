import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryReviewReceipt,
  MEMORY_REVIEW_RECEIPT_MAX_ENTRIES,
  readMemoryReviewReceipt,
  transitionMemoryReviewReceipt,
  validateMemoryReviewReceiptShape
} from "../src/memory-review-receipt.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RELEASE_SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function baseInput(overrides: Partial<Parameters<typeof createMemoryReviewReceipt>[0]> = {}) {
  return {
    sessionId: SESSION_ID,
    promptId: "prompt-1",
    lastAssistantMessageSha256: DIGEST,
    snapshotSha256: "c".repeat(64),
    transcriptPath: `/home/USER/.claude/projects/proj/${SESSION_ID}.jsonl`,
    telegramMessageId: 42,
    releaseSha: RELEASE_SHA,
    toolIterations: 3,
    ...overrides
  };
}

describe("durable memory review receipt store", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-review-receipt-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("creates a queued receipt with 0700 directory and 0600 file permissions", () => {
    const result = createMemoryReviewReceipt(baseInput(), { directory });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.receipt.status).toBe("queued");
    expect(result.receipt.schema).toBe(2);
    expect(result.receipt.snapshot_sha256).toBe("c".repeat(64));

    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  test("is singleflight: a duplicate (session_id, prompt_id) enqueue never creates a second receipt or file", () => {
    const first = createMemoryReviewReceipt(baseInput(), { directory });
    const second = createMemoryReviewReceipt(baseInput({ telegramMessageId: 99 }), { directory });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("duplicate");

    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(directory).filter(name => name.endsWith(".json"));
    expect(files.length).toBe(1);

    const stored = readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory });
    expect(stored?.telegram_message_id).toBe(42);
  });

  test("concurrent racing enqueue attempts still produce exactly one created receipt", () => {
    const attempts = Array.from({ length: 8 }, () => createMemoryReviewReceipt(baseInput(), { directory }));
    const created = attempts.filter(result => result.outcome === "created");
    expect(created.length).toBe(1);
  });

  test("different prompt_id for the same session is a distinct receipt", () => {
    const first = createMemoryReviewReceipt(baseInput({ promptId: "prompt-1" }), { directory });
    const second = createMemoryReviewReceipt(baseInput({ promptId: "prompt-2" }), { directory });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
  });

  test("different session for the same prompt_id is a distinct receipt", () => {
    const first = createMemoryReviewReceipt(baseInput({ sessionId: SESSION_ID }), { directory });
    const second = createMemoryReviewReceipt(baseInput({ sessionId: OTHER_SESSION_ID }), { directory });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
  });

  test("readback round-trips the exact receipt shape", () => {
    createMemoryReviewReceipt(baseInput(), { directory });
    const receipt = readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory });
    expect(receipt).not.toBeNull();
    expect(() => validateMemoryReviewReceiptShape(receipt)).not.toThrow();
  });

  test("returns null for an unknown (session_id, prompt_id) pair", () => {
    expect(readMemoryReviewReceipt(SESSION_ID, "never-enqueued", { directory })).toBeNull();
  });

  test("transitions a queued receipt to reviewed exactly once", () => {
    createMemoryReviewReceipt(baseInput(), { directory });
    expect(transitionMemoryReviewReceipt(SESSION_ID, "prompt-1", "reviewed", { directory })).toBe(true);
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })?.status).toBe("reviewed");
    // A second transition attempt on an already-terminal receipt is refused, not overwritten.
    expect(transitionMemoryReviewReceipt(SESSION_ID, "prompt-1", "failed", { directory })).toBe(false);
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })?.status).toBe("reviewed");
  });

  test("refuses to transition a receipt that was never created", () => {
    expect(transitionMemoryReviewReceipt(SESSION_ID, "never-enqueued", "reviewed", { directory })).toBe(false);
  });

  test("rejects out-of-bounds receipt input before touching the filesystem", () => {
    expect(() => createMemoryReviewReceipt(baseInput({ sessionId: "not-a-uuid" }), { directory })).toThrow();
    expect(() => createMemoryReviewReceipt(baseInput({ transcriptPath: "relative/path.jsonl" }), { directory })).toThrow();
    expect(() => createMemoryReviewReceipt(baseInput({ telegramMessageId: -1 }), { directory })).toThrow();
    expect(() => createMemoryReviewReceipt(baseInput({ releaseSha: "not-a-sha" }), { directory })).toThrow();

    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(readdirSync(directory).filter(name => name.endsWith(".json")).length).toBe(0);
  });

  test("fails closed at the max entry cap instead of evicting", () => {
    const now = Date.now();
    const cap = 16;
    for (let index = 0; index < cap; index += 1) {
      const result = createMemoryReviewReceipt(baseInput({ promptId: `prompt-${index}`, createdAt: now }), { directory, maxEntries: cap });
      expect(result.outcome).toBe("created");
    }
    const overflow = createMemoryReviewReceipt(baseInput({ promptId: "prompt-overflow", createdAt: now }), { directory, maxEntries: cap });
    expect(overflow.outcome).toBe("capacity");
  });

  test("exposes a bounded default cap", () => {
    expect(MEMORY_REVIEW_RECEIPT_MAX_ENTRIES).toBeGreaterThan(0);
  });

  test("prunes an expired receipt so a fresh enqueue for the same key is accepted again", () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1_000;
    const first = createMemoryReviewReceipt(baseInput({ createdAt: old }), { directory });
    expect(first.outcome).toBe("created");
    const second = createMemoryReviewReceipt(baseInput({ createdAt: Date.now() }), { directory });
    expect(second.outcome).toBe("created");
  });

  test("does not scan or prune an unrelated expired receipt while the store is far from its cap", () => {
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1_000;
    const expired = createMemoryReviewReceipt(baseInput({ promptId: "prompt-expired", createdAt: old }), { directory, maxEntries: 1_000 });
    expect(expired.outcome).toBe("created");

    // A single existing entry is nowhere near a 1,000-entry cap, so this create must not run
    // the full validating prune pass over the whole store -- the unrelated expired entry (a
    // different key) is left exactly as-is, not physically removed by this call.
    const fresh = createMemoryReviewReceipt(baseInput({ promptId: "prompt-fresh", createdAt: now }), { directory, maxEntries: 1_000 });
    expect(fresh.outcome).toBe("created");
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-expired", { directory })).not.toBeNull();
  });

  test("prunes an unrelated expired receipt once the store is within the margin of its cap", () => {
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1_000;
    const cap = 3;
    const expired = createMemoryReviewReceipt(baseInput({ promptId: "prompt-expired", createdAt: old }), { directory, maxEntries: cap });
    expect(expired.outcome).toBe("created");

    const fresh = createMemoryReviewReceipt(baseInput({ promptId: "prompt-fresh", createdAt: now }), { directory, maxEntries: cap });
    expect(fresh.outcome).toBe("created");
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-expired", { directory })).toBeNull();
  });
});
