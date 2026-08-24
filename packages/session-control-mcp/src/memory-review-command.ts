#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import {
  createMemoryReviewReceipt,
  evaluateMemoryReviewTrigger,
  loadMemoryReviewPolicy,
  readMemoryReviewReceipt,
  sha256Hex,
  type MemoryReviewTriggerInput
} from "@project-tharsis/claude-code-telegram-shared";
import { createSessionScheduler } from "./runtime.js";

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
  schedule?: (sessionId: string, promptId: string) => Promise<unknown>;
  readReceipt?: (sessionId: string, promptId: string) => ReturnType<typeof readMemoryReviewReceipt>;
  createReceipt?: typeof createMemoryReviewReceipt;
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
  if (typeof payload.prompt_id !== "string" || payload.prompt_id.length < 1 || payload.prompt_id.length > 128) {
    throw new Error("invalid prompt identity");
  }
  const projectSessionsDir = canonicalDirectory(options.projectSessionsDir ?? process.env.CLAUDE_PROJECT_SESSIONS_DIR, "configured sessions directory");
  resolveTranscriptAuthority(payload, projectSessionsDir);

  const assistantText = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
  const backgroundTasksActive = Array.isArray(payload.background_tasks) && payload.background_tasks.length > 0;

  const readReceipt = options.readReceipt ?? ((sessionId, promptId) => readMemoryReviewReceipt(sessionId, promptId, options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory }));
  const hasExistingReceipt = readReceipt(payload.session_id, payload.prompt_id) !== null;

  const triggerInput: MemoryReviewTriggerInput = {
    deliveryOutcome: "delivered",
    backgroundTasksActive,
    hasExistingReceipt,
    isReviewAuthorityTurn: false,
    userCorrection: options.userCorrection ?? false,
    turnOrdinal: options.turnOrdinal ?? 1
  };
  const decision = evaluateMemoryReviewTrigger(triggerInput, policy);
  if (!decision.due) return;

  const releaseSha = options.releaseSha ?? process.env.CLAUDE_RELEASE_SHA ?? "";
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

  await (options.schedule ?? ((sessionId, promptId) => createSessionScheduler().scheduleMemoryReview(sessionId, promptId)))(payload.session_id, payload.prompt_id);
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
