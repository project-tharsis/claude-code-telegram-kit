/** Dormant, host-controlled CAS applier for reviewed native-memory proposals. */
import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  acquireMemoryReviewProposalClaim,
  type MemoryReviewProposalRecord,
} from "./memory-review-proposal-store.js";
import { validateMemoryReviewProposal } from "./memory-review-proposal.js";
import {
  memoryReviewReceiptKey,
  type MemoryReviewReceipt,
} from "./memory-review-receipt.js";
import {
  observeNativeMemory,
  type NativeMemoryObservation,
} from "./native-memory-observer.js";
import { openExistingDirectoryFd } from "./fs-safety.js";
import {
  bytesHash,
  captureMemoryLeaf,
  imageBytes,
  journalName,
  listJournalNamesFd,
  openApplierStateDirectory,
  readJournalFd,
  readManagedLedgerBytesFd,
  readManagedLedgerFd,
  removeJournalFd,
  removeMemoryLeafCas,
  restoreManagedLedgerFd,
  sameMemoryImage,
  serializeManagedLedger,
  stateBytesHash,
  writeJournalFd,
  writeManagedLedgerFd,
  writeMemoryLeafCas,
  type MemoryApplyJournal,
  type MemoryApplyJournalFile,
  type MemoryLeafImage,
  type MemoryManagedLedger,
} from "./memory-applier-state.js";

const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TOPIC_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_IDLE_PROOF_AGE_MS = 30_000;
const GLOBAL_APPLY_SESSION_ID = "00000000-0000-4000-8000-000000000000";
const GLOBAL_APPLY_PROMPT_ID = "global-memory-apply";

export interface MemoryIdleProof {
  schema: 1;
  session_id: string;
  prompt_id: string;
  observed_at: number;
  background_tasks: unknown[];
  session_crons: unknown[];
  stop_hook_active: boolean;
}

export type MemoryApplierResult =
  | { outcome: "disabled" }
  | { outcome: "rejected"; reason: string }
  | {
      outcome: "applied" | "already_applied";
      path: string;
      before_sha256: string | null;
      after_sha256: string;
    }
  | { outcome: "crashed"; journal_id: string }
  | { outcome: "rolled_back"; reason: string }
  | { outcome: "rollback_conflict"; reason: string };

export interface ApplyMemoryReviewProposalOptions {
  enabled?: boolean;
  releaseSha: string;
  proposalRecord: MemoryReviewProposalRecord;
  receipt: MemoryReviewReceipt;
  observation: NativeMemoryObservation;
  idleProof: MemoryIdleProof;
  stateDirectory: string;
  proposalDirectory: string;
  now?: number;
  crashAfter?: "prepare" | "topic" | "index" | "ledger";
  /** Test/fault-injection seam. CAS remains authoritative after this callback returns. */
  beforeWrite?: (path: string) => void;
}

export interface RecoverMemoryReviewApplierOptions {
  releaseSha: string;
  memoryDirectory: string;
  directorySha256: string;
  idleProof: MemoryIdleProof;
  stateDirectory: string;
  proposalDirectory: string;
  now?: number;
}

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validIdleProof(proof: MemoryIdleProof, now: number): boolean {
  return (
    proof.schema === 1 &&
    SESSION_RE.test(proof.session_id) &&
    PROMPT_RE.test(proof.prompt_id) &&
    Number.isSafeInteger(proof.observed_at) &&
    proof.observed_at >= 0 &&
    now >= proof.observed_at &&
    now - proof.observed_at <= MAX_IDLE_PROOF_AGE_MS &&
    Array.isArray(proof.background_tasks) &&
    proof.background_tasks.length === 0 &&
    Array.isArray(proof.session_crons) &&
    proof.session_crons.length === 0 &&
    proof.stop_hook_active === false
  );
}

function stateOutsideMemory(stateDirectory: string, memoryDirectory: string): boolean {
  const relation = relative(resolve(memoryDirectory), resolve(stateDirectory));
  return relation !== "" && (relation === ".." || relation.startsWith("../"));
}

function validateBinding(options: ApplyMemoryReviewProposalOptions): string | null {
  const { proposalRecord, receipt, observation, idleProof } = options;
  if (!RELEASE_SHA_RE.test(options.releaseSha) || options.releaseSha !== proposalRecord.release_sha) {
    return "release_mismatch";
  }
  if (
    receipt.schema !== 3 ||
    proposalRecord.schema !== 1 ||
    !SESSION_RE.test(receipt.session_id) ||
    !PROMPT_RE.test(receipt.prompt_id) ||
    !SESSION_RE.test(proposalRecord.session_id) ||
    !PROMPT_RE.test(proposalRecord.prompt_id) ||
    !SHA256_RE.test(receipt.last_assistant_message_sha256) ||
    !SHA256_RE.test(receipt.snapshot_sha256) ||
    !SHA256_RE.test(proposalRecord.proposal_sha256) ||
    !SHA256_RE.test(proposalRecord.native_memory_watermark) ||
    !SHA256_RE.test(proposalRecord.snapshot_sha256) ||
    receipt.status !== "reviewed" ||
    receipt.session_id !== proposalRecord.session_id ||
    receipt.prompt_id !== proposalRecord.prompt_id ||
    receipt.release_sha !== proposalRecord.release_sha ||
    receipt.last_assistant_message_sha256 !== proposalRecord.last_assistant_message_sha256 ||
    receipt.snapshot_sha256 !== proposalRecord.snapshot_sha256
  ) {
    return "receipt_binding_mismatch";
  }
  if (
    observation.schema !== 1 ||
    observation.release_sha !== proposalRecord.release_sha ||
    observation.watermark !== proposalRecord.native_memory_watermark ||
    !SHA256_RE.test(observation.directory_sha256) ||
    !stateOutsideMemory(options.stateDirectory, observation.memoryDirectory) ||
    !stateOutsideMemory(options.proposalDirectory, observation.memoryDirectory)
  ) {
    return !stateOutsideMemory(options.stateDirectory, observation.memoryDirectory) ||
      !stateOutsideMemory(options.proposalDirectory, observation.memoryDirectory)
      ? "state_inside_native_memory"
      : "observation_binding_mismatch";
  }
  if (!validIdleProof(idleProof, options.now ?? Date.now()) || idleProof.session_id !== receipt.session_id) {
    return "idle_proof_mismatch";
  }
  let proposal;
  try {
    proposal = validateMemoryReviewProposal(proposalRecord.proposal);
  } catch {
    return "invalid_proposal";
  }
  if (
    proposal.target !== "managed_memory" ||
    (proposal.decision !== "create" && proposal.decision !== "patch") ||
    !TOPIC_RE.test(proposal.topic) ||
    sha256Text(JSON.stringify(proposal)) !== proposalRecord.proposal_sha256
  ) {
    return "unsupported_proposal";
  }
  return null;
}

function indexLine(topic: string, path: string): string {
  return `- [${topic}](${path})\n`;
}

function observationMatchesCurrent(observation: NativeMemoryObservation): boolean {
  try {
    const current = observeNativeMemory({
      memoryDirectory: observation.memoryDirectory,
      releaseSha: observation.release_sha,
      now: observation.observed_at,
    });
    return (
      current.directory_sha256 === observation.directory_sha256 &&
      current.watermark === observation.watermark
    );
  } catch {
    return false;
  }
}

function strictUtf8(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("MEMORY.md is not valid UTF-8");
  return text;
}

function journalFile(before: MemoryLeafImage, after: Buffer): MemoryApplyJournalFile {
  return {
    before,
    after_sha256: bytesHash(after),
    after_b64: after.toString("base64"),
  };
}

function ledgerAfter(
  before: MemoryManagedLedger | null,
  topic: string,
  topicSha256: string,
  proposalKey: string,
  now: number,
): MemoryManagedLedger {
  return {
    schema: 1,
    entries: [
      ...(before?.entries ?? []).filter(entry => entry.path !== topic),
      {
        path: topic,
        owner: "memory_review_applier" as const,
        sha256: topicSha256,
        proposal_key: proposalKey,
        updated_at: now,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function contentMatches(image: MemoryLeafImage, expected: MemoryLeafImage): boolean {
  return image.path === expected.path && image.exists === expected.exists && image.sha256 === expected.sha256;
}

function rollbackJournal(
  journal: MemoryApplyJournal,
  statefd: number,
): { conflicts: number } {
  let rootfd: number;
  try {
    if (!stateOutsideMemory(resolve(`/proc/self/fd/${statefd}`), journal.memory_directory)) {
      return { conflicts: 1 };
    }
    rootfd = openExistingDirectoryFd(journal.memory_directory, uid(), "native memory directory");
  } catch {
    return { conflicts: 1 };
  }
  let conflicts = 0;
  try {
    if (sha256Text(resolve(journal.memory_directory)) !== journal.directory_sha256) return { conflicts: 1 };
    for (const file of [...journal.files].reverse()) {
      let current: MemoryLeafImage;
      try {
        current = captureMemoryLeaf(rootfd, file.before.path, uid());
      } catch {
        conflicts += 1;
        continue;
      }
      if (contentMatches(current, file.before)) continue;
      if (!current.exists || current.sha256 !== file.after_sha256) {
        conflicts += 1;
        continue;
      }
      try {
        if (file.before.exists) {
          writeMemoryLeafCas(rootfd, current, imageBytes(file.before), uid());
        } else {
          removeMemoryLeafCas(rootfd, current, uid());
        }
      } catch {
        conflicts += 1;
      }
    }
  } finally {
    closeSync(rootfd);
  }
  const beforeLedger = journal.ledger_before_b64 === null
    ? null
    : Buffer.from(journal.ledger_before_b64, "base64");
  if (restoreManagedLedgerFd(statefd, beforeLedger, journal.ledger_after_sha256) === "conflict") {
    conflicts += 1;
  }
  if (conflicts === 0) removeJournalFd(statefd, journalName(journal.proposal_key));
  return { conflicts };
}

export function applyMemoryReviewProposal(
  options: ApplyMemoryReviewProposalOptions,
): MemoryApplierResult {
  if (options.enabled !== true) return { outcome: "disabled" };
  const invalid = validateBinding(options);
  if (invalid !== null) return { outcome: "rejected", reason: invalid };
  const proposalKey = memoryReviewReceiptKey(
    options.proposalRecord.session_id,
    options.proposalRecord.prompt_id,
  );
  let globalClaim: ReturnType<typeof acquireMemoryReviewProposalClaim>;
  try {
    globalClaim = acquireMemoryReviewProposalClaim(
      GLOBAL_APPLY_SESSION_ID,
      GLOBAL_APPLY_PROMPT_ID,
      { directory: options.stateDirectory },
    );
  } catch (error) {
    return {
      outcome: "rejected",
      reason: error instanceof Error ? error.message : "applier_claim_unavailable",
    };
  }
  if (globalClaim.outcome === "busy") {
    return { outcome: "rejected", reason: "applier_busy" };
  }
  let claim: ReturnType<typeof acquireMemoryReviewProposalClaim>;
  try {
    claim = acquireMemoryReviewProposalClaim(
      options.proposalRecord.session_id,
      options.proposalRecord.prompt_id,
      { directory: options.proposalDirectory },
    );
  } catch (error) {
    globalClaim.release();
    return {
      outcome: "rejected",
      reason: error instanceof Error ? error.message : "review_claim_unavailable",
    };
  }
  if (claim.outcome === "busy") {
    globalClaim.release();
    return { outcome: "rejected", reason: "review_active" };
  }

  let rootfd: number | null = null;
  let statefd: number | null = null;
  try {
    rootfd = openExistingDirectoryFd(
      options.observation.memoryDirectory,
      uid(),
      "native memory directory",
    );
    statefd = openApplierStateDirectory(options.stateDirectory);
    const pending = readJournalFd(statefd, journalName(proposalKey));
    if (pending !== null) {
      if (pending.phase === "committed") removeJournalFd(statefd, journalName(proposalKey));
      else return { outcome: "rejected", reason: "pending_recovery" };
    }

    const topic = `${options.proposalRecord.proposal.topic}.md`;
    const topicBefore = captureMemoryLeaf(rootfd, topic, uid());
    const topicAfter = Buffer.from(`${options.proposalRecord.proposal.content}\n`, "utf8");
    const managedBefore = readManagedLedgerFd(statefd);
    const owned = managedBefore?.entries.find(entry => entry.path === topic);
    let idempotentIndex = true;
    if (options.proposalRecord.proposal.decision === "create") {
      const currentIndex = captureMemoryLeaf(rootfd, "MEMORY.md", uid());
      const expectedLine = indexLine(options.proposalRecord.proposal.topic, topic);
      idempotentIndex = currentIndex.exists && strictUtf8(imageBytes(currentIndex)).split(expectedLine).length - 1 === 1;
    }
    if (
      owned !== undefined &&
      owned.proposal_key === proposalKey &&
      topicBefore.exists &&
      topicBefore.sha256 === owned.sha256 &&
      idempotentIndex
    ) {
      return {
        outcome: "already_applied",
        path: topic,
        before_sha256: topicBefore.sha256,
        after_sha256: topicBefore.sha256,
      };
    }
    if (!observationMatchesCurrent(options.observation)) {
      return { outcome: "rejected", reason: "observation_stale" };
    }
    const files: MemoryApplyJournalFile[] = [];

    if (options.proposalRecord.proposal.decision === "create") {
      if (topicBefore.exists) return { outcome: "rejected", reason: "create_cas_mismatch" };
      const indexBefore = captureMemoryLeaf(rootfd, "MEMORY.md", uid());
      if (!indexBefore.exists) return { outcome: "rejected", reason: "missing_memory_index" };
      const indexText = strictUtf8(imageBytes(indexBefore));
      const separator = indexText.length > 0 && !indexText.endsWith("\n") ? "\n" : "";
      const indexAfter = Buffer.from(
        `${indexText}${separator}${indexLine(options.proposalRecord.proposal.topic, topic)}`,
        "utf8",
      );
      files.push(journalFile(topicBefore, topicAfter), journalFile(indexBefore, indexAfter));
    } else {
      if (
        owned === undefined ||
        !topicBefore.exists ||
        owned.sha256 !== topicBefore.sha256
      ) {
        return { outcome: "rejected", reason: "unmanaged_topic" };
      }
      files.push(journalFile(topicBefore, topicAfter));
    }

    const now = options.now ?? Date.now();
    const nextLedger = ledgerAfter(
      managedBefore,
      topic,
      files[0]!.after_sha256,
      proposalKey,
      now,
    );
    const beforeLedgerBytes = readManagedLedgerBytesFd(statefd);
    const afterLedgerBytes = serializeManagedLedger(nextLedger);
    let journal: MemoryApplyJournal = {
      schema: 1,
      proposal_key: proposalKey,
      session_id: options.proposalRecord.session_id,
      prompt_id: options.proposalRecord.prompt_id,
      release_sha: options.releaseSha,
      directory_sha256: options.observation.directory_sha256,
      memory_directory: resolve(options.observation.memoryDirectory),
      phase: "prepared",
      files,
      ledger_before_b64: beforeLedgerBytes?.toString("base64") ?? null,
      ledger_before_sha256: stateBytesHash(beforeLedgerBytes),
      ledger_after_sha256: bytesHash(afterLedgerBytes),
      created_at: now,
    };
    writeJournalFd(statefd, journal);
    if (options.crashAfter === "prepare") return { outcome: "crashed", journal_id: proposalKey };

    try {
      options.beforeWrite?.(topic);
      writeMemoryLeafCas(rootfd, files[0]!.before, Buffer.from(files[0]!.after_b64, "base64"), uid());
      journal = { ...journal, phase: "topic_applied" };
      writeJournalFd(statefd, journal);
      if (options.crashAfter === "topic") return { outcome: "crashed", journal_id: proposalKey };

      if (files[1] !== undefined) {
        options.beforeWrite?.("MEMORY.md");
        writeMemoryLeafCas(rootfd, files[1].before, Buffer.from(files[1].after_b64, "base64"), uid());
        journal = { ...journal, phase: "index_applied" };
        writeJournalFd(statefd, journal);
        if (options.crashAfter === "index") return { outcome: "crashed", journal_id: proposalKey };
      }

      writeManagedLedgerFd(statefd, nextLedger);
      journal = { ...journal, phase: "ledger_applied" };
      writeJournalFd(statefd, journal);
      if (options.crashAfter === "ledger") return { outcome: "crashed", journal_id: proposalKey };

      journal = { ...journal, phase: "committed" };
      writeJournalFd(statefd, journal);
      try {
        removeJournalFd(statefd, journalName(proposalKey));
      } catch {
        // Commit receipt is durable. Recovery will remove this committed journal later.
      }
      return {
        outcome: "applied",
        path: topic,
        before_sha256: files[0]!.before.sha256,
        after_sha256: files[0]!.after_sha256,
      };
    } catch (error) {
      const rollback = rollbackJournal(journal, statefd);
      if (rollback.conflicts > 0) {
        return { outcome: "rollback_conflict", reason: "write_failed" };
      }
      return {
        outcome: "rolled_back",
        reason: error instanceof Error ? error.message : "write_failed",
      };
    }
  } catch (error) {
    return {
      outcome: "rejected",
      reason: error instanceof Error ? error.message : "applier_failure",
    };
  } finally {
    if (typeof statefd === "number") closeSync(statefd);
    if (rootfd !== null) closeSync(rootfd);
    claim.release();
    globalClaim.release();
  }
}

export function readManagedMemoryLedger(options: { directory: string }): MemoryManagedLedger | null {
  const statefd = openApplierStateDirectory(options.directory);
  try {
    return readManagedLedgerFd(statefd);
  } finally {
    closeSync(statefd);
  }
}

export function recoverMemoryReviewApplier(
  options: RecoverMemoryReviewApplierOptions,
): { outcome: "recovered" | "rollback_conflict"; rolled_back: number; conflicts: number } {
  const now = options.now ?? Date.now();
  if (
    !RELEASE_SHA_RE.test(options.releaseSha) ||
    !SHA256_RE.test(options.directorySha256) ||
    sha256Text(resolve(options.memoryDirectory)) !== options.directorySha256 ||
    !stateOutsideMemory(options.stateDirectory, options.memoryDirectory) ||
    !stateOutsideMemory(options.proposalDirectory, options.memoryDirectory) ||
    !validIdleProof(options.idleProof, now)
  ) {
    return { outcome: "rollback_conflict", rolled_back: 0, conflicts: 1 };
  }
  let globalClaim: ReturnType<typeof acquireMemoryReviewProposalClaim>;
  try {
    globalClaim = acquireMemoryReviewProposalClaim(
      GLOBAL_APPLY_SESSION_ID,
      GLOBAL_APPLY_PROMPT_ID,
      { directory: options.stateDirectory },
    );
  } catch {
    return { outcome: "rollback_conflict", rolled_back: 0, conflicts: 1 };
  }
  if (globalClaim.outcome === "busy") {
    return { outcome: "rollback_conflict", rolled_back: 0, conflicts: 1 };
  }
  let statefd: number | null = null;
  let rolledBack = 0;
  let conflicts = 0;
  try {
    statefd = openApplierStateDirectory(options.stateDirectory);
    for (const name of listJournalNamesFd(statefd)) {
      const journal = readJournalFd(statefd, name);
      if (journal === null) continue;
      if (
        journal.release_sha !== options.releaseSha ||
        journal.memory_directory !== resolve(options.memoryDirectory) ||
        journal.directory_sha256 !== options.directorySha256
      ) {
        conflicts += 1;
        continue;
      }
      if (journal.phase === "committed") {
        removeJournalFd(statefd, name);
        continue;
      }
      const claim = acquireMemoryReviewProposalClaim(
        journal.session_id,
        journal.prompt_id,
        { directory: options.proposalDirectory },
      );
      if (claim.outcome === "busy") {
        conflicts += 1;
        continue;
      }
      try {
        const result = rollbackJournal(journal, statefd);
        if (result.conflicts > 0) conflicts += 1;
        else rolledBack += 1;
      } finally {
        claim.release();
      }
    }
  } finally {
    if (typeof statefd === "number") closeSync(statefd);
    globalClaim.release();
  }
  return conflicts > 0
    ? { outcome: "rollback_conflict", rolled_back: rolledBack, conflicts }
    : { outcome: "recovered", rolled_back: rolledBack, conflicts: 0 };
}
