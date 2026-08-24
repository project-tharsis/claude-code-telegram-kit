/**
 * Strict schema for the isolated Memory Harness reviewer output (handoff doc section A5).
 *
 * The reviewer never writes memory directly. It returns exactly this shape, and any
 * out-of-schema field, overlong string, path-like value, credential-shaped content, or
 * unsupported target is rejected before host code ever sees a validated proposal.
 */

import { containsCredentialShape } from "./credential-patterns.js";

export const MEMORY_REVIEW_DECISIONS = ["create", "patch", "no_op"] as const;
export type MemoryReviewDecision = (typeof MEMORY_REVIEW_DECISIONS)[number];

export const MEMORY_REVIEW_TARGETS = ["managed_memory"] as const;
export type MemoryReviewTarget = (typeof MEMORY_REVIEW_TARGETS)[number];

export const MEMORY_REVIEW_FRESHNESS = ["standing", "verify_before_use"] as const;
export type MemoryReviewFreshness = (typeof MEMORY_REVIEW_FRESHNESS)[number];

export interface MemoryReviewProposal {
  decision: MemoryReviewDecision;
  target: MemoryReviewTarget;
  topic: string;
  evidence: string[];
  content: string;
  reason: string;
  freshness: MemoryReviewFreshness;
}

const MAX_TOPIC_CHARS = 64;
const MAX_CONTENT_CHARS = 4_000;
const MAX_REASON_CHARS = 400;
const MAX_EVIDENCE_ENTRIES = 8;
const MAX_EVIDENCE_CHARS = 160;
const TOPIC_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PATH_LIKE_RE = /(?:^|[\s"'`])(?:\.\.[\\/]|~[\\/]|\/(?:home|Users|srv|etc|var|opt|tmp|root)\/|[A-Za-z]:[\\/]|\\\\)/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

// containsCredentialShape is the shared source of truth (credential-patterns.ts, also used by
// the bounded snapshot builder's redaction pass); a reviewer that emits a credential-shaped
// string has already broken containment, so this rejects the proposal outright rather than
// redacting it.

function isBoundedString(value: unknown, maxChars: number, minChars = 1): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  if (length < minChars || length > maxChars) return false;
  return !CONTROL_CHARS_RE.test(value);
}

/**
 * Validates an already-parsed candidate object against the exact proposal schema. Throws on
 * any deviation; the caller (an immutable one-shot worker) always treats a thrown error as an
 * unusable proposal and never falls back to a partially-trusted shape.
 */
export function validateMemoryReviewProposal(value: unknown): MemoryReviewProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("proposal must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = ["decision", "target", "topic", "evidence", "content", "reason", "freshness"];
  const keys = Object.keys(record);
  if (keys.length !== allowedKeys.length || allowedKeys.some(key => !(key in record))) {
    throw new Error("proposal has an unsupported field shape");
  }

  if (typeof record.decision !== "string" || !MEMORY_REVIEW_DECISIONS.includes(record.decision as MemoryReviewDecision)) {
    throw new Error("invalid proposal decision");
  }
  if (typeof record.target !== "string" || !MEMORY_REVIEW_TARGETS.includes(record.target as MemoryReviewTarget)) {
    throw new Error("unsupported proposal target");
  }
  if (typeof record.freshness !== "string" || !MEMORY_REVIEW_FRESHNESS.includes(record.freshness as MemoryReviewFreshness)) {
    throw new Error("invalid proposal freshness");
  }
  if (!isBoundedString(record.topic, MAX_TOPIC_CHARS) || !TOPIC_RE.test(record.topic as string) || PATH_LIKE_RE.test(record.topic as string)) {
    throw new Error("invalid proposal topic");
  }
  const contentMinChars = record.decision === "no_op" ? 0 : 1;
  if (!isBoundedString(record.content, MAX_CONTENT_CHARS, contentMinChars)) throw new Error("invalid proposal content");
  if (!isBoundedString(record.reason, MAX_REASON_CHARS)) throw new Error("invalid proposal reason");
  if (PATH_LIKE_RE.test(record.content as string) || PATH_LIKE_RE.test(record.reason as string)) {
    throw new Error("proposal contains a path-like value");
  }
  if (containsCredentialShape(record.content as string) || containsCredentialShape(record.reason as string)) {
    throw new Error("proposal contains a credential-shaped value");
  }
  if (!Array.isArray(record.evidence) || record.evidence.length > MAX_EVIDENCE_ENTRIES) {
    throw new Error("invalid proposal evidence");
  }
  for (const item of record.evidence) {
    if (!isBoundedString(item, MAX_EVIDENCE_CHARS) || PATH_LIKE_RE.test(item) || containsCredentialShape(item)) {
      throw new Error("invalid proposal evidence entry");
    }
  }

  return {
    decision: record.decision as MemoryReviewDecision,
    target: record.target as MemoryReviewTarget,
    topic: record.topic as string,
    evidence: [...record.evidence] as string[],
    content: record.content as string,
    reason: record.reason as string,
    freshness: record.freshness as MemoryReviewFreshness
  };
}

export function parseMemoryReviewProposal(raw: string, maxBytes = 32 * 1024): MemoryReviewProposal | null {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    return validateMemoryReviewProposal(parsed);
  } catch {
    return null;
  }
}

export const MEMORY_REVIEW_PROPOSAL_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    decision: { type: "string", enum: [...MEMORY_REVIEW_DECISIONS] },
    target: { type: "string", enum: [...MEMORY_REVIEW_TARGETS] },
    topic: { type: "string", maxLength: MAX_TOPIC_CHARS },
    evidence: { type: "array", items: { type: "string", maxLength: MAX_EVIDENCE_CHARS }, maxItems: MAX_EVIDENCE_ENTRIES },
    content: { type: "string", maxLength: MAX_CONTENT_CHARS },
    reason: { type: "string", maxLength: MAX_REASON_CHARS },
    freshness: { type: "string", enum: [...MEMORY_REVIEW_FRESHNESS] }
  },
  required: ["decision", "target", "topic", "evidence", "content", "reason", "freshness"],
  additionalProperties: false
});
