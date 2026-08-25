/**
 * Bounded review snapshot builder (handoff doc section A4).
 *
 * The isolated reviewer never sees a transcript. It sees only this pre-extracted, bounded,
 * redacted object. Every field the caller supplies is treated as untrusted transcript-derived
 * text: it is truncated to a fixed character budget, credential-shaped substrings are
 * replaced with a fixed marker, and entry/file counts are capped independently of content
 * size so a single oversized array cannot smuggle unbounded context past the caps below.
 *
 * What this module deliberately never accepts: thinking blocks, raw web/tool response
 * bodies, full tool output, Telegram envelope/chat/session identifiers, or unresolved/
 * transient-error text. Those exclusions are enforced by the narrow input shape itself,
 * not by a filter — there is no field here wide enough to hold them.
 */

import { createHash } from "node:crypto";
import { containsCredentialShape, redactCredentials } from "@project-tharsis/claude-code-telegram-shared";

const MAX_FIELD_CHARS = 1_200;
const MAX_TOTAL_CHARS = 6_000;
const MAX_EARLIER_DIGESTS = 6;
const MAX_TOOL_ENTRIES = 20;
const MAX_TOPIC_EXCERPTS = 4;
const MAX_TOOL_NAME_CHARS = 60;

// The credential pattern source lives in @project-tharsis/claude-code-telegram-shared
// (credential-patterns.ts) so this redaction pass and the strict proposal validator's rejection
// check can never independently drift from each other again.
function redact(value: string): string {
  return redactCredentials(value);
}

function bounded(value: unknown, maxChars = MAX_FIELD_CHARS): string {
  const text = typeof value === "string" ? value : "";
  // Redact first, then truncate: a credential-shaped match that straddles the maxChars
  // boundary can expand under redaction (the raw matched text can be shorter than the
  // "[redacted]" marker), so truncating before redacting can let the final string exceed
  // maxChars. Truncating again after redaction keeps the output truly bounded and never cuts
  // a redaction marker itself in half, since the truncation is applied to the already-final
  // redacted text.
  return Array.from(redact(text)).slice(0, maxChars).join("");
}

export type MemoryReviewToolClassification = "success" | "failure";

export interface MemoryReviewSnapshotToolEntry {
  name: string;
  classification: MemoryReviewToolClassification;
}

export interface MemoryReviewSnapshotTopicExcerpt {
  path: string;
  contentHash: string;
  excerpt: string;
}

export interface MemoryReviewSnapshotInput {
  sessionId: string;
  promptId: string;
  assistantMessageSha256: string;
  userMessage: string;
  assistantFinal: string;
  recentCorrections?: string[];
  earlierTurnDigests?: string[];
  tools?: MemoryReviewSnapshotToolEntry[];
  currentMemoryIndex: string;
  relevantTopics?: MemoryReviewSnapshotTopicExcerpt[];
  nativeMemoryChangeSummary?: string;
  nativeMemoryWatermark: string;
  releaseSha: string;
  packageVersion: string;
}

export interface MemoryReviewSnapshot {
  sessionId: string;
  promptId: string;
  assistantMessageSha256: string;
  userMessage: string;
  assistantFinal: string;
  recentCorrections: string[];
  earlierTurnDigests: string[];
  tools: MemoryReviewSnapshotToolEntry[];
  currentMemoryIndex: string;
  relevantTopics: MemoryReviewSnapshotTopicExcerpt[];
  nativeMemoryChangeSummary: string;
  nativeMemoryWatermark: string;
  releaseSha: string;
  packageVersion: string;
}

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TOPIC_PATH_RE = /^[^/\\\0]{1,128}\.md$/;

function boundedList(values: unknown, limit: number, fieldChars = MAX_FIELD_CHARS): string[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map(value => bounded(value, fieldChars));
}

function boundedToolName(value: unknown): string {
  return bounded(value, MAX_TOOL_NAME_CHARS).replace(/[\r\n]/g, " ");
}

/**
 * Builds the bounded snapshot the isolated reviewer receives. This never throws on hostile
 * or oversized input; it silently truncates and redacts, because a snapshot that fails to
 * build must fail the review (closed), not crash the enqueue/delivery path.
 */
export function buildMemoryReviewSnapshot(input: MemoryReviewSnapshotInput): MemoryReviewSnapshot {
  const tools: MemoryReviewSnapshotToolEntry[] = Array.isArray(input.tools)
    ? input.tools.slice(0, MAX_TOOL_ENTRIES).map(entry => ({
        name: boundedToolName(entry?.name),
        classification: entry?.classification === "failure" ? "failure" : "success"
      }))
    : [];

  const relevantTopics: MemoryReviewSnapshotTopicExcerpt[] = Array.isArray(input.relevantTopics)
    ? input.relevantTopics.slice(0, MAX_TOPIC_EXCERPTS).map(topic => ({
        path: bounded(topic?.path, 128).replace(/[^a-zA-Z0-9._-]/g, "_"),
        contentHash: /^[0-9a-f]{64}$/.test(String(topic?.contentHash)) ? String(topic.contentHash) : "",
        excerpt: bounded(topic?.excerpt, MAX_FIELD_CHARS)
      }))
    : [];

  const snapshot: MemoryReviewSnapshot = {
    sessionId: SESSION_UUID_RE.test(input.sessionId) ? input.sessionId : "",
    promptId: PROMPT_ID_RE.test(input.promptId) ? input.promptId : "",
    assistantMessageSha256: SHA256_RE.test(input.assistantMessageSha256) ? input.assistantMessageSha256 : "0".repeat(64),
    userMessage: bounded(input.userMessage, MAX_FIELD_CHARS),
    assistantFinal: bounded(input.assistantFinal),
    recentCorrections: boundedList(input.recentCorrections, 4),
    earlierTurnDigests: boundedList(input.earlierTurnDigests, MAX_EARLIER_DIGESTS, 240),
    tools,
    currentMemoryIndex: bounded(input.currentMemoryIndex, MAX_FIELD_CHARS),
    relevantTopics,
    nativeMemoryChangeSummary: bounded(input.nativeMemoryChangeSummary, 400),
    nativeMemoryWatermark: SHA256_RE.test(input.nativeMemoryWatermark) ? input.nativeMemoryWatermark : "0".repeat(64),
    releaseSha: RELEASE_SHA_RE.test(input.releaseSha) ? input.releaseSha : "0".repeat(40),
    packageVersion: bounded(input.packageVersion, 32)
  };

  // A hard total-character budget independent of the per-field caps above, so a snapshot
  // built from many maximally-sized fields still cannot grow past a fixed size. Every
  // contributing field is scaled down by the same factor rather than only trimming
  // assistantFinal, so the cap holds regardless of which combination of fields is maxed out.
  const total = snapshot.userMessage.length + snapshot.assistantFinal.length
    + snapshot.recentCorrections.reduce((sum, value) => sum + value.length, 0)
    + snapshot.earlierTurnDigests.reduce((sum, value) => sum + value.length, 0)
    + snapshot.currentMemoryIndex.length
    + snapshot.relevantTopics.reduce((sum, topic) => sum + topic.excerpt.length, 0)
    + snapshot.nativeMemoryChangeSummary.length;
  if (total > MAX_TOTAL_CHARS) {
    const factor = MAX_TOTAL_CHARS / total;
    snapshot.userMessage = scaleField(snapshot.userMessage, factor);
    snapshot.assistantFinal = scaleField(snapshot.assistantFinal, factor);
    snapshot.recentCorrections = snapshot.recentCorrections.map(value => scaleField(value, factor));
    snapshot.earlierTurnDigests = snapshot.earlierTurnDigests.map(value => scaleField(value, factor));
    snapshot.currentMemoryIndex = scaleField(snapshot.currentMemoryIndex, factor);
    snapshot.relevantTopics = snapshot.relevantTopics.map(topic => ({ ...topic, excerpt: scaleField(topic.excerpt, factor) }));
    snapshot.nativeMemoryChangeSummary = scaleField(snapshot.nativeMemoryChangeSummary, factor);
  }
  return snapshot;
}

/** Proportionally shrinks a string toward the total-character budget; never grows it. */
function scaleField(value: string, factor: number): string {
  if (factor >= 1) return value;
  const chars = Array.from(value);
  const keep = Math.max(0, Math.floor(chars.length * factor));
  return chars.slice(0, keep).join("");
}

function validText(value: unknown, maxChars: number, minChars = 0): value is string {
  if (typeof value !== "string") return false;
  const chars = Array.from(value).length;
  return chars >= minChars && chars <= maxChars && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && !containsCredentialShape(value);
}

/** Strict worker-side decode of the untrusted snapshot file. */
export function validateMemoryReviewSnapshot(value: unknown): MemoryReviewSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid snapshot shape");
  const record = value as Record<string, unknown>;
  const allowed = [
    "sessionId", "promptId", "assistantMessageSha256",
    "userMessage", "assistantFinal", "recentCorrections", "earlierTurnDigests", "tools",
    "currentMemoryIndex", "relevantTopics", "nativeMemoryChangeSummary", "nativeMemoryWatermark",
    "releaseSha", "packageVersion"
  ];
  if (Object.keys(record).length !== allowed.length || allowed.some(key => !(key in record)) ||
      typeof record.sessionId !== "string" || !SESSION_UUID_RE.test(record.sessionId) ||
      typeof record.promptId !== "string" || !PROMPT_ID_RE.test(record.promptId) ||
      typeof record.assistantMessageSha256 !== "string" || !SHA256_RE.test(record.assistantMessageSha256) || /^0+$/.test(record.assistantMessageSha256) ||
      !validText(record.userMessage, MAX_FIELD_CHARS, 1) || !validText(record.assistantFinal, MAX_FIELD_CHARS, 1) ||
      !validText(record.currentMemoryIndex, MAX_FIELD_CHARS, 1) ||
      !validText(record.nativeMemoryChangeSummary, 400) ||
      typeof record.nativeMemoryWatermark !== "string" || !SHA256_RE.test(record.nativeMemoryWatermark) || /^0+$/.test(record.nativeMemoryWatermark) ||
      typeof record.releaseSha !== "string" || !RELEASE_SHA_RE.test(record.releaseSha) || /^0+$/.test(record.releaseSha) ||
      !validText(record.packageVersion, 32, 1) || !/^[0-9A-Za-z.+-]+$/.test(record.packageVersion)) {
    throw new Error("invalid snapshot fields");
  }
  if (!Array.isArray(record.recentCorrections) || record.recentCorrections.length > 4 ||
      !record.recentCorrections.every(item => validText(item, MAX_FIELD_CHARS)) ||
      !Array.isArray(record.earlierTurnDigests) || record.earlierTurnDigests.length > MAX_EARLIER_DIGESTS ||
      !record.earlierTurnDigests.every(item => validText(item, 240)) ||
      !Array.isArray(record.tools) || record.tools.length > MAX_TOOL_ENTRIES ||
      !Array.isArray(record.relevantTopics) || record.relevantTopics.length > MAX_TOPIC_EXCERPTS) {
    throw new Error("invalid snapshot arrays");
  }
  const tools: MemoryReviewSnapshotToolEntry[] = record.tools.map(value => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid snapshot tool");
    const tool = value as Record<string, unknown>;
    if (Object.keys(tool).length !== 2 || !validText(tool.name, MAX_TOOL_NAME_CHARS, 1) ||
        (tool.classification !== "success" && tool.classification !== "failure")) throw new Error("invalid snapshot tool");
    return { name: tool.name, classification: tool.classification };
  });
  const relevantTopics: MemoryReviewSnapshotTopicExcerpt[] = record.relevantTopics.map(value => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid snapshot topic");
    const topic = value as Record<string, unknown>;
    if (Object.keys(topic).length !== 3 || typeof topic.path !== "string" || !TOPIC_PATH_RE.test(topic.path) ||
        typeof topic.contentHash !== "string" || !SHA256_RE.test(topic.contentHash) ||
        !validText(topic.excerpt, MAX_FIELD_CHARS)) throw new Error("invalid snapshot topic");
    return { path: topic.path, contentHash: topic.contentHash, excerpt: topic.excerpt };
  });
  const snapshot: MemoryReviewSnapshot = {
    sessionId: record.sessionId,
    promptId: record.promptId,
    assistantMessageSha256: record.assistantMessageSha256,
    userMessage: record.userMessage,
    assistantFinal: record.assistantFinal,
    recentCorrections: [...record.recentCorrections] as string[],
    earlierTurnDigests: [...record.earlierTurnDigests] as string[],
    tools,
    currentMemoryIndex: record.currentMemoryIndex,
    relevantTopics,
    nativeMemoryChangeSummary: record.nativeMemoryChangeSummary,
    nativeMemoryWatermark: record.nativeMemoryWatermark,
    releaseSha: record.releaseSha,
    packageVersion: record.packageVersion
  };
  const total = snapshot.userMessage.length + snapshot.assistantFinal.length
    + snapshot.recentCorrections.reduce((sum, item) => sum + item.length, 0)
    + snapshot.earlierTurnDigests.reduce((sum, item) => sum + item.length, 0)
    + snapshot.currentMemoryIndex.length
    + snapshot.relevantTopics.reduce((sum, topic) => sum + topic.excerpt.length, 0)
    + snapshot.nativeMemoryChangeSummary.length;
  if (total > MAX_TOTAL_CHARS) throw new Error("snapshot exceeds total character limit");
  return snapshot;
}

export function memoryReviewSnapshotDigest(snapshot: MemoryReviewSnapshot): string {
  const validated = validateMemoryReviewSnapshot(snapshot);
  return createHash("sha256").update(JSON.stringify(validated)).digest("hex");
}

interface SerializedMemoryReviewSnapshot {
  snapshot: MemoryReviewSnapshot;
}

/**
 * Wraps the snapshot in the exact `{"snapshot": ...}` envelope readSnapshotFromStdin (the
 * worker's stdin reader) expects. The two must always agree on this shape: see
 * memory-review-worker.test.ts's producer/consumer round-trip test.
 */
export function serializeMemoryReviewSnapshot(snapshot: MemoryReviewSnapshot): string {
  const payload: SerializedMemoryReviewSnapshot = { snapshot };
  const bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes, "utf8") > 32 * 1024) throw new Error("snapshot exceeds byte limit");
  return bytes;
}
