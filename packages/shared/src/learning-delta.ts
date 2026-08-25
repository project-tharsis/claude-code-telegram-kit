import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { redactCredentials } from "./credential-patterns.js";
import { acquireMemoryReviewProposalClaim } from "./memory-review-proposal-store.js";
import {
  listSecureStateLeavesFd,
  openSecureStateDirectory,
  readSecureStateLeafFd,
  removeSecureStateLeafFd,
  writeSecureStateLeafFd,
} from "./secure-state-store.js";

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_RE = /^[0-9a-f]{64}$/;
const RELEASE_RE = /^[0-9a-f]{40}$/;
const TOPIC_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_BYTES = 12 * 1024;
const MAX_ENTRIES = 256;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const LOCK_SESSION_ID = "00000000-0000-4000-8000-000000000000";
const LOCK_PROMPT_ID = "learning-delta-consume";

export interface LearningDelta {
  schema: 1;
  receipt_id: string;
  session_id: string;
  release_sha: string;
  topics: string[];
  summary: string;
  expires_after_prompt: true;
  status: "pending" | "consumed";
  consumed_at: number | null;
  created_at: number;
}

export interface LearningDeltaStoreOptions {
  directory?: string;
  now?: () => number;
}

export function defaultLearningDeltaDirectory(): string {
  return join(homedir(), ".local", "state", "claude-code-telegram-kit", "memory-review", "learning-delta");
}

function directory(options: LearningDeltaStoreOptions): string {
  return resolve(options.directory ?? defaultLearningDeltaDirectory());
}

function name(sessionId: string): string {
  if (!SESSION_RE.test(sessionId)) throw new Error("invalid learning delta session");
  return `${createHash("sha256").update(sessionId).digest("hex")}.delta.json`;
}

export function validateLearningDelta(value: unknown): LearningDelta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid learning delta");
  const record = value as Record<string, unknown>;
  const allowed = ["schema", "receipt_id", "session_id", "release_sha", "topics", "summary", "expires_after_prompt", "status", "consumed_at", "created_at"];
  if (
    Object.keys(record).length !== allowed.length ||
    allowed.some(field => !(field in record)) ||
    record.schema !== 1 ||
    typeof record.receipt_id !== "string" ||
    !RECEIPT_RE.test(record.receipt_id) ||
    typeof record.session_id !== "string" ||
    !SESSION_RE.test(record.session_id) ||
    typeof record.release_sha !== "string" ||
    !RELEASE_RE.test(record.release_sha) ||
    !Array.isArray(record.topics) ||
    record.topics.length < 1 ||
    record.topics.length > 8 ||
    !record.topics.every(topic => typeof topic === "string" && TOPIC_RE.test(topic)) ||
    typeof record.summary !== "string" ||
    Array.from(record.summary).length < 1 ||
    Array.from(record.summary).length > 1_200 ||
    record.expires_after_prompt !== true ||
    (record.status !== "pending" && record.status !== "consumed") ||
    (record.consumed_at !== null && (!Number.isSafeInteger(record.consumed_at) || Number(record.consumed_at) < 0)) ||
    (record.status === "pending" && record.consumed_at !== null) ||
    (record.status === "consumed" && record.consumed_at === null) ||
    (record.status === "consumed" && Number(record.consumed_at) < Number(record.created_at)) ||
    !Number.isSafeInteger(record.created_at) ||
    Number(record.created_at) < 0
  ) throw new Error("invalid learning delta");
  return {
    schema: 1,
    receipt_id: record.receipt_id,
    session_id: record.session_id,
    release_sha: record.release_sha,
    topics: [...record.topics] as string[],
    summary: record.summary,
    expires_after_prompt: true,
    status: record.status as "pending" | "consumed",
    consumed_at: record.consumed_at === null ? null : Number(record.consumed_at),
    created_at: Number(record.created_at),
  };
}

function parse(bytes: Buffer): LearningDelta {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("invalid learning delta JSON"); }
  return validateLearningDelta(value);
}

export interface WriteLearningDeltaInput {
  receiptId: string;
  sessionId: string;
  releaseSha: string;
  topics: string[];
  summary: string;
  createdAt: number;
}

export function writeLearningDelta(
  input: WriteLearningDeltaInput,
  options: LearningDeltaStoreOptions = {},
): LearningDelta {
  const record = validateLearningDelta({
    receipt_id: input.receiptId,
    session_id: input.sessionId,
    release_sha: input.releaseSha,
    topics: input.topics,
    created_at: input.createdAt,
    schema: 1,
    expires_after_prompt: true,
    status: "pending",
    consumed_at: null,
    summary: Array.from(redactCredentials(input.summary)).slice(0, 1_200).join(""),
  });
  const targetDirectory = directory(options);
  const claim = acquireMemoryReviewProposalClaim(LOCK_SESSION_ID, LOCK_PROMPT_ID, { directory: targetDirectory });
  if (claim.outcome === "busy") throw new Error("learning delta store busy");
  let dirfd: number | null = null;
  try {
    dirfd = openSecureStateDirectory(targetDirectory, "learning delta directory");
    const leaf = name(record.session_id);
    const names = listSecureStateLeavesFd(dirfd, ".delta.json", MAX_ENTRIES);
    if (!names.includes(leaf) && names.length >= MAX_ENTRIES) {
      const consumed = names
        .map(candidate => ({ candidate, delta: parse(readSecureStateLeafFd(dirfd!, candidate, MAX_BYTES)!) }))
        .filter(item => item.delta.status === "consumed")
        .sort((left, right) => (left.delta.consumed_at ?? 0) - (right.delta.consumed_at ?? 0));
      if (consumed.length === 0) throw new Error("learning delta capacity exceeded");
      removeSecureStateLeafFd(dirfd, consumed[0]!.candidate, MAX_BYTES);
    }
    const existingBytes = readSecureStateLeafFd(dirfd, leaf, MAX_BYTES);
    if (existingBytes !== null) {
      const existing = parse(existingBytes);
      if (existing.receipt_id === record.receipt_id && existing.release_sha === record.release_sha) return existing;
      if (existing.status === "pending") throw new Error("learning delta conflict");
    }
    writeSecureStateLeafFd(dirfd, leaf, Buffer.from(JSON.stringify(record)), MAX_BYTES);
    return record;
  } finally {
    if (typeof dirfd === "number") closeSync(dirfd);
    claim.release();
  }
}

export function readLearningDelta(
  sessionId: string,
  options: LearningDeltaStoreOptions = {},
): LearningDelta | null {
  const dirfd = openSecureStateDirectory(directory(options), "learning delta directory");
  try {
    const bytes = readSecureStateLeafFd(dirfd, name(sessionId), MAX_BYTES);
    const delta = bytes === null ? null : parse(bytes);
    return delta?.status === "pending" ? delta : null;
  } finally {
    closeSync(dirfd);
  }
}

export function peekLearningDelta(
  input: {
    sessionId: string;
    releaseSha: string;
    isDirectTelegram: boolean;
    isControlCommand?: boolean;
    isInternalTurn?: boolean;
  },
  options: LearningDeltaStoreOptions = {},
): LearningDelta | null {
  if (!input.isDirectTelegram || input.isControlCommand === true || input.isInternalTurn === true || !RELEASE_RE.test(input.releaseSha)) return null;
  const delta = readLearningDelta(input.sessionId, options);
  if (delta === null) return null;
  const now = (options.now ?? Date.now)();
  if (delta.release_sha !== input.releaseSha || now < delta.created_at || now - delta.created_at > MAX_AGE_MS) {
    acknowledgeLearningDelta(input.sessionId, delta.receipt_id, options);
    return null;
  }
  return delta;
}

function acknowledgeLearningDeltaUnlocked(
  sessionId: string,
  receiptId: string,
  options: LearningDeltaStoreOptions,
): boolean {
  let dirfd: number | null = null;
  try {
    dirfd = openSecureStateDirectory(directory(options), "learning delta directory");
    const leaf = name(sessionId);
    const bytes = readSecureStateLeafFd(dirfd, leaf, MAX_BYTES);
    if (bytes === null) return false;
    const delta = parse(bytes);
    if (delta.status !== "pending" || delta.receipt_id !== receiptId) return false;
    const now = (options.now ?? Date.now)();
    const consumed: LearningDelta = {
      ...delta,
      status: "consumed",
      consumed_at: now < delta.created_at ? delta.created_at : now,
    };
    writeSecureStateLeafFd(dirfd, leaf, Buffer.from(JSON.stringify(consumed)), MAX_BYTES);
    return true;
  } finally {
    if (dirfd !== null) closeSync(dirfd);
  }
}

export function acknowledgeLearningDelta(
  sessionId: string,
  receiptId: string,
  options: LearningDeltaStoreOptions = {},
): boolean {
  if (!SESSION_RE.test(sessionId) || !RECEIPT_RE.test(receiptId)) return false;
  const targetDirectory = directory(options);
  const claim = acquireMemoryReviewProposalClaim(LOCK_SESSION_ID, LOCK_PROMPT_ID, { directory: targetDirectory });
  if (claim.outcome === "busy") return false;
  try {
    return acknowledgeLearningDeltaUnlocked(sessionId, receiptId, options);
  } finally {
    claim.release();
  }
}

export interface LearningDeltaClaim {
  delta: LearningDelta;
  acknowledge: () => boolean;
  release: () => void;
}

export function claimLearningDelta(
  input: {
    sessionId: string;
    releaseSha: string;
    isDirectTelegram: boolean;
    isControlCommand?: boolean;
    isInternalTurn?: boolean;
  },
  options: LearningDeltaStoreOptions = {},
): LearningDeltaClaim | null {
  if (!input.isDirectTelegram || input.isControlCommand === true || input.isInternalTurn === true || !RELEASE_RE.test(input.releaseSha)) return null;
  const claim = acquireMemoryReviewProposalClaim(LOCK_SESSION_ID, LOCK_PROMPT_ID, { directory: directory(options) });
  if (claim.outcome === "busy") return null;
  let delta: LearningDelta | null;
  try {
    delta = readLearningDelta(input.sessionId, options);
  } catch (error) {
    claim.release();
    throw error;
  }
  const now = (options.now ?? Date.now)();
  if (delta === null || delta.release_sha !== input.releaseSha || now < delta.created_at || now - delta.created_at > MAX_AGE_MS) {
    claim.release();
    return null;
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    claim.release();
  };
  return {
    delta,
    release,
    acknowledge: () => {
      if (released) return false;
      try {
        return acknowledgeLearningDeltaUnlocked(input.sessionId, delta.receipt_id, options);
      } finally {
        release();
      }
    },
  };
}

export function consumeLearningDelta(
  input: {
    sessionId: string;
    releaseSha: string;
    isDirectTelegram: boolean;
    isControlCommand?: boolean;
    isInternalTurn?: boolean;
  },
  options: LearningDeltaStoreOptions = {},
): LearningDelta | null {
  const delta = peekLearningDelta(input, options);
  if (delta === null) return null;
  return acknowledgeLearningDelta(input.sessionId, delta.receipt_id, options) ? delta : null;
}

export function formatLearningDeltaContext(delta: LearningDelta): string {
  return `Learning delta (one use; receipt ${delta.receipt_id.slice(0, 12)}): ${delta.summary}`;
}
