import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExplicitMemoryCorrection,
  persistMemoryDeliveryEvidence,
  readMemoryDeliveryEvidence,
} from "../src/memory-delivery-evidence.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const RELEASE = "a".repeat(40);

function input(promptId = "prompt-1", userMessage = "请记住以后不要使用破折号") {
  return {
    sessionId: SESSION,
    promptId,
    sourceMessageId: 7,
    deliveredMessageIds: [8, 9],
    assistantMessage: "明白。",
    releaseSha: RELEASE,
    observedAt: 1_000,
    userMessage,
    toolIterations: 2,
  };
}

describe("verified foreground delivery evidence", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "memory-delivery-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("persists exact bound evidence with redaction, correction signal, modes, and ordinal", () => {
    const first = persistMemoryDeliveryEvidence(input(), { directory });
    expect(first).toMatchObject({
      outcome: "delivered",
      foreground: true,
      source_message_id: 7,
      delivered_message_ids: [8, 9],
      turn_ordinal: 1,
      user_correction: true,
      tool_iterations: 2,
    });
    expect(first.assistant_message_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readMemoryDeliveryEvidence(SESSION, "prompt-1", { directory, now: () => 1_000 })).toEqual(first);
    const second = persistMemoryDeliveryEvidence(input("prompt-2", "ordinary question"), { directory });
    expect(second.turn_ordinal).toBe(2);
    expect(second.user_correction).toBe(false);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
      expect(lstatSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
  });

  test("is idempotent for the same binding and rejects conflicting replay", () => {
    const first = persistMemoryDeliveryEvidence(input(), { directory });
    expect(persistMemoryDeliveryEvidence(input(), { directory })).toEqual(first);
    expect(() => persistMemoryDeliveryEvidence({ ...input(), assistantMessage: "different" }, { directory }))
      .toThrow("conflict");
  });

  test("redacts credential-shaped prompt text before persistence", () => {
    const record = persistMemoryDeliveryEvidence(input("prompt-1", "token: sk-live-abcdefghijklmnop remember this"), { directory });
    expect(record.user_message).not.toContain("sk-live-abcdefghijklmnop");
  });

  test("expires old evidence by TTL and prunes it on the next persisted delivery", () => {
    persistMemoryDeliveryEvidence(input("old"), { directory });
    const future = 8 * 24 * 60 * 60 * 1_000;
    persistMemoryDeliveryEvidence({ ...input("new"), observedAt: future }, { directory });
    expect(readMemoryDeliveryEvidence(SESSION, "old", { directory, now: () => future })).toBeNull();
    expect(readdirSync(directory).filter(name => name.endsWith(".delivery.json"))).toHaveLength(1);
  });

  test("fails closed on symlinked, hardlinked, or writable evidence", () => {
    persistMemoryDeliveryEvidence(input(), { directory });
    const leaf = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    const backup = join(directory, "backup");
    linkSync(leaf, backup);
    expect(() => readMemoryDeliveryEvidence(SESSION, "prompt-1", { directory })).toThrow("unsafe");
    rmSync(backup);
    chmodSync(leaf, 0o660);
    expect(() => readMemoryDeliveryEvidence(SESSION, "prompt-1", { directory })).toThrow("unsafe");
    chmodSync(leaf, 0o600);
    rmSync(leaf);
    symlinkSync("/etc/passwd", leaf);
    expect(() => readMemoryDeliveryEvidence(SESSION, "prompt-1", { directory })).toThrow("unsafe");
  });

  test("uses a conservative explicit-correction classifier", () => {
    expect(isExplicitMemoryCorrection("以后不要这样写")).toBe(true);
    expect(isExplicitMemoryCorrection("what is the weather")).toBe(false);
  });
});
