#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import {
  createMemoryReviewReceipt,
  evaluateMemoryReviewTrigger,
  loadMemoryReviewPolicy,
  PROMPT_ID_RE,
  readMemoryReviewReceipt,
  sha256Hex,
  transitionMemoryReviewReceipt,
  type MemoryReviewTriggerInput
} from "@project-tharsis/claude-code-telegram-shared";
import { createSessionScheduler } from "./runtime.js";
import { buildMemoryReviewSnapshot, serializeMemoryReviewSnapshot } from "./memory-review-snapshot.js";
import { writeMemoryReviewSnapshot } from "./memory-review-snapshot-store.js";

const PACKAGE_VERSION = "0.3.0";

const MAX_STDIN_BYTES = 256 * 1024;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  prompt_id?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
  last_assistant_message?: unknown;
  /**
   * Not yet emitted by the pinned Claude Code baseline (see handoff doc B2 upstream
   * alignment). Absence is treated as "no active background task", matching the current
   * conservative default; a live canary must confirm the field's real shape before this
   * assumption changes.
   */
  background_tasks?: unknown;
}

export interface MemoryReviewCommandOptions {
  now?: () => number;
  workspaceDir?: string;
  projectSessionsDir?: string;
  telegramMessageId?: number;
  releaseSha?: string;
  toolIterations?: number;
  userCorrection?: boolean;
  turnOrdinal?: number;
  receiptDirectory?: string;
  /**
   * The confirmed outcome of the foreground Telegram delivery for this exact turn ("delivered",
   * "rejected", "uncertain", or "too_large" -- see FinalDeliveryOutcome in the renderer MCP's
   * progress-disclosure.ts, the module that actually computes this today). No such signal
   * currently reaches this Stop-hook seam (it and the renderer's finishTurn are separate
   * processes reacting to the same Stop event with no shared channel between them); until a
   * later PR wires a real one through, this MUST default to "uncertain", never "delivered" --
   * evaluateMemoryReviewTrigger's fail-closed not_delivered gate depends on that.
   */
  deliveryOutcome?: "delivered" | "rejected" | "uncertain" | "too_large";
  /** Threaded into the bounded snapshot; see MemoryReviewSnapshotInput.userMessage. */
  userMessage?: string;
  /** Threaded into the bounded snapshot; see MemoryReviewSnapshotInput.currentMemoryIndex. */
  currentMemoryIndex?: string;
  snapshotDirectory?: string;
  schedule?: (sessionId: string, promptId: string) => Promise<unknown>;
  readReceipt?: (sessionId: string, promptId: string) => ReturnType<typeof readMemoryReviewReceipt>;
  createReceipt?: typeof createMemoryReviewReceipt;
  writeSnapshot?: typeof writeMemoryReviewSnapshot;
  transitionReceipt?: typeof transitionMemoryReviewReceipt;
}

function canonicalDirectory(path: string | undefined, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`invalid ${label}`);
  return resolve(path);
}

function resolveTranscriptAuthority(payload: HookPayload, projectSessionsDir: string): void {
  if (typeof payload.transcript_path !== "string" || !isAbsolute(payload.transcript_path)) {
    throw new Error("invalid transcript authority");
  }
  const transcript = resolve(payload.transcript_path);
  if (parse(transcript).base !== `${payload.session_id}.jsonl`) throw new Error("transcript identity mismatch");
  if (dirname(transcript) !== projectSessionsDir) throw new Error("transcript authority mismatch");
}

/**
 * The deterministic Stop-hook seam for the Memory Harness's verified-delivery trigger
 * (handoff doc section A1). It never calls a model itself: it only decides, from exact Stop
 * facts and the production policy, whether a durable review receipt is due, creates it with
 * singleflight semantics, and schedules the isolated reviewer through the root broker. With
 * the production default (`MEMORY_REVIEW_ENABLED` unset), `loadMemoryReviewPolicy` resolves
 * to disabled and this function returns immediately after that one policy read.
 */
export async function handleMemoryReviewCommand(
  payload: HookPayload,
  options: MemoryReviewCommandOptions = {}
): Promise<void> {
  if (payload.hook_event_name !== "Stop") return;
  const policy = loadMemoryReviewPolicy();
  if (!policy.enabled) return;

  if (typeof payload.session_id !== "string" || !SESSION_UUID.test(payload.session_id)) {
    throw new Error("invalid session identity");
  }
  // Validated against the exact same PROMPT_ID_RE createMemoryReviewReceipt's assertBounds
  // enforces deeper in the call stack, so a malformed prompt_id (outside the receipt's
  // charset but within the old shallow length-only check, e.g. containing whitespace) fails
  // fast and visibly here instead of failing deep inside receipt creation, where main()'s
  // catch-all would otherwise swallow it silently.
  if (typeof payload.prompt_id !== "string" || !PROMPT_ID_RE.test(payload.prompt_id)) {
    throw new Error("invalid prompt identity");
  }
  const projectSessionsDir = canonicalDirectory(options.projectSessionsDir ?? process.env.CLAUDE_PROJECT_SESSIONS_DIR, "configured sessions directory");
  resolveTranscriptAuthority(payload, projectSessionsDir);

  const assistantText = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
  const backgroundTasksActive = Array.isArray(payload.background_tasks) && payload.background_tasks.length > 0;

  const readReceipt = options.readReceipt ?? ((sessionId, promptId) => readMemoryReviewReceipt(sessionId, promptId, options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory }));
  const hasExistingReceipt = readReceipt(payload.session_id, payload.prompt_id) !== null;

  const triggerInput: MemoryReviewTriggerInput = {
    // Fail closed: absent a real confirmed-delivery signal at this call site, "uncertain" is
    // never treated as due. See the deliveryOutcome doc comment on MemoryReviewCommandOptions.
    deliveryOutcome: options.deliveryOutcome ?? "uncertain",
    backgroundTasksActive,
    hasExistingReceipt,
    isReviewAuthorityTurn: false,
    userCorrection: options.userCorrection ?? false,
    turnOrdinal: options.turnOrdinal ?? 1
  };
  const decision = evaluateMemoryReviewTrigger(triggerInput, policy);
  if (!decision.due) return;

  const releaseSha = options.releaseSha ?? process.env.CLAUDE_RUNTIME_RELEASE_SHA ?? "";
  if (!RELEASE_SHA_RE.test(releaseSha)) return;
  const telegramMessageId = options.telegramMessageId;
  if (telegramMessageId === undefined || !Number.isSafeInteger(telegramMessageId) || telegramMessageId < 1) return;

  const create = options.createReceipt ?? createMemoryReviewReceipt;
  const result = create({
    sessionId: payload.session_id,
    promptId: payload.prompt_id,
    lastAssistantMessageSha256: sha256Hex(assistantText),
    transcriptPath: resolve(payload.transcript_path as string),
    telegramMessageId,
    releaseSha,
    toolIterations: options.toolIterations ?? 0
  }, options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory });
  if (result.outcome !== "created") return;

  // The bounded snapshot is built here -- unprivileged, at Stop-hook time -- because this is
  // the only point in the whole pipeline where the untrusted transcript-derived text (the
  // verified assistant final, at minimum) is actually available. It is written to a durable,
  // directory-fd-anchored, single-writer/single-reader store keyed by the exact same
  // (session_id, prompt_id) the receipt uses; root's memory_review_session() reads those exact
  // bytes and pipes them, unparsed, to the isolated worker's stdin (see memory-review-worker.ts's
  // readSnapshotFromStdin). Root never builds or interprets a snapshot itself.
  //
  // From here on, the receipt already exists as "queued". If either the snapshot write or the
  // broker schedule call throws, no worker will ever be scheduled for it, so it must not be
  // left "queued" -- indistinguishable from a review that is genuinely in flight, with zero
  // operator visibility, until TTL reclaims it. Transition it to the same terminal "failed"
  // status the worker's own retry-semantics distinction uses for a non-retryable outcome, so
  // the failure is immediately visible instead of silently orphaned.
  try {
    const snapshot = buildMemoryReviewSnapshot({
      userMessage: options.userMessage ?? "",
      assistantFinal: assistantText,
      currentMemoryIndex: options.currentMemoryIndex ?? "",
      releaseSha,
      packageVersion: PACKAGE_VERSION
    });
    const write = options.writeSnapshot ?? writeMemoryReviewSnapshot;
    write(
      payload.session_id,
      payload.prompt_id,
      Buffer.from(serializeMemoryReviewSnapshot(snapshot), "utf8"),
      options.snapshotDirectory === undefined ? {} : { directory: options.snapshotDirectory }
    );

    await (options.schedule ?? ((sessionId, promptId) => createSessionScheduler().scheduleMemoryReview(sessionId, promptId)))(payload.session_id, payload.prompt_id);
  } catch (error) {
    try {
      (options.transitionReceipt ?? transitionMemoryReviewReceipt)(
        payload.session_id,
        payload.prompt_id,
        "failed",
        options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory }
      );
    } catch {
      // Best-effort: the original error below is what matters and must not be masked.
    }
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const raw = readFileSync(0);
    if (raw.byteLength === 0 || raw.byteLength > MAX_STDIN_BYTES) return;
    const payload = JSON.parse(raw.toString("utf8")) as HookPayload;
    await handleMemoryReviewCommand(payload);
  } catch {
    // Memory review is display/state-only from the model's perspective; it never blocks Stop.
  }
}

if (import.meta.main) await main();
