import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryReviewProposalRecord,
  createMemoryReviewReceipt,
  observeNativeMemory,
  readLearningDelta,
  recordMemoryObservation,
  transitionMemoryReviewReceipt,
} from "@project-tharsis/claude-code-telegram-shared";
import { handleMemoryApplyCommand } from "../src/memory-apply-command.js";

const SESSION = "77777777-7777-4777-8777-777777777777";
const RELEASE = "a".repeat(40);

describe("memory apply Stop command", () => {
  let root: string;
  let memory: string;
  let receipts: string;
  let proposals: string;
  let observer: string;
  let state: string;
  let delta: string;
  let settings: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-apply-command-"));
    memory = join(root, "memory");
    receipts = join(root, "receipts");
    proposals = join(root, "proposals");
    observer = join(root, "observer");
    state = join(root, "applier");
    delta = join(root, "delta");
    settings = join(root, "settings.json");
    mkdirSync(memory, { mode: 0o755 });
    writeFileSync(join(memory, "MEMORY.md"), "# Memory\n", { mode: 0o644 });
    writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: memory }), { mode: 0o600 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function seedReviewedProposal(): void {
    const observation = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE, now: 1_000 });
    recordMemoryObservation(observation, { directory: observer });
    const snapshotSha = "b".repeat(64);
    const assistantSha = "c".repeat(64);
    createMemoryReviewReceipt({
      sessionId: SESSION,
      promptId: "proposal-1",
      lastAssistantMessageSha256: assistantSha,
      snapshotSha256: snapshotSha,
      transcriptPath: `/tmp/${SESSION}.jsonl`,
      telegramMessageId: 5,
      releaseSha: RELEASE,
      toolIterations: 0,
      createdAt: 1_000,
    }, { directory: receipts });
    transitionMemoryReviewReceipt(SESSION, "proposal-1", "reviewed", { directory: receipts });
    createMemoryReviewProposalRecord({
      sessionId: SESSION,
      promptId: "proposal-1",
      releaseSha: RELEASE,
      lastAssistantMessageSha256: assistantSha,
      nativeMemoryWatermark: observation.watermark,
      snapshotSha256: snapshotSha,
      proposal: {
        decision: "create",
        target: "managed_memory",
        topic: "concise-replies",
        evidence: ["explicit correction"],
        content: "Keep replies concise.",
        reason: "stable preference",
        freshness: "standing",
      },
    }, { directory: proposals, now: () => 1_000 });
  }

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      hook_event_name: "Stop",
      session_id: SESSION,
      prompt_id: "current-turn",
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
      ...overrides,
    };
  }

  test("applies at most one reviewed proposal and emits one-shot delta", async () => {
    seedReviewedProposal();
    const result = await handleMemoryApplyCommand(payload(), {
      enabled: true,
      deltaEnabled: true,
      releaseSha: RELEASE,
      settingsPath: settings,
      receiptDirectory: receipts,
      proposalDirectory: proposals,
      observerLedgerDirectory: observer,
      stateDirectory: state,
      deltaDirectory: delta,
      now: () => 2_000,
    });
    expect(result).toBe("applied");
    expect(readFileSync(join(memory, "concise-replies.md"), "utf8")).toBe("Keep replies concise.\n");
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toContain("concise-replies");
    expect(readLearningDelta(SESSION, { directory: delta })?.topics).toEqual(["concise-replies"]);

    expect(await handleMemoryApplyCommand(payload(), {
      enabled: true,
      releaseSha: RELEASE,
      settingsPath: settings,
      receiptDirectory: receipts,
      proposalDirectory: proposals,
      observerLedgerDirectory: observer,
      stateDirectory: state,
      now: () => 2_001,
    })).toBe("no_op");
  });

  test("re-emits a missed delta from already-applied ownership without duplicating memory", async () => {
    seedReviewedProposal();
    const blockedDelta = join(root, "blocked-delta");
    writeFileSync(blockedDelta, "not a directory", { mode: 0o600 });
    const shared = {
      enabled: true,
      deltaEnabled: true,
      releaseSha: RELEASE,
      settingsPath: settings,
      receiptDirectory: receipts,
      proposalDirectory: proposals,
      observerLedgerDirectory: observer,
      stateDirectory: state,
      deltaDirectory: blockedDelta,
      now: () => 2_000,
    };
    await expect(handleMemoryApplyCommand(payload(), shared)).rejects.toThrow();
    expect(readFileSync(join(memory, "concise-replies.md"), "utf8")).toBe("Keep replies concise.\n");
    rmSync(blockedDelta);
    expect(await handleMemoryApplyCommand(payload(), shared)).toBe("no_op");
    expect(readLearningDelta(SESSION, { directory: blockedDelta })?.receipt_id).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8").match(/concise-replies/g)).toHaveLength(2);
  });

  test("is dormant and fails closed without exact idle arrays", async () => {
    seedReviewedProposal();
    expect(await handleMemoryApplyCommand(payload(), { enabled: false })).toBe("no_op");
    expect(await handleMemoryApplyCommand(payload({ background_tasks: undefined }), {
      enabled: true,
      releaseSha: RELEASE,
      settingsPath: settings,
    })).toBe("no_op");
    expect(() => readFileSync(join(memory, "concise-replies.md"))).toThrow();
  });
});
