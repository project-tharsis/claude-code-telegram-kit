#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryReviewProposal } from "@project-tharsis/claude-code-telegram-shared";
import {
  acquireMemoryReviewProposalClaim,
  MemoryReviewProposalStoreError,
  createMemoryReviewProposalRecord,
  readMemoryReviewProposalRecord,
  readMemoryReviewReceipt,
  beginMemoryReviewAttempt,
  recordMemoryReviewFailure,
  type MemoryReviewFailurePhase,
  type MemoryReviewFailureReason,
  transitionMemoryReviewReceipt
} from "@project-tharsis/claude-code-telegram-shared";
import { generateMemoryReviewProposal, MemoryReviewGenerationError } from "./memory-review-generator.js";
import { memoryReviewSnapshotDigest, validateMemoryReviewSnapshot, type MemoryReviewSnapshot } from "./memory-review-snapshot.js";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SNAPSHOT_BYTES = 32 * 1024;

export type MemoryReviewWorkerResult =
  | { outcome: "reviewed"; proposal: MemoryReviewProposal }
  | { outcome: "no_op" }
  | { outcome: "retry"; reason: string }
  | { outcome: "failed"; reason: string };

export function memoryReviewWorkerExitCode(result: MemoryReviewWorkerResult): number {
  if (result.outcome === "retry") return 75;
  if (result.outcome === "failed") return 1;
  return 0;
}

export interface MemoryReviewWorkerOptions {
  sessionId: string;
  promptId: string;
  snapshot: MemoryReviewSnapshot;
  receiptDirectory?: string;
  proposalDirectory?: string;
  now?: () => number;
  review?: (snapshot: MemoryReviewSnapshot) => Promise<MemoryReviewProposal>;
  transitionReceipt?: typeof transitionMemoryReviewReceipt;
}

/**
 * The immutable one-shot reviewer entrypoint. It never touches the transcript, the memory
 * tree, or any file beyond the exact receipt it is bound to: it reads one queued receipt by
 * (session_id, prompt_id), runs one isolated model call against the caller-supplied bounded
 * snapshot, validates the result against the strict proposal schema, and transitions that
 * one receipt to a terminal status. It has no write authority over anything else.
 */
export async function runMemoryReviewWorker(options: MemoryReviewWorkerOptions): Promise<MemoryReviewWorkerResult> {
  if (!SESSION_UUID.test(options.sessionId)) throw new Error("invalid session identity");
  if (!PROMPT_ID_RE.test(options.promptId)) throw new Error("invalid prompt identity");

  const storeOptions = options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory };
  const proposalDirectory = options.proposalDirectory
    ?? (options.receiptDirectory === undefined ? undefined : join(options.receiptDirectory, "proposals"));
  const proposalStoreOptions = proposalDirectory === undefined ? {} : { directory: proposalDirectory };
  const receipt = readMemoryReviewReceipt(options.sessionId, options.promptId, storeOptions);
  if (receipt === null || receipt.status !== "queued") {
    throw new Error("no queued review receipt for this session/prompt");
  }

  const transitionReceipt = options.transitionReceipt ?? transitionMemoryReviewReceipt;
  let currentReceipt = receipt;
  const persistFailure = (
    phase: MemoryReviewFailurePhase,
    reason: MemoryReviewFailureReason,
    terminal: boolean
  ): MemoryReviewWorkerResult => {
    const persisted = recordMemoryReviewFailure(
      options.sessionId, options.promptId, phase, reason, terminal, storeOptions
    );
    if (persisted === null) return { outcome: "failed", reason: "receipt_transition:unavailable" };
    currentReceipt = persisted;
    return terminal
      ? { outcome: "failed", reason: `${phase}:${reason}` }
      : { outcome: "retry", reason: `${phase}:${reason}` };
  };
  const recoverableFailure = (
    phase: MemoryReviewFailurePhase,
    reason: MemoryReviewFailureReason
  ): MemoryReviewWorkerResult => persistFailure(
    phase,
    reason,
    currentReceipt.attempts >= 2 || currentReceipt.failure_phase !== undefined
  );

  let claim: ReturnType<typeof acquireMemoryReviewProposalClaim>;
  try {
    claim = acquireMemoryReviewProposalClaim(options.sessionId, options.promptId, proposalStoreOptions);
  } catch {
    return recoverableFailure("review_claim", "unavailable");
  }
  if (claim.outcome === "busy") return { outcome: "failed", reason: "review_claim:busy" };

  try {
    const snapshotSha256 = memoryReviewSnapshotDigest(options.snapshot);
    if (options.snapshot.sessionId !== options.sessionId || options.snapshot.promptId !== options.promptId ||
        options.snapshot.releaseSha !== receipt.release_sha ||
        options.snapshot.assistantMessageSha256 !== receipt.last_assistant_message_sha256 ||
        snapshotSha256 !== receipt.snapshot_sha256) {
      persistFailure("snapshot", "binding_mismatch", true);
      return { outcome: "failed", reason: "snapshot:binding_mismatch" };
    }
    const finish = (proposal: MemoryReviewProposal): MemoryReviewWorkerResult => {
    let transitioned: boolean;
    try {
      transitioned = transitionReceipt(options.sessionId, options.promptId, "reviewed", storeOptions);
    } catch {
      return recoverableFailure("receipt_transition", "unavailable");
    }
    if (!transitioned) {
      let latest: ReturnType<typeof readMemoryReviewReceipt>;
      try {
        latest = readMemoryReviewReceipt(options.sessionId, options.promptId, storeOptions);
      } catch {
        return recoverableFailure("receipt_transition", "unavailable");
      }
      if (latest?.status !== "reviewed") {
        if (latest?.status === "queued") currentReceipt = latest;
        return recoverableFailure("receipt_transition", "unavailable");
      }
    }
    return proposal.decision === "no_op" ? { outcome: "no_op" } : { outcome: "reviewed", proposal };
  };

  let existing: ReturnType<typeof readMemoryReviewProposalRecord>;
  try {
    existing = readMemoryReviewProposalRecord(options.sessionId, options.promptId, proposalStoreOptions);
  } catch (error) {
    if (error instanceof MemoryReviewProposalStoreError && error.permanent) {
      persistFailure("proposal_store", "invalid_record", true);
      return { outcome: "failed", reason: `proposal_store:${error.reason}` };
    }
    return recoverableFailure("proposal_store", "unavailable");
  }
  if (existing !== null) {
    if (existing.session_id !== options.sessionId || existing.prompt_id !== options.promptId ||
        existing.release_sha !== receipt.release_sha ||
        existing.last_assistant_message_sha256 !== receipt.last_assistant_message_sha256 ||
        existing.native_memory_watermark !== options.snapshot.nativeMemoryWatermark ||
        existing.snapshot_sha256 !== snapshotSha256) {
      persistFailure("proposal_store", "binding_mismatch", true);
      return { outcome: "failed", reason: "proposal_store:binding_mismatch" };
    }
    return finish(existing.proposal);
  }

  const attempt = beginMemoryReviewAttempt(options.sessionId, options.promptId, storeOptions);
  if (attempt === null) {
    persistFailure("worker", "unavailable", true);
    return { outcome: "failed", reason: "review_attempt:exhausted" };
  }
  currentReceipt = attempt;
  const review = options.review ?? (snapshot => generateMemoryReviewProposal(snapshot));
  let proposal: MemoryReviewProposal;
  try {
    proposal = await review(options.snapshot);
  } catch (error) {
    // Retryable generation failures preserve the queued receipt. Proven permanent model/schema
    // failures terminalize it exactly once.
    const generationError = error instanceof MemoryReviewGenerationError ? error : null;
    const phase = generationError?.phase === "parse" ? "parse" : "generate" as MemoryReviewFailurePhase;
    const reason: MemoryReviewFailureReason = generationError?.reason === "timeout" ? "timeout"
      : generationError?.reason === "rate_limited" ? "rate_limited"
      : generationError?.reason === "invalid_output" ? "invalid_output" : "command_failed";
    if (generationError !== null && generationError.retryable) return recoverableFailure(phase, reason);
    return persistFailure(phase, reason, true);
  }

  try {
    const persisted = createMemoryReviewProposalRecord({
      sessionId: options.sessionId,
      promptId: options.promptId,
      releaseSha: receipt.release_sha,
      lastAssistantMessageSha256: receipt.last_assistant_message_sha256,
      nativeMemoryWatermark: options.snapshot.nativeMemoryWatermark,
      snapshotSha256,
      proposal
    }, { ...proposalStoreOptions, now: options.now ?? Date.now });
    return finish(persisted.record.proposal);
  } catch (error) {
    // Unknown I/O durability stays retryable. Validated corruption/conflicts are permanent local
    // failures and must not leave a receipt retrying forever.
    if (error instanceof MemoryReviewProposalStoreError && error.permanent) {
      persistFailure("proposal_store", "invalid_record", true);
      return { outcome: "failed", reason: `proposal_store:${error.reason}` };
    }
    return recoverableFailure("proposal_store", "unavailable");
  }
  } finally {
    claim.release();
  }
}

interface WorkerStdin {
  snapshot: MemoryReviewSnapshot;
}

/**
 * Parses the exact `{"snapshot": ...}` wire shape serializeMemoryReviewSnapshot produces
 * (memory-review-snapshot.ts). Exported so the producer/consumer round-trip can be exercised
 * directly against real bytes in tests, without spawning a subprocess.
 */
export function parseSnapshotFromStdin(raw: Buffer): MemoryReviewSnapshot {
  if (raw.byteLength === 0 || raw.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("invalid snapshot input");
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !("snapshot" in parsed)) {
    throw new Error("invalid snapshot input");
  }
  return validateMemoryReviewSnapshot((parsed as WorkerStdin).snapshot);
}

function readSnapshotFromStdin(): MemoryReviewSnapshot {
  return parseSnapshotFromStdin(readFileSync(0));
}

if (import.meta.main) {
  (async () => {
    try {
      const sessionId = process.argv[2];
      const promptId = process.argv[3];
      if (process.argv.length !== 4 || typeof sessionId !== "string" || typeof promptId !== "string") {
        throw new Error("exactly one session ID and one prompt ID are required");
      }
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error("authenticated review source is unavailable");
      }
      const snapshot = readSnapshotFromStdin();
      const result = await runMemoryReviewWorker({ sessionId, promptId, snapshot });
      process.exitCode = memoryReviewWorkerExitCode(result);
    } catch {
      process.exitCode = 1;
    }
  })();
}
