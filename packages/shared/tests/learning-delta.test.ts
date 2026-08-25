import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeLearningDelta,
  formatLearningDeltaContext,
  readLearningDelta,
  writeLearningDelta,
} from "../src/learning-delta.js";

const SESSION = "22222222-2222-4222-8222-222222222222";
const RELEASE = "b".repeat(40);

function input() {
  return {
    receiptId: "c".repeat(64),
    sessionId: SESSION,
    releaseSha: RELEASE,
    topics: ["concise-replies"],
    summary: "Applied preference without exposing token: sk-live-abcdefghijklmnop",
    createdAt: 1_000,
  };
}

describe("one-shot learning delta", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "learning-delta-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("persists private redacted delta and consumes exactly once on the next direct user turn", () => {
    const written = writeLearningDelta(input(), { directory });
    expect(written.summary).not.toContain("sk-live-abcdefghijklmnop");
    expect(readLearningDelta(SESSION, { directory })).toEqual(written);
    expect(consumeLearningDelta({
      sessionId: SESSION,
      releaseSha: RELEASE,
      isDirectTelegram: false,
    }, { directory, now: () => 2_000 })).toBeNull();
    const consumed = consumeLearningDelta({
      sessionId: SESSION,
      releaseSha: RELEASE,
      isDirectTelegram: true,
    }, { directory, now: () => 2_000 });
    expect(consumed).toEqual(written);
    expect(formatLearningDeltaContext(consumed!)).toContain("Learning delta (one use");
    expect(readLearningDelta(SESSION, { directory })).toBeNull();
    expect(writeLearningDelta(input(), { directory }).status).toBe("consumed");
    expect(readLearningDelta(SESSION, { directory })).toBeNull();
    expect(writeLearningDelta({ ...input(), receiptId: "e".repeat(64) }, { directory }).status).toBe("pending");
  });

  test("does not consume on control/internal turns and removes stale release or TTL records", () => {
    writeLearningDelta(input(), { directory });
    expect(consumeLearningDelta({ sessionId: SESSION, releaseSha: RELEASE, isDirectTelegram: true, isControlCommand: true }, { directory, now: () => 2_000 })).toBeNull();
    expect(readLearningDelta(SESSION, { directory })).not.toBeNull();
    expect(consumeLearningDelta({ sessionId: SESSION, releaseSha: "0".repeat(40), isDirectTelegram: true }, { directory, now: () => 2_000 })).toBeNull();
    expect(readLearningDelta(SESSION, { directory })).toBeNull();

    writeLearningDelta({ ...input(), receiptId: "f".repeat(64) }, { directory });
    const expired = consumeLearningDelta(
      { sessionId: SESSION, releaseSha: RELEASE, isDirectTelegram: true },
      { directory, now: () => 90_000_000 },
    );
    expect(expired).toBeNull();
    expect(readLearningDelta(SESSION, { directory })).toBeNull();
  });

  test("uses 0700/0600 state and rejects writable leaves", () => {
    writeLearningDelta(input(), { directory });
    const leaf = join(directory, readdirSync(directory).find(name => name.endsWith(".delta.json"))!);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(leaf).mode & 0o777).toBe(0o600);
    chmodSync(leaf, 0o660);
    expect(() => readLearningDelta(SESSION, { directory })).toThrow("unsafe");
  });
});
