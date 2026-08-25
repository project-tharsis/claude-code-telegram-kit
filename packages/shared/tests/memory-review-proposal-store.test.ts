import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireMemoryReviewProposalClaim,
  createMemoryReviewProposalRecord,
  memoryReviewProposalKey,
  readMemoryReviewProposalRecord
} from "../src/memory-review-proposal-store.js";

const SESSION_ID = "88888888-8888-4888-8888-888888888888";
const PROMPT_ID = "prompt-1";
const RELEASE_SHA = "a".repeat(40);
const MEMORY_WATERMARK = "b".repeat(64);

function input(content = "User prefers concise answers.") {
  return {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    releaseSha: RELEASE_SHA,
    lastAssistantMessageSha256: "c".repeat(64),
    nativeMemoryWatermark: MEMORY_WATERMARK,
    proposal: {
      decision: "create" as const,
      target: "managed_memory" as const,
      topic: "concise-replies",
      evidence: ["explicit request"],
      content,
      reason: "stable preference",
      freshness: "standing" as const
    }
  };
}

describe("durable memory review proposal store", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-review-proposals-"));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("creates one immutable bound proposal with exact 0600 readback", () => {
    const created = createMemoryReviewProposalRecord(input(), { directory, now: () => 1_000 });
    expect(created.outcome).toBe("created");
    expect(created.record).toMatchObject({
      schema: 1,
      session_id: SESSION_ID,
      prompt_id: PROMPT_ID,
      release_sha: RELEASE_SHA,
      last_assistant_message_sha256: "c".repeat(64),
      native_memory_watermark: MEMORY_WATERMARK,
      created_at: 1_000
    });
    expect(created.record.proposal_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readMemoryReviewProposalRecord(SESSION_ID, PROMPT_ID, { directory })).toEqual(created.record);
    const leaf = join(directory, `${memoryReviewProposalKey(SESSION_ID, PROMPT_ID)}.json`);
    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
    expect(lstatSync(leaf).mode & 0o7777).toBe(0o600);
    expect(JSON.parse(readFileSync(leaf, "utf8"))).toEqual(created.record);
  });

  test("same proposal is idempotent while a conflicting second proposal is rejected", () => {
    const first = createMemoryReviewProposalRecord(input(), { directory, now: () => 1_000 });
    const duplicate = createMemoryReviewProposalRecord(input(), { directory, now: () => 2_000 });
    expect(duplicate.outcome).toBe("existing");
    expect(duplicate.record).toEqual(first.record);
    expect(() => createMemoryReviewProposalRecord(input("Different content."), { directory, now: () => 3_000 }))
      .toThrow("proposal conflict");
  });

  test("rejects malformed identity, invalid watermark, and out-of-schema proposals before writing", () => {
    expect(() => createMemoryReviewProposalRecord({ ...input(), sessionId: "../../etc/passwd" }, { directory })).toThrow();
    expect(() => createMemoryReviewProposalRecord({ ...input(), nativeMemoryWatermark: "bad" }, { directory })).toThrow();
    expect(() => createMemoryReviewProposalRecord({
      ...input(),
      proposal: { ...input().proposal, target: "arbitrary_path" as never }
    }, { directory })).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });

  test("singleflights reviewer claims and recovers a dead owner", () => {
    const first = acquireMemoryReviewProposalClaim(SESSION_ID, "prompt-1", { directory });
    expect(first.outcome).toBe("claimed");
    const duplicate = acquireMemoryReviewProposalClaim(SESSION_ID, "prompt-1", { directory });
    expect(duplicate.outcome).toBe("busy");
    if (first.outcome !== "claimed") throw new Error("unreachable");
    first.release();

    const key = memoryReviewProposalKey(SESSION_ID, "prompt-1");
    writeFileSync(join(directory, `${key}.claim`), JSON.stringify({ schema: 1, pid: 99_999_999, start_ticks: "1" }), { mode: 0o600 });
    const recovered = acquireMemoryReviewProposalClaim(SESSION_ID, "prompt-1", { directory });
    expect(recovered.outcome).toBe("claimed");
    if (recovered.outcome !== "claimed") throw new Error("unreachable");
    recovered.release();
  });

  test("fails closed on symlinked, hardlinked, or writable proposal leaves", () => {
    createMemoryReviewProposalRecord(input(), { directory });
    const leaf = join(directory, `${memoryReviewProposalKey(SESSION_ID, PROMPT_ID)}.json`);
    const backup = join(directory, "backup.json");

    rmSync(leaf);
    symlinkSync(backup, leaf);
    expect(() => readMemoryReviewProposalRecord(SESSION_ID, PROMPT_ID, { directory })).toThrow("unsafe proposal");
    rmSync(leaf);

    createMemoryReviewProposalRecord(input(), { directory });
    linkSync(leaf, backup);
    expect(() => readMemoryReviewProposalRecord(SESSION_ID, PROMPT_ID, { directory })).toThrow("unsafe proposal");
    rmSync(backup);

    chmodSync(leaf, 0o660);
    expect(() => readMemoryReviewProposalRecord(SESSION_ID, PROMPT_ID, { directory })).toThrow("unsafe proposal");
  });

  test("enforces the store cap without deleting live proposals", () => {
    createMemoryReviewProposalRecord(input(), { directory, maxEntries: 1 });
    expect(() => createMemoryReviewProposalRecord({ ...input(), promptId: "prompt-2" }, { directory, maxEntries: 1 }))
      .toThrow("proposal store capacity exceeded");
    expect(readMemoryReviewProposalRecord(SESSION_ID, PROMPT_ID, { directory })?.proposal.content)
      .toBe("User prefers concise answers.");
  });
});
