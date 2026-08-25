#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import {
  createMemoryReviewReceipt,
  evaluateMemoryReviewTrigger,
  loadMemoryReviewPolicy,
  observeNativeMemory,
  PROMPT_ID_RE,
  readMemoryObserverLedger,
  readMemoryDeliveryEvidence,
  type MemoryDeliveryEvidence,
  hasIdleTurnAuthority,
  readMemoryReviewReceipt,
  readNativeMemoryReviewContext,
  recordMemoryObservation,
  resolveConfiguredAutoMemoryDirectory,
  sha256Hex,
  transitionMemoryReviewReceipt,
  type MemoryObserverLedger,
  type MemoryReviewTriggerInput
} from "@project-tharsis/claude-code-telegram-shared";
import { createSessionScheduler } from "./runtime.js";
import { buildMemoryReviewSnapshot, memoryReviewSnapshotDigest, serializeMemoryReviewSnapshot } from "./memory-review-snapshot.js";
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
  /** Claude Code's exact Stop registry snapshot. Missing arrays fail closed. */
  background_tasks?: unknown;
  session_crons?: unknown;
  stop_hook_active?: unknown;
}

export interface MemoryReviewCommandOptions {
  now?: () => number;
  observerEnabled?: boolean;
  workspaceDir?: string;
  projectSessionsDir?: string;
  telegramMessageId?: number;
  releaseSha?: string;
  toolIterations?: number;
  userCorrection?: boolean;
  turnOrdinal?: number;
  receiptDirectory?: string;
  /** Test seam only. Production delivery authority comes from the renderer evidence store. */
  deliveryOutcome?: "delivered" | "rejected" | "uncertain" | "too_large";
  deliveryEvidenceDirectory?: string;
  /** Threaded into the bounded snapshot; see MemoryReviewSnapshotInput.userMessage. */
  userMessage?: string;
  /** Deterministic native memory context loader. Tests may replace it without touching production memory. */
  loadNativeContext?: (releaseSha: string, now: number) => MemoryReviewNativeContext;
  settingsPath?: string;
  observerLedgerDirectory?: string;
  snapshotDirectory?: string;
  schedule?: (sessionId: string, promptId: string) => Promise<unknown>;
  readReceipt?: (sessionId: string, promptId: string) => ReturnType<typeof readMemoryReviewReceipt>;
  readObserverLedger?: () => MemoryObserverLedger | null;
  createReceipt?: typeof createMemoryReviewReceipt;
  writeSnapshot?: typeof writeMemoryReviewSnapshot;
  transitionReceipt?: typeof transitionMemoryReviewReceipt;
}

export interface MemoryReviewNativeContext {
  currentMemoryIndex: string;
  relevantTopics: Array<{ path: string; contentHash: string; excerpt: string }>;
  nativeMemoryChangeSummary: string;
  nativeMemoryWatermark: string;
}

export interface LoadNativeMemoryReviewContextOptions {
  releaseSha: string;
  settingsPath?: string;
  observerLedgerDirectory?: string;
  now?: number;
}

export function loadNativeMemoryReviewContext(options: LoadNativeMemoryReviewContextOptions): MemoryReviewNativeContext {
  const settingsPath = options.settingsPath ?? process.env.CLAUDE_SETTINGS_PATH;
  if (typeof settingsPath !== "string" || !isAbsolute(settingsPath)) throw new Error("configured Claude settings path is required");
  const now = options.now ?? Date.now();
  const memoryDirectory = resolveConfiguredAutoMemoryDirectory({ settingsPath });
  const observation = observeNativeMemory({ memoryDirectory, releaseSha: options.releaseSha, now });
  const ledgerOptions = options.observerLedgerDirectory === undefined ? {} : { directory: options.observerLedgerDirectory };
  const ledger = recordMemoryObservation(observation, ledgerOptions);
  const context = readNativeMemoryReviewContext(observation);
  const changes = ledger.events.slice(-8).map(event => `${event.kind}:${event.path}`).join(", ");
  return {
    currentMemoryIndex: context.currentMemoryIndex,
    relevantTopics: context.relevantTopics,
    nativeMemoryChangeSummary: changes === "" ? "no observed native memory changes" : changes,
    nativeMemoryWatermark: context.nativeMemoryWatermark
  };
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
  const observerEnabled = options.observerEnabled ?? process.env.MEMORY_OBSERVER_ENABLED === "true";
  if (!observerEnabled) return;

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
  if (assistantText.trim() === "") return;
  // Stop payload arrays are the registry authority. Missing fields are not equivalent to idle.
  if (!hasIdleTurnAuthority({
    stopHookActive: payload.stop_hook_active,
    backgroundTasks: payload.background_tasks,
    sessionCrons: payload.session_crons,
  })) return;

  const releaseSha = options.releaseSha ?? process.env.CLAUDE_RUNTIME_RELEASE_SHA ?? "";
  if (!RELEASE_SHA_RE.test(releaseSha)) return;
  const observedAt = (options.now ?? Date.now)();
  const assistantMessageSha256 = sha256Hex(assistantText);
  const readReceipt = options.readReceipt ?? ((sessionId, promptId) => readMemoryReviewReceipt(
    sessionId,
    promptId,
    options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory },
  ));
  const hasExistingReceipt = readReceipt(payload.session_id, payload.prompt_id) !== null;

  const deliveryEvidence: MemoryDeliveryEvidence | null = readMemoryDeliveryEvidence(
    payload.session_id,
    payload.prompt_id,
    options.deliveryEvidenceDirectory === undefined
      ? { now: () => observedAt }
      : { directory: options.deliveryEvidenceDirectory, now: () => observedAt },
  );
  if (
    deliveryEvidence !== null &&
    (deliveryEvidence.release_sha !== releaseSha ||
      deliveryEvidence.assistant_message_sha256 !== assistantMessageSha256 ||
      deliveryEvidence.observed_at > observedAt ||
      observedAt - deliveryEvidence.observed_at > 120_000)
  ) return;
  const deliveryOutcome = deliveryEvidence?.outcome ?? options.deliveryOutcome ?? "uncertain";
  const telegramMessageId = deliveryEvidence?.source_message_id ?? options.telegramMessageId;
  const userMessage = deliveryEvidence?.user_message ?? options.userMessage ?? "";
  const toolIterations = deliveryEvidence?.tool_iterations ?? options.toolIterations ?? 0;
  const triggerInput: MemoryReviewTriggerInput = {
    deliveryOutcome,
    backgroundTasksActive: false,
    hasExistingReceipt,
    isReviewAuthorityTurn: false,
    userCorrection: deliveryEvidence?.user_correction ?? options.userCorrection ?? false,
    turnOrdinal: deliveryEvidence?.turn_ordinal ?? options.turnOrdinal ?? 1,
  };
  const decision = evaluateMemoryReviewTrigger(triggerInput, policy);
  if (!decision.due) return;
  if (telegramMessageId === undefined || !Number.isSafeInteger(telegramMessageId) || telegramMessageId < 1) return;
  if (userMessage.trim() === "" || !Number.isSafeInteger(toolIterations) || toolIterations < 0) return;

  const observerLedger = (options.readObserverLedger ?? (() => readMemoryObserverLedger()))();
  if (observerLedger === null || observerLedger.latest.release_sha !== releaseSha) return;
  const nativeContext = options.loadNativeContext === undefined
    ? loadNativeMemoryReviewContext({
        releaseSha,
        now: observedAt,
        ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
        ...(options.observerLedgerDirectory === undefined ? {} : { observerLedgerDirectory: options.observerLedgerDirectory })
      })
    : options.loadNativeContext(releaseSha, observedAt);

  const snapshot = buildMemoryReviewSnapshot({
    sessionId: payload.session_id,
    promptId: payload.prompt_id,
    assistantMessageSha256,
    userMessage,
    assistantFinal: assistantText,
    currentMemoryIndex: nativeContext.currentMemoryIndex,
    relevantTopics: nativeContext.relevantTopics,
    nativeMemoryChangeSummary: nativeContext.nativeMemoryChangeSummary,
    nativeMemoryWatermark: nativeContext.nativeMemoryWatermark,
    releaseSha,
    packageVersion: PACKAGE_VERSION
  });
  const snapshotSha256 = memoryReviewSnapshotDigest(snapshot);
  const create = options.createReceipt ?? createMemoryReviewReceipt;
  const result = create({
    sessionId: payload.session_id,
    promptId: payload.prompt_id,
    lastAssistantMessageSha256: assistantMessageSha256,
    snapshotSha256,
    transcriptPath: resolve(payload.transcript_path as string),
    telegramMessageId,
    releaseSha,
    toolIterations,
    createdAt: observedAt
  }, options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory });
  if (result.outcome !== "created") return;

  // The bounded snapshot is built here -- unprivileged, at Stop-hook time -- because this is
  // the only point in the whole pipeline where the untrusted transcript-derived text (the
  // verified assistant final, at minimum) is actually available. It is written to a durable,
  // directory-fd-anchored, single-writer/single-reader store keyed by the exact same
  // (session_id, prompt_id) the receipt uses; root's memory_review_session() reads those exact
  // bytes and pipes them, unparsed, to the isolated worker's stdin (see memory-review-worker.ts's
  // readSnapshotFromStdin). Root never builds or interprets a snapshot itself.
  // A proven local snapshot construction/write failure happens before any broker mutation and can
  // terminalize the receipt. Scheduling is different: timeout, disconnect, or malformed response
  // may mean the root broker already accepted the unit, so any scheduler exception must leave the
  // receipt queued and must never replay the uncertain request.
  try {
    const write = options.writeSnapshot ?? writeMemoryReviewSnapshot;
    write(
      payload.session_id,
      payload.prompt_id,
      Buffer.from(serializeMemoryReviewSnapshot(snapshot), "utf8"),
      options.snapshotDirectory === undefined ? {} : { directory: options.snapshotDirectory }
    );
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

  await (options.schedule ?? ((sessionId, promptId) => createSessionScheduler().scheduleMemoryReview(sessionId, promptId)))(
    payload.session_id,
    payload.prompt_id
  );
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
