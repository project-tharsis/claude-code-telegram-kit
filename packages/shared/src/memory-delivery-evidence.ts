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
const PROMPT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_RE = /^[0-9a-f]{40}$/;
const MAX_BYTES = 8 * 1024;
const MAX_ENTRIES = 512;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCK_SESSION_ID = "00000000-0000-4000-8000-000000000000";
const LOCK_PROMPT_ID = "delivery-evidence-write";
const CORRECTION_RE = /(?:请记住|记住(?:这|我)|以后(?:不要|别|请)|不要再|别再|我(?:不喜欢|更喜欢|偏好)|改成|不是这样|不对|remember\b|from now on|do not|don't|stop using|i prefer|i dislike)/iu;

export interface MemoryDeliveryEvidence {
  schema: 1;
  session_id: string;
  prompt_id: string;
  outcome: "delivered";
  foreground: true;
  source_message_id: number;
  delivered_message_ids: number[];
  assistant_message_sha256: string;
  release_sha: string;
  observed_at: number;
  turn_ordinal: number;
  user_message: string;
  user_correction: boolean;
  tool_iterations: number;
}

export interface PersistMemoryDeliveryEvidenceInput {
  sessionId: string;
  promptId: string;
  sourceMessageId: number;
  deliveredMessageIds: number[];
  assistantMessage: string;
  releaseSha: string;
  observedAt?: number;
  userMessage: string;
  toolIterations: number;
}

export interface MemoryDeliveryEvidenceStoreOptions {
  directory?: string;
  now?: () => number;
}

export function defaultMemoryDeliveryEvidenceDirectory(): string {
  return join(homedir(), ".local", "state", "claude-code-telegram-kit", "memory-review", "delivery-evidence");
}

function bounded(value: string, max: number): string {
  return Array.from(redactCredentials(value)).slice(0, max).join("");
}

function key(sessionId: string, promptId: string): string {
  if (!SESSION_RE.test(sessionId) || !PROMPT_RE.test(promptId)) throw new Error("invalid delivery evidence identity");
  return `${createHash("sha256").update(`${sessionId}\0${promptId}`).digest("hex")}.delivery.json`;
}

export function isExplicitMemoryCorrection(userMessage: string): boolean {
  return Array.from(userMessage).length <= 8_000 && CORRECTION_RE.test(userMessage);
}

export function validateMemoryDeliveryEvidence(value: unknown): MemoryDeliveryEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid delivery evidence");
  const record = value as Record<string, unknown>;
  const allowed = [
    "schema", "session_id", "prompt_id", "outcome", "foreground", "source_message_id",
    "delivered_message_ids", "assistant_message_sha256", "release_sha", "observed_at",
    "turn_ordinal", "user_message", "user_correction", "tool_iterations",
  ];
  if (
    Object.keys(record).length !== allowed.length ||
    allowed.some(field => !(field in record)) ||
    record.schema !== 1 ||
    typeof record.session_id !== "string" ||
    !SESSION_RE.test(record.session_id) ||
    typeof record.prompt_id !== "string" ||
    !PROMPT_RE.test(record.prompt_id) ||
    record.outcome !== "delivered" ||
    record.foreground !== true ||
    !Number.isSafeInteger(record.source_message_id) ||
    Number(record.source_message_id) < 1 ||
    !Array.isArray(record.delivered_message_ids) ||
    record.delivered_message_ids.length < 1 ||
    record.delivered_message_ids.length > 20 ||
    !record.delivered_message_ids.every(id => Number.isSafeInteger(id) && Number(id) >= 1) ||
    typeof record.assistant_message_sha256 !== "string" ||
    !SHA256_RE.test(record.assistant_message_sha256) ||
    typeof record.release_sha !== "string" ||
    !RELEASE_RE.test(record.release_sha) ||
    !Number.isSafeInteger(record.observed_at) ||
    Number(record.observed_at) < 0 ||
    !Number.isSafeInteger(record.turn_ordinal) ||
    Number(record.turn_ordinal) < 1 ||
    Number(record.turn_ordinal) > 1_000_000 ||
    typeof record.user_message !== "string" ||
    Array.from(record.user_message).length < 1 ||
    Array.from(record.user_message).length > 1_200 ||
    typeof record.user_correction !== "boolean" ||
    !Number.isSafeInteger(record.tool_iterations) ||
    Number(record.tool_iterations) < 0 ||
    Number(record.tool_iterations) > 10_000
  ) throw new Error("invalid delivery evidence");
  return {
    schema: 1,
    session_id: record.session_id,
    prompt_id: record.prompt_id,
    outcome: "delivered",
    foreground: true,
    source_message_id: Number(record.source_message_id),
    delivered_message_ids: [...record.delivered_message_ids] as number[],
    assistant_message_sha256: record.assistant_message_sha256,
    release_sha: record.release_sha,
    observed_at: Number(record.observed_at),
    turn_ordinal: Number(record.turn_ordinal),
    user_message: record.user_message,
    user_correction: record.user_correction,
    tool_iterations: Number(record.tool_iterations),
  };
}

function parse(bytes: Buffer): MemoryDeliveryEvidence {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("invalid delivery evidence JSON"); }
  return validateMemoryDeliveryEvidence(value);
}

function directory(options: MemoryDeliveryEvidenceStoreOptions): string {
  return resolve(options.directory ?? defaultMemoryDeliveryEvidenceDirectory());
}

function readByName(dirfd: number, name: string): MemoryDeliveryEvidence {
  const bytes = readSecureStateLeafFd(dirfd, name, MAX_BYTES);
  if (bytes === null) throw new Error("delivery evidence disappeared");
  return parse(bytes);
}

export function persistMemoryDeliveryEvidence(
  input: PersistMemoryDeliveryEvidenceInput,
  options: MemoryDeliveryEvidenceStoreOptions = {},
): MemoryDeliveryEvidence {
  if (
    !SESSION_RE.test(input.sessionId) ||
    !PROMPT_RE.test(input.promptId) ||
    !Number.isSafeInteger(input.sourceMessageId) ||
    input.sourceMessageId < 1 ||
    !Array.isArray(input.deliveredMessageIds) ||
    input.deliveredMessageIds.length < 1 ||
    input.deliveredMessageIds.length > 20 ||
    !input.deliveredMessageIds.every(id => Number.isSafeInteger(id) && id >= 1) ||
    !RELEASE_RE.test(input.releaseSha) ||
    !Number.isSafeInteger(input.toolIterations) ||
    input.toolIterations < 0 ||
    typeof input.userMessage !== "string" ||
    input.userMessage.trim() === "" ||
    typeof input.assistantMessage !== "string" ||
    input.assistantMessage.trim() === "" ||
    (input.observedAt !== undefined && (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0))
  ) throw new Error("invalid delivery evidence input");
  const assistantSha = createHash("sha256").update(input.assistantMessage).digest("hex");
  const userMessage = bounded(input.userMessage, 1_200);
  const userCorrection = isExplicitMemoryCorrection(input.userMessage);
  const observedAt = input.observedAt ?? (options.now ?? Date.now)();
  const targetDirectory = directory(options);
  const claim = acquireMemoryReviewProposalClaim(LOCK_SESSION_ID, LOCK_PROMPT_ID, { directory: targetDirectory });
  if (claim.outcome === "busy") throw new Error("delivery evidence store busy");
  let dirfd: number | null = null;
  try {
    dirfd = openSecureStateDirectory(targetDirectory, "delivery evidence directory");
    let names = listSecureStateLeavesFd(dirfd, ".delivery.json", MAX_ENTRIES);
    let records = names.map(name => ({ name, record: readByName(dirfd!, name) }));
    for (const item of records) {
      if (observedAt >= item.record.observed_at && observedAt - item.record.observed_at > RETENTION_MS) {
        removeSecureStateLeafFd(dirfd, item.name, MAX_BYTES);
      }
    }
    records = records.filter(item => observedAt < item.record.observed_at || observedAt - item.record.observed_at <= RETENTION_MS);
    names = records.map(item => item.name);
    const targetName = key(input.sessionId, input.promptId);
    if (names.includes(targetName)) {
      const existing = readByName(dirfd, targetName);
      if (
        existing.source_message_id !== input.sourceMessageId ||
        existing.assistant_message_sha256 !== assistantSha ||
        existing.release_sha !== input.releaseSha ||
        JSON.stringify(existing.delivered_message_ids) !== JSON.stringify(input.deliveredMessageIds) ||
        existing.user_message !== userMessage ||
        existing.user_correction !== userCorrection ||
        existing.tool_iterations !== input.toolIterations
      ) throw new Error("delivery evidence conflict");
      return existing;
    }
    let ordinal = 1;
    for (const item of records) {
      if (item.record.session_id === input.sessionId) ordinal = Math.max(ordinal, item.record.turn_ordinal + 1);
    }
    if (records.length >= MAX_ENTRIES) {
      records.sort((left, right) => left.record.observed_at - right.record.observed_at);
      removeSecureStateLeafFd(dirfd, records[0]!.name, MAX_BYTES);
    }
    const record = validateMemoryDeliveryEvidence({
      schema: 1,
      session_id: input.sessionId,
      prompt_id: input.promptId,
      outcome: "delivered",
      foreground: true,
      source_message_id: input.sourceMessageId,
      delivered_message_ids: [...input.deliveredMessageIds],
      assistant_message_sha256: assistantSha,
      release_sha: input.releaseSha,
      observed_at: observedAt,
      turn_ordinal: ordinal,
      user_message: userMessage,
      user_correction: userCorrection,
      tool_iterations: input.toolIterations,
    });
    writeSecureStateLeafFd(dirfd, key(record.session_id, record.prompt_id), Buffer.from(JSON.stringify(record)), MAX_BYTES);
    return record;
  } finally {
    if (dirfd !== null) closeSync(dirfd);
    claim.release();
  }
}

export function readMemoryDeliveryEvidence(
  sessionId: string,
  promptId: string,
  options: MemoryDeliveryEvidenceStoreOptions = {},
): MemoryDeliveryEvidence | null {
  const dirfd = openSecureStateDirectory(directory(options), "delivery evidence directory");
  try {
    const bytes = readSecureStateLeafFd(dirfd, key(sessionId, promptId), MAX_BYTES);
    if (bytes === null) return null;
    const record = parse(bytes);
    if (record.session_id !== sessionId || record.prompt_id !== promptId) throw new Error("delivery evidence identity mismatch");
    const now = (options.now ?? Date.now)();
    if (record.observed_at > now || now - record.observed_at > RETENTION_MS) return null;
    return record;
  } finally {
    closeSync(dirfd);
  }
}
