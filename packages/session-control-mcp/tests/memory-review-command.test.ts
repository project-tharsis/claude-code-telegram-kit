import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryReviewReceipt } from "@project-tharsis/claude-code-telegram-shared";
import { handleMemoryReviewCommand, type MemoryReviewCommandOptions } from "../src/memory-review-command.js";
import { readMemoryReviewSnapshot } from "../src/memory-review-snapshot-store.js";
import { parseSnapshotFromStdin } from "../src/memory-review-worker.js";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const RELEASE_SHA = "f".repeat(40);

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    hook_event_name: "Stop",
    session_id: SESSION_ID,
    prompt_id: "prompt-1",
    cwd: "/srv/claude-bot",
    transcript_path: `/srv/sessions/${SESSION_ID}.jsonl`,
    last_assistant_message: "Understood.",
    ...overrides
  };
}

describe("memory review Stop-hook enqueue seam", () => {
  let directory: string;
  let snapshotDirectory: string;
  let previousEnabled: string | undefined;
  let previousCadence: string | undefined;

  function baseOptions(overrides: MemoryReviewCommandOptions = {}): MemoryReviewCommandOptions {
    return {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      snapshotDirectory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      deliveryOutcome: "delivered",
      userCorrection: true,
      ...overrides
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-review-command-"));
    snapshotDirectory = mkdtempSync(join(tmpdir(), "memory-review-command-snapshots-"));
    previousEnabled = process.env.MEMORY_REVIEW_ENABLED;
    previousCadence = process.env.MEMORY_REVIEW_CADENCE_TURNS;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(snapshotDirectory, { recursive: true, force: true });
    if (previousEnabled === undefined) delete process.env.MEMORY_REVIEW_ENABLED; else process.env.MEMORY_REVIEW_ENABLED = previousEnabled;
    if (previousCadence === undefined) delete process.env.MEMORY_REVIEW_CADENCE_TURNS; else process.env.MEMORY_REVIEW_CADENCE_TURNS = previousCadence;
  });

  test("is a no-op with the production default (MEMORY_REVIEW_ENABLED unset)", async () => {
    delete process.env.MEMORY_REVIEW_ENABLED;
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload(), baseOptions({
      schedule: async () => { scheduled = true; }
    }));
    expect(scheduled).toBe(false);
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })).toBeNull();
  });

  test("ignores every non-Stop hook event even when enabled", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload({ hook_event_name: "UserPromptSubmit" }), baseOptions({
      schedule: async () => { scheduled = true; }
    }));
    expect(scheduled).toBe(false);
  });

  test("enqueues and schedules exactly once when enabled and a correction signal is present", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const scheduledCalls: unknown[] = [];
    await handleMemoryReviewCommand(basePayload(), baseOptions({
      schedule: async (sessionId, promptId) => { scheduledCalls.push([sessionId, promptId]); }
    }));
    expect(scheduledCalls).toEqual([[SESSION_ID, "prompt-1"]]);
    const receipt = readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory });
    expect(receipt?.status).toBe("queued");
    expect(receipt?.telegram_message_id).toBe(5);
  });

  test("does not enqueue when no real delivery-confirmed signal is supplied (fails closed, never defaults to delivered)", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    const { deliveryOutcome: _omit, ...withoutDeliveryOutcome } = baseOptions({
      schedule: async () => { scheduled = true; }
    });
    await handleMemoryReviewCommand(basePayload(), withoutDeliveryOutcome);
    expect(scheduled).toBe(false);
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })).toBeNull();
  });

  test("does not enqueue when delivery is rejected, uncertain, or too_large", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    for (const outcome of ["rejected", "uncertain", "too_large"] as const) {
      let scheduled = false;
      await handleMemoryReviewCommand(basePayload({ prompt_id: `prompt-${outcome}` }), baseOptions({
        deliveryOutcome: outcome,
        schedule: async () => { scheduled = true; }
      }));
      expect(scheduled).toBe(false);
    }
  });

  test("writes the real bounded snapshot before scheduling, and it round-trips through the real stdin reader", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduledBeforeSnapshotWritten: boolean | undefined;
    await handleMemoryReviewCommand(basePayload(), baseOptions({
      userMessage: "please remember I prefer concise replies",
      currentMemoryIndex: "- no-em-dash.md",
      schedule: async () => {
        // The snapshot must already be durably written by the time scheduling happens, since
        // the scheduled job can run at any point after this call returns.
        scheduledBeforeSnapshotWritten = readMemoryReviewSnapshot(SESSION_ID, "prompt-1", { directory: snapshotDirectory }) !== null;
      }
    }));
    expect(scheduledBeforeSnapshotWritten).toBe(true);
    const bytes = readMemoryReviewSnapshot(SESSION_ID, "prompt-1", { directory: snapshotDirectory });
    expect(bytes).not.toBeNull();
    const snapshot = parseSnapshotFromStdin(bytes as Buffer);
    expect(snapshot.userMessage).toBe("please remember I prefer concise replies");
    expect(snapshot.assistantFinal).toBe("Understood.");
    expect(snapshot.currentMemoryIndex).toBe("- no-em-dash.md");
    expect(snapshot.releaseSha).toBe(RELEASE_SHA);
  });

  test("a duplicate Stop for the same (session_id, prompt_id) schedules at most once", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const scheduledCalls: unknown[] = [];
    const run = () => handleMemoryReviewCommand(basePayload(), baseOptions({
      schedule: async (sessionId, promptId) => { scheduledCalls.push([sessionId, promptId]); }
    }));
    await run();
    await run();
    expect(scheduledCalls.length).toBe(1);
  });

  test("does not enqueue while a background task is still active", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload({ background_tasks: [{ id: "t1" }] }), baseOptions({
      schedule: async () => { scheduled = true; }
    }));
    expect(scheduled).toBe(false);
  });

  test("does not enqueue an ordinary smooth turn with no correction or cadence signal", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload(), baseOptions({
      userCorrection: false,
      turnOrdinal: 1,
      schedule: async () => { scheduled = true; }
    }));
    expect(scheduled).toBe(false);
  });

  test("rejects a transcript path outside the configured sessions directory", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    await expect(handleMemoryReviewCommand(basePayload({ transcript_path: "/tmp/evil/" + SESSION_ID + ".jsonl" }), baseOptions()))
      .rejects.toThrow("transcript authority mismatch");
  });
});
