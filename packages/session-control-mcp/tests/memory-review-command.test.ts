import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryObserverLedger, readMemoryReviewReceipt } from "@project-tharsis/claude-code-telegram-shared";
import { handleMemoryReviewCommand, loadNativeMemoryReviewContext, type MemoryReviewCommandOptions } from "../src/memory-review-command.js";
import { readMemoryReviewSnapshot } from "../src/memory-review-snapshot-store.js";
import { parseSnapshotFromStdin } from "../src/memory-review-worker.js";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const RELEASE_SHA = "f".repeat(40);

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    hook_event_name: "Stop",
    session_id: SESSION_ID,
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
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
  let previousRuntimeReleaseSha: string | undefined;
  let previousLegacyReleaseSha: string | undefined;

  function baseOptions(overrides: MemoryReviewCommandOptions = {}): MemoryReviewCommandOptions {
    return {
      projectSessionsDir: "/srv/sessions",
      receiptDirectory: directory,
      snapshotDirectory,
      telegramMessageId: 5,
      releaseSha: RELEASE_SHA,
      deliveryOutcome: "delivered",
      userCorrection: true,
      observerEnabled: true,
      now: () => 1_000,
      readObserverLedger: () => ({
        schema: 1,
        recovery: null,
        next_sequence: 1,
        latest: {
          observed_at: 1_000,
          release_sha: RELEASE_SHA,
          directory_sha256: "a".repeat(64),
          inventory_sha256: "b".repeat(64),
          files: []
        },
        watermark: { sequence: 0, observed_at: 1_000, inventory_sha256: "b".repeat(64) },
        events: []
      }),
      userMessage: "please remember I prefer concise replies",
      loadNativeContext: () => ({
        currentMemoryIndex: "- no-em-dash.md",
        relevantTopics: [{ path: "no-em-dash.md", contentHash: "e".repeat(64), excerpt: "Avoid em dashes." }],
        nativeMemoryChangeSummary: "modified:no-em-dash.md",
        nativeMemoryWatermark: "d".repeat(64)
      }),
      ...overrides
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-review-command-"));
    snapshotDirectory = mkdtempSync(join(tmpdir(), "memory-review-command-snapshots-"));
    previousEnabled = process.env.MEMORY_REVIEW_ENABLED;
    previousCadence = process.env.MEMORY_REVIEW_CADENCE_TURNS;
    previousRuntimeReleaseSha = process.env.CLAUDE_RUNTIME_RELEASE_SHA;
    previousLegacyReleaseSha = process.env.CLAUDE_RELEASE_SHA;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(snapshotDirectory, { recursive: true, force: true });
    if (previousEnabled === undefined) delete process.env.MEMORY_REVIEW_ENABLED; else process.env.MEMORY_REVIEW_ENABLED = previousEnabled;
    if (previousCadence === undefined) delete process.env.MEMORY_REVIEW_CADENCE_TURNS; else process.env.MEMORY_REVIEW_CADENCE_TURNS = previousCadence;
    if (previousRuntimeReleaseSha === undefined) delete process.env.CLAUDE_RUNTIME_RELEASE_SHA; else process.env.CLAUDE_RUNTIME_RELEASE_SHA = previousRuntimeReleaseSha;
    if (previousLegacyReleaseSha === undefined) delete process.env.CLAUDE_RELEASE_SHA; else process.env.CLAUDE_RELEASE_SHA = previousLegacyReleaseSha;
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

  test("uses the activation-attested runtime release SHA rather than a legacy untrusted variable", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    process.env.CLAUDE_RUNTIME_RELEASE_SHA = RELEASE_SHA;
    process.env.CLAUDE_RELEASE_SHA = "0".repeat(40);
    const configured = baseOptions({ schedule: async () => undefined });
    const { releaseSha: _omit, ...withoutExplicitRelease } = configured;
    await handleMemoryReviewCommand(basePayload(), withoutExplicitRelease);
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })?.release_sha).toBe(RELEASE_SHA);
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

  test("requires the observer path and a same-release startup ledger before enqueue", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    for (const options of [
      baseOptions({ observerEnabled: false }),
      baseOptions({ readObserverLedger: () => null }),
      baseOptions({ readObserverLedger: () => ({
        schema: 1, recovery: null, next_sequence: 1,
        latest: { observed_at: 1_000, release_sha: "0".repeat(40), directory_sha256: "a".repeat(64), inventory_sha256: "b".repeat(64), files: [] },
        watermark: { sequence: 0, observed_at: 1_000, inventory_sha256: "b".repeat(64) }, events: []
      }) })
    ]) {
      await handleMemoryReviewCommand(basePayload(), options);
      expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })).toBeNull();
    }
  });

  test("does not expire a same-release startup ledger while the long-running session re-observes at Stop", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload(), baseOptions({
      now: () => 10_000_000,
      schedule: async () => { scheduled = true; }
    }));
    expect(scheduled).toBe(true);
  });

  test("does not enqueue when no real delivery-confirmed signal is supplied (fails closed, never defaults to delivered)", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    const { deliveryOutcome: _omit, ...withoutDeliveryOutcome } = baseOptions({
      deliveryEvidenceWaitMs: 0,
      schedule: async () => { scheduled = true; }
    });
    await handleMemoryReviewCommand(basePayload(), withoutDeliveryOutcome);
    expect(scheduled).toBe(false);
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })).toBeNull();
  });

  test("consumes exact persisted renderer evidence instead of an injected delivery outcome", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "memory-delivery-evidence-"));
    try {
      const { persistMemoryDeliveryEvidence } = await import("@project-tharsis/claude-code-telegram-shared");
      persistMemoryDeliveryEvidence({
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        sourceMessageId: 5,
        deliveredMessageIds: [6],
        assistantMessage: "different assistant bytes",
        releaseSha: RELEASE_SHA,
        observedAt: 1_000,
        userMessage: "please remember concise replies",
        toolIterations: 0,
      }, { directory: evidenceDirectory });
      let scheduled = false;
      await handleMemoryReviewCommand(basePayload(), baseOptions({ deliveryOutcome: "delivered", deliveryEvidenceDirectory: evidenceDirectory, schedule: async () => { scheduled = true; } }));
      expect(scheduled).toBe(false);
    } finally { rmSync(evidenceDirectory, { recursive: true, force: true }); }
  });

  test("uses verified evidence as the production trigger and snapshot authority", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "memory-delivery-evidence-valid-"));
    try {
      const { persistMemoryDeliveryEvidence } = await import("@project-tharsis/claude-code-telegram-shared");
      persistMemoryDeliveryEvidence({
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        sourceMessageId: 5,
        deliveredMessageIds: [6],
        assistantMessage: "Understood.",
        releaseSha: RELEASE_SHA,
        observedAt: 1_000,
        userMessage: "以后不要使用破折号",
        toolIterations: 3,
      }, { directory: evidenceDirectory });
      const configured = baseOptions({ deliveryEvidenceDirectory: evidenceDirectory, schedule: async () => undefined });
      const {
        deliveryOutcome: _delivery,
        telegramMessageId: _message,
        userCorrection: _correction,
        userMessage: _user,
        turnOrdinal: _ordinal,
        toolIterations: _tools,
        ...withoutInjectedAuthority
      } = configured;
      await handleMemoryReviewCommand(basePayload(), withoutInjectedAuthority);
      const receipt = readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory });
      expect(receipt?.telegram_message_id).toBe(5);
      expect(receipt?.tool_iterations).toBe(3);
      const bytes = readMemoryReviewSnapshot(SESSION_ID, "prompt-1", { directory: snapshotDirectory })!;
      expect(parseSnapshotFromStdin(bytes).userMessage).toBe("以后不要使用破折号");
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  });

  test("waits boundedly for evidence from the parallel renderer Stop hook", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "memory-evidence-race-"));
    const { persistMemoryDeliveryEvidence } = await import("@project-tharsis/claude-code-telegram-shared");
    const timer = setTimeout(() => persistMemoryDeliveryEvidence({
      sessionId: SESSION_ID, promptId: "prompt-1", sourceMessageId: 5,
      deliveredMessageIds: [6], assistantMessage: "Understood.", releaseSha: RELEASE_SHA,
      observedAt: 1_000, userMessage: "请记住简短回答", toolIterations: 1,
    }, { directory: evidenceDirectory }), 25);
    try {
      let scheduled = false;
      const configured = baseOptions({
        deliveryEvidenceDirectory: evidenceDirectory,
        deliveryEvidenceWaitMs: 200,
        deliveryEvidencePollMs: 10,
        schedule: async () => { scheduled = true; },
      });
      const { deliveryOutcome: _d, telegramMessageId: _m, userCorrection: _c,
        userMessage: _u, turnOrdinal: _o, toolIterations: _t, ...production } = configured;
      await handleMemoryReviewCommand(basePayload(), production);
      expect(scheduled).toBe(true);
      expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })?.status).toBe("queued");
    } finally {
      clearTimeout(timer);
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  });

  test("stops polling at the configured evidence wait bound", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "memory-evidence-timeout-"));
    const delays: number[] = [];
    try {
      const configured = baseOptions({
        deliveryEvidenceDirectory: evidenceDirectory,
        deliveryEvidenceWaitMs: 25,
        deliveryEvidencePollMs: 10,
        sleep: async ms => { delays.push(ms); },
      });
      const { deliveryOutcome: _d, telegramMessageId: _m, userCorrection: _c,
        userMessage: _u, turnOrdinal: _o, toolIterations: _t, ...production } = configured;
      await handleMemoryReviewCommand(basePayload(), production);
      expect(delays).toEqual([10, 10, 5]);
      expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })).toBeNull();
    } finally { rmSync(evidenceDirectory, { recursive: true, force: true }); }
  });

  test("requires exact empty registry arrays for idle authority", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    let scheduled = false;
    await handleMemoryReviewCommand(basePayload({ session_crons: undefined }), baseOptions({ schedule: async () => { scheduled = true; } }));
    expect(scheduled).toBe(false);
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
    expect(snapshot.relevantTopics[0]?.path).toBe("no-em-dash.md");
    expect(snapshot.nativeMemoryChangeSummary).toBe("modified:no-em-dash.md");
    expect(snapshot.nativeMemoryWatermark).toBe("d".repeat(64));
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

  test("fails closed before receipt creation when native memory preflight is unavailable", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    await expect(handleMemoryReviewCommand(basePayload(), baseOptions({
      loadNativeContext: () => { throw new Error("native memory unavailable"); }
    }))).rejects.toThrow("native memory unavailable");
    expect(readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory })).toBeNull();
  });

  test("transitions the receipt to failed (not left stuck queued) when the snapshot write throws after receipt creation", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    await expect(handleMemoryReviewCommand(basePayload(), baseOptions({
      writeSnapshot: () => { throw new Error("disk full"); },
      schedule: async () => { throw new Error("schedule should never be reached"); }
    }))).rejects.toThrow("disk full");
    const receipt = readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory });
    expect(receipt?.status).toBe("failed");
  });

  test("leaves the receipt queued when the broker outcome is uncertain after the snapshot is written", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    await expect(handleMemoryReviewCommand(basePayload(), baseOptions({
      schedule: async () => { throw new Error("broker unreachable"); }
    }))).rejects.toThrow("broker unreachable");
    const receipt = readMemoryReviewReceipt(SESSION_ID, "prompt-1", { directory });
    expect(receipt?.status).toBe("queued");
  });

  test("loads real native memory context through the observer ledger without writing memory", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-review-native-context-"));
    try {
      const memory = join(root, "memory");
      const ledger = join(root, "state", "observer");
      const settings = join(root, "settings.json");
      mkdirSync(memory, { mode: 0o755 });
      writeFileSync(join(memory, "MEMORY.md"), "# Memory\n", { mode: 0o644 });
      writeFileSync(join(memory, "preferences.md"), "Keep replies concise.\n", { mode: 0o644 });
      writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: memory }), { mode: 0o600 });

      const context = loadNativeMemoryReviewContext({
        releaseSha: RELEASE_SHA,
        settingsPath: settings,
        observerLedgerDirectory: ledger,
        now: 1_000
      });
      expect(context.currentMemoryIndex).toBe("# Memory\n");
      expect(context.relevantTopics[0]?.path).toBe("preferences.md");
      expect(context.nativeMemoryWatermark).toMatch(/^[0-9a-f]{64}$/);
      expect(readMemoryObserverLedger({ directory: ledger })?.latest.inventory_sha256).toBe(context.nativeMemoryWatermark);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a prompt_id outside the receipt store's strict charset at the earliest validation point (fails fast, not deep)", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    await expect(handleMemoryReviewCommand(basePayload({ prompt_id: "prompt with spaces" }), baseOptions()))
      .rejects.toThrow("invalid prompt identity");
  });

  test("rejects a transcript path outside the configured sessions directory", async () => {
    process.env.MEMORY_REVIEW_ENABLED = "true";
    await expect(handleMemoryReviewCommand(basePayload({ transcript_path: "/tmp/evil/" + SESSION_ID + ".jsonl" }), baseOptions()))
      .rejects.toThrow("transcript authority mismatch");
  });
});
