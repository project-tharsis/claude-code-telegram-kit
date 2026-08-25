#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyMemoryReviewProposal,
  buildMemoryIdleProof,
  defaultMemoryObserverLedgerDirectory,
  defaultMemoryReviewProposalDirectory,
  listMemoryReviewProposalRecords,
  memoryReviewReceiptKey,
  observeNativeMemory,
  readManagedMemoryLedger,
  readMemoryObserverLedger,
  readMemoryReviewReceipt,
  recoverMemoryReviewApplier,
  resolveConfiguredAutoMemoryDirectory,
  writeLearningDelta,
} from "@project-tharsis/claude-code-telegram-shared";

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RELEASE_RE = /^[0-9a-f]{40}$/;
const MAX_STDIN_BYTES = 256 * 1024;

interface StopPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  prompt_id?: unknown;
  stop_hook_active?: unknown;
  background_tasks?: unknown;
  session_crons?: unknown;
}

export interface MemoryApplyCommandOptions {
  enabled?: boolean;
  deltaEnabled?: boolean;
  releaseSha?: string;
  settingsPath?: string;
  stateDirectory?: string;
  proposalDirectory?: string;
  observerLedgerDirectory?: string;
  receiptDirectory?: string;
  deltaDirectory?: string;
  now?: () => number;
}

function stateDirectory(options: MemoryApplyCommandOptions): string {
  return options.stateDirectory
    ?? process.env.MEMORY_APPLIER_STATE_DIR
    ?? join(homedir(), ".local", "state", "claude-code-telegram-kit", "memory-review", "applier");
}

export async function handleMemoryApplyCommand(
  payload: StopPayload,
  options: MemoryApplyCommandOptions = {},
): Promise<"applied" | "no_op"> {
  const enabled = options.enabled ?? process.env.MEMORY_APPLY_ENABLED === "true";
  if (!enabled || payload.hook_event_name !== "Stop") return "no_op";
  if (
    typeof payload.session_id !== "string" || !SESSION_RE.test(payload.session_id) ||
    typeof payload.prompt_id !== "string" || !PROMPT_RE.test(payload.prompt_id)
  ) return "no_op";
  const now = (options.now ?? Date.now)();
  const idleProof = buildMemoryIdleProof({
    sessionId: payload.session_id,
    promptId: payload.prompt_id,
    observedAt: now,
    stopHookActive: payload.stop_hook_active,
    backgroundTasks: payload.background_tasks,
    sessionCrons: payload.session_crons,
  });
  if (idleProof === null) return "no_op";
  const releaseSha = options.releaseSha ?? process.env.CLAUDE_RUNTIME_RELEASE_SHA ?? "";
  if (!RELEASE_RE.test(releaseSha)) return "no_op";
  const settingsPath = options.settingsPath ?? process.env.CLAUDE_SETTINGS_PATH;
  if (typeof settingsPath !== "string") return "no_op";
  const proposalDirectory = options.proposalDirectory ?? defaultMemoryReviewProposalDirectory();
  const applierState = stateDirectory(options);

  const memoryDirectory = resolveConfiguredAutoMemoryDirectory({ settingsPath });
  const observerLedger = readMemoryObserverLedger({
    directory: options.observerLedgerDirectory ?? defaultMemoryObserverLedgerDirectory(),
    nativeMemoryDirectory: memoryDirectory,
  });
  if (observerLedger === null || observerLedger.latest.release_sha !== releaseSha) return "no_op";
  let observation = observeNativeMemory({ memoryDirectory, releaseSha, now });
  const recovery = recoverMemoryReviewApplier({
    releaseSha,
    memoryDirectory,
    directorySha256: observation.directory_sha256,
    idleProof,
    stateDirectory: applierState,
    proposalDirectory,
    now,
  });
  if (recovery.outcome === "rollback_conflict") return "no_op";

  const receiptOptions = options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory };
  for (const record of listMemoryReviewProposalRecords({ directory: proposalDirectory })) {
    if (record.session_id !== payload.session_id || record.release_sha !== releaseSha || record.proposal.decision === "no_op") continue;
    const receipt = readMemoryReviewReceipt(record.session_id, record.prompt_id, receiptOptions);
    if (receipt?.status !== "reviewed") continue;
    const deltaEnabled = options.deltaEnabled ?? process.env.MEMORY_LEARNING_DELTA_ENABLED === "true";
    const proposalKey = memoryReviewReceiptKey(record.session_id, record.prompt_id);
    const ownership = readManagedMemoryLedger({ directory: applierState });
    const alreadyOwned = ownership?.entries.some(entry => entry.proposal_key === proposalKey) === true;
    if (alreadyOwned) {
      if (deltaEnabled) {
        writeLearningDelta({
          receiptId: proposalKey,
          sessionId: record.session_id,
          releaseSha,
          topics: [record.proposal.topic],
          summary: record.proposal.content,
          createdAt: now,
        }, options.deltaDirectory === undefined ? {} : { directory: options.deltaDirectory });
      }
      continue;
    }
    observation = observeNativeMemory({ memoryDirectory, releaseSha, now });
    const result = applyMemoryReviewProposal({
      enabled: true,
      proposalRecord: record,
      receipt,
      observation,
      idleProof,
      releaseSha,
      stateDirectory: applierState,
      proposalDirectory,
      now,
    });
    if (result.outcome !== "applied" && result.outcome !== "already_applied") continue;
    if (deltaEnabled) {
      writeLearningDelta({
        receiptId: memoryReviewReceiptKey(record.session_id, record.prompt_id),
        sessionId: record.session_id,
        releaseSha,
        topics: [record.proposal.topic],
        summary: record.proposal.content,
        createdAt: now,
      }, options.deltaDirectory === undefined ? {} : { directory: options.deltaDirectory });
    }
    if (result.outcome === "already_applied") continue;
    return "applied";
  }
  return "no_op";
}

async function main(): Promise<void> {
  try {
    const raw = readFileSync(0);
    if (raw.byteLength === 0 || raw.byteLength > MAX_STDIN_BYTES) return;
    await handleMemoryApplyCommand(JSON.parse(raw.toString("utf8")) as StopPayload);
  } catch {
    // Dormant best-effort maintenance must never block Stop.
  }
}

if (import.meta.main) await main();
