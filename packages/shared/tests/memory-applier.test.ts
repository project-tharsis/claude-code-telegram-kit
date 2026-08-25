import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMemoryReviewProposal,
  readManagedMemoryLedger,
  recoverMemoryReviewApplier,
  type ApplyMemoryReviewProposalOptions,
  type MemoryIdleProof,
} from "../src/memory-applier.js";
import {
  createMemoryReviewProposalRecord,
  createMemoryReviewReceipt,
  observeNativeMemory,
  readMemoryReviewReceipt,
  transitionMemoryReviewReceipt,
  type MemoryReviewProposalRecord,
  type MemoryReviewReceipt,
  type NativeMemoryObservation,
} from "../src/index.js";

const RELEASE_SHA = "a".repeat(40);
const SESSION_ID = "88888888-8888-4888-8888-888888888888";
const SNAPSHOT_SHA = "b".repeat(64);
const ASSISTANT_SHA = "c".repeat(64);
const NOW = 10_000;

function digest(bytes: Buffer | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("dormant memory review CAS applier", () => {
  let root: string;
  let memory: string;
  let state: string;
  let proposals: string;
  let receipts: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-applier-"));
    memory = join(root, "native");
    state = join(root, "state", "apply");
    proposals = join(root, "state", "proposals");
    receipts = join(root, "state", "receipts");
    mkdirSync(memory, { mode: 0o755 });
    writeFileSync(join(memory, "MEMORY.md"), "# Memory\n", { mode: 0o644 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function observe(now = 9_000): NativeMemoryObservation {
    return observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, now });
  }

  function idleProof(promptId = "idle-turn", sessionId = SESSION_ID): MemoryIdleProof {
    return {
      schema: 1,
      session_id: sessionId,
      prompt_id: promptId,
      observed_at: NOW,
      background_tasks: [],
      session_crons: [],
      stop_hook_active: false,
    };
  }

  function authority(
    decision: "create" | "patch",
    content: string,
    observation: NativeMemoryObservation,
    promptId = "proposal-1",
  ): { proposalRecord: MemoryReviewProposalRecord; receipt: MemoryReviewReceipt } {
    const proposalRecord = createMemoryReviewProposalRecord({
      sessionId: SESSION_ID,
      promptId,
      releaseSha: RELEASE_SHA,
      lastAssistantMessageSha256: ASSISTANT_SHA,
      nativeMemoryWatermark: observation.watermark,
      snapshotSha256: SNAPSHOT_SHA,
      proposal: {
        decision,
        target: "managed_memory",
        topic: "concise-replies",
        evidence: ["explicit request"],
        content,
        reason: "stable preference",
        freshness: "standing",
      },
    }, { directory: proposals, now: () => observation.observed_at }).record;
    createMemoryReviewReceipt({
      sessionId: SESSION_ID,
      promptId,
      lastAssistantMessageSha256: ASSISTANT_SHA,
      snapshotSha256: SNAPSHOT_SHA,
      transcriptPath: join(root, `${SESSION_ID}.jsonl`),
      telegramMessageId: 7,
      releaseSha: RELEASE_SHA,
      toolIterations: 1,
      createdAt: observation.observed_at,
    }, { directory: receipts });
    transitionMemoryReviewReceipt(SESSION_ID, promptId, "reviewed", { directory: receipts });
    return {
      proposalRecord,
      receipt: readMemoryReviewReceipt(SESSION_ID, promptId, { directory: receipts })!,
    };
  }

  function options(
    decision: "create" | "patch",
    content: string,
    observation = observe(),
    promptId = "proposal-1",
  ): ApplyMemoryReviewProposalOptions {
    const bound = authority(decision, content, observation, promptId);
    return {
      enabled: true,
      releaseSha: RELEASE_SHA,
      proposalRecord: bound.proposalRecord,
      receipt: bound.receipt,
      observation,
      idleProof: idleProof(),
      stateDirectory: state,
      proposalDirectory: proposals,
      now: NOW,
    };
  }

  test("is production-disabled without creating state or touching native memory", () => {
    const observation = observe();
    const bound = authority("create", "hello", observation);
    const before = readFileSync(join(memory, "MEMORY.md"));
    const result = applyMemoryReviewProposal({
      releaseSha: RELEASE_SHA,
      proposalRecord: bound.proposalRecord,
      receipt: bound.receipt,
      observation,
      idleProof: idleProof(),
      stateDirectory: state,
      proposalDirectory: proposals,
      now: NOW,
    });
    expect(result).toEqual({ outcome: "disabled" });
    expect(readFileSync(join(memory, "MEMORY.md"))).toEqual(before);
    expect(() => lstatSync(state)).toThrow();
  });

  test("requires a fresh exact idle proof with no tasks, crons, or re-entrant Stop", () => {
    for (const proof of [
      { ...idleProof(), background_tasks: [{ id: "task-1" }] },
      { ...idleProof(), session_crons: [{ id: "cron-1" }] },
      { ...idleProof(), stop_hook_active: true },
      { ...idleProof(), observed_at: NOW - 31_000 },
      { ...idleProof(), background_tasks: undefined as unknown as unknown[] },
    ]) {
      expect(applyMemoryReviewProposal({ ...options("create", "hello"), idleProof: proof })).toMatchObject({
        outcome: "rejected",
        reason: "idle_proof_mismatch",
      });
    }
    expect(() => lstatSync(state)).toThrow();
  });

  test("creates topic and MEMORY.md index under exact CAS and records ownership", () => {
    const result = applyMemoryReviewProposal(options("create", "hello"));
    expect(result.outcome).toBe("applied");
    expect(readFileSync(join(memory, "concise-replies.md"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe(
      "# Memory\n- [concise-replies](concise-replies.md)\n",
    );
    expect(readManagedMemoryLedger({ directory: state })).toMatchObject({
      schema: 1,
      entries: [{ path: "concise-replies.md", owner: "memory_review_applier" }],
    });
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(state, "managed-ownership.json")).mode & 0o777).toBe(0o600);
  });

  test("replays an already-applied proposal idempotently without duplicating the index", () => {
    const same = options("create", "hello");
    expect(applyMemoryReviewProposal(same)).toMatchObject({ outcome: "applied" });
    const indexBefore = readFileSync(join(memory, "MEMORY.md"));
    expect(applyMemoryReviewProposal(same)).toMatchObject({ outcome: "already_applied" });
    expect(readFileSync(join(memory, "MEMORY.md"))).toEqual(indexBefore);
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8").match(/concise-replies/g)).toHaveLength(2);
    writeFileSync(join(memory, "MEMORY.md"), "external index\n", { mode: 0o644 });
    expect(applyMemoryReviewProposal(same)).toEqual({ outcome: "rejected", reason: "observation_stale" });
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("external index\n");
  });

  test("fails closed for missing/symlinked roots and unsafe native leaves", () => {
    const good = options("create", "hello");
    rmSync(memory, { recursive: true });
    expect(applyMemoryReviewProposal(good)).toMatchObject({ outcome: "rejected" });
    expect(() => lstatSync(memory)).toThrow();

    mkdirSync(memory, { mode: 0o755 });
    writeFileSync(join(root, "outside.md"), "outside\n", { mode: 0o644 });
    symlinkSync(join(root, "outside.md"), join(memory, "MEMORY.md"));
    const symlinkObservation = { ...good.observation, memoryDirectory: memory };
    expect(applyMemoryReviewProposal({ ...good, observation: symlinkObservation })).toMatchObject({
      outcome: "rejected",
    });

    rmSync(join(memory, "MEMORY.md"));
    writeFileSync(join(memory, "MEMORY.md"), "# Memory\n", { mode: 0o644 });
    writeFileSync(join(memory, "concise-replies.md"), "native\n", { mode: 0o644 });
    const hardlinkObservation = observe();
    linkSync(join(memory, "concise-replies.md"), join(root, "hardlink.md"));
    const hardlinkBound = authority("patch", "unsafe", hardlinkObservation, "proposal-hardlink");
    expect(applyMemoryReviewProposal({
      ...good,
      proposalRecord: hardlinkBound.proposalRecord,
      receipt: hardlinkBound.receipt,
      observation: hardlinkObservation,
    })).toMatchObject({ outcome: "rejected" });
  });

  test("patches only an applier-owned topic whose current hash matches observation", () => {
    expect(applyMemoryReviewProposal(options("create", "before"))).toMatchObject({ outcome: "applied" });
    const current = observe(9_500);
    const second = applyMemoryReviewProposal(options("patch", "after", current, "proposal-2"));
    expect(second).toMatchObject({ outcome: "applied" });
    expect(readFileSync(join(memory, "concise-replies.md"), "utf8")).toBe("after\n");

    writeFileSync(join(memory, "concise-replies.md"), "external\n", { mode: 0o644 });
    const stale = applyMemoryReviewProposal(options("patch", "must not land", current, "proposal-3"));
    expect(stale).toMatchObject({ outcome: "rejected" });
    expect(readFileSync(join(memory, "concise-replies.md"), "utf8")).toBe("external\n");
  });

  test("rejects an unowned native topic and any unrelated inventory drift", () => {
    writeFileSync(join(memory, "concise-replies.md"), "native\n", { mode: 0o644 });
    const current = observe();
    expect(applyMemoryReviewProposal(options("patch", "unsafe", current))).toMatchObject({
      outcome: "rejected",
      reason: "unmanaged_topic",
    });

    rmSync(join(memory, "concise-replies.md"));
    const baseline = observe();
    writeFileSync(join(memory, "other.md"), "drift\n", { mode: 0o644 });
    expect(applyMemoryReviewProposal(options("create", "unsafe", baseline, "proposal-drift"))).toMatchObject({
      outcome: "rejected",
      reason: "observation_stale",
    });
  });

  test("crash recovery restores both topic and index when current bytes are ours", () => {
    const first = applyMemoryReviewProposal({ ...options("create", "exact"), crashAfter: "index" });
    expect(first.outcome).toBe("crashed");
    expect(readFileSync(join(memory, "concise-replies.md"), "utf8")).toBe("exact\n");
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toContain("concise-replies");

    const otherMemory = join(root, "other-native");
    mkdirSync(otherMemory, { mode: 0o755 });
    writeFileSync(join(otherMemory, "MEMORY.md"), "other authority\n", { mode: 0o644 });
    expect(recoverMemoryReviewApplier({
      releaseSha: RELEASE_SHA,
      memoryDirectory: otherMemory,
      directorySha256: digest(otherMemory),
      idleProof: idleProof("recovery-turn"),
      stateDirectory: state,
      proposalDirectory: proposals,
      now: NOW + 1,
    })).toMatchObject({ outcome: "rollback_conflict" });
    expect(readFileSync(join(otherMemory, "MEMORY.md"), "utf8")).toBe("other authority\n");

    const recovered = recoverMemoryReviewApplier({
      releaseSha: RELEASE_SHA,
      memoryDirectory: memory,
      directorySha256: digest(memory),
      idleProof: idleProof("recovery-turn", "99999999-9999-4999-8999-999999999999"),
      stateDirectory: state,
      proposalDirectory: proposals,
      now: NOW + 1,
    });
    expect(recovered).toEqual({ outcome: "recovered", rolled_back: 1, conflicts: 0 });
    expect(() => readFileSync(join(memory, "concise-replies.md"))).toThrow();
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("# Memory\n");
  });

  test("rollback preserves external bytes and reports conflict after a partial crash", () => {
    const first = applyMemoryReviewProposal({ ...options("create", "exact"), crashAfter: "topic" });
    expect(first.outcome).toBe("crashed");
    writeFileSync(join(memory, "MEMORY.md"), "external index\n", { mode: 0o644 });

    const recovered = recoverMemoryReviewApplier({
      releaseSha: RELEASE_SHA,
      memoryDirectory: memory,
      directorySha256: digest(memory),
      idleProof: idleProof("recovery-turn"),
      stateDirectory: state,
      proposalDirectory: proposals,
      now: NOW + 1,
    });
    expect(recovered).toEqual({ outcome: "rollback_conflict", rolled_back: 0, conflicts: 1 });
    expect(() => readFileSync(join(memory, "concise-replies.md"))).toThrow();
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("external index\n");
    expect(readdirSync(state).some(name => name.endsWith(".apply.json"))).toBe(true);
  });

  test("in-process index CAS conflict rolls topic back without clobbering external index", () => {
    const result = applyMemoryReviewProposal({
      ...options("create", "exact"),
      beforeWrite: (path: string) => {
        if (path === "MEMORY.md") {
          writeFileSync(join(memory, "MEMORY.md"), "concurrent index\n", { mode: 0o644 });
        }
      },
    });
    expect(result).toMatchObject({ outcome: "rollback_conflict" });
    expect(() => readFileSync(join(memory, "concise-replies.md"))).toThrow();
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("concurrent index\n");
  });

  test("rejects state inside native memory", () => {
    const result = applyMemoryReviewProposal({
      ...options("create", "hello"),
      stateDirectory: join(memory, ".state"),
    });
    expect(result).toEqual({ outcome: "rejected", reason: "state_inside_native_memory" });
    expect(() => lstatSync(join(memory, ".state"))).toThrow();
    const proposalResult = applyMemoryReviewProposal({
      ...options("create", "hello", observe(), "proposal-inside"),
      proposalDirectory: join(memory, ".proposals"),
    });
    expect(proposalResult).toEqual({ outcome: "rejected", reason: "state_inside_native_memory" });
    expect(() => lstatSync(join(memory, ".proposals"))).toThrow();
  });
});
