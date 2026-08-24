import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryReviewReceipt } from "@project-tharsis/claude-code-telegram-shared";
import { handleMemoryReviewCommand } from "../src/memory-review-command.js";

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
  let previousEnabled: string | undefined;
  let previousCadence: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-review-command-"));
    previousEnabled = process.env.MEMORY_REVIEW_ENABLED;
    previousCadence = process.env.MEMORY_REVIEW_CADENCE_TURNS;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    if (previousEnabled === undefined) delete process.env.MEMORY_REVIEW_ENABLED; else process.env.MEMORY_REVIEW_ENABLED = previousEnabled;
    if (previousCadence === undefined) delete process.env.MEMORY_REVIEW_CADENCE_TURNS; else process.env.MEMORY_REVIEW_CADENCE_TURNS = previousCadence;
  });

  test("is a no-op with the production default (MEMORY_REVIEW_ENABLED unset)", async () => {
    delete process.env.MEMORY_REVIEW_ENABLED;
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload(), {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      userCorrection: true,
      schedule: async () => { scheduled = true; }
    });
    expect(scheduled).toBe(false);
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })).toBeNull();
  });

  test("ignores every non-Stop hook event even when enabled", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload({ hook_event_name: "UserPromptSubmit" }), {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      userCorrection: true,
      schedule: async () => { scheduled = true; }
    });
    expect(scheduled).toBe(false);
  });

  test("enqueues and schedules exactly once when enabled and a correction signal is present", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const scheduledCalls: unknown[] = [];
    await handleMemoryReviewCommand(basePayload(), {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      userCorrection: true,
      schedule: async (sessionId, promptId) => { scheduledCalls.push([sessionId, promptId]); }
    });
    expect(scheduledCalls).toEqual([[SESSION_ID, "prompt-1"]]);
    const receipt = readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory });
    expect(receipt?.status).toBe("queued");
    expect(receipt?.telegram_message_id).toBe(5);
  });

  test("a duplicate Stop for the same (session_id, prompt_id) schedules at most once", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const scheduledCalls: unknown[] = [];
    const run = () => handleMemoryReviewCommand(basePayload(), {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      userCorrection: true,
      schedule: async (sessionId, promptId) => { scheduledCalls.push([sessionId, promptId]); }
    });
    await run();
    await run();
    expect(scheduledCalls.length).toBe(1);
  });

  test("does not enqueue while a background task is still active", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload({ background_tasks: [{ id: "t1" }] }), {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      userCorrection: true,
      schedule: async () => { scheduled = true; }
    });
    expect(scheduled).toBe(false);
  });

  test("does not enqueue an ordinary smooth turn with no correction or cadence signal", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload(), {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      userCorrection: false,
      turnOrdinal: 1,
      schedule: async () => { scheduled = true; }
    });
    expect(scheduled).toBe(false);
  });

  test("rejects a transcript path outside the configured sessions directory", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    await expect(handleMemoryReviewCommand(basePayload({ transcript_path: "/tmp/evil/" + SESSION_ID + ".jsonl" }), {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      userCorrection: true
    })).rejects.toThrow("transcript authority mismatch");
  });
});
