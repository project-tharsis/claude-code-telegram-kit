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

import { redactCredentials } from "@project-tharsis/claude-code-telegram-shared";

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
  return redact(Array.from(text).slice(0, maxChars).join(""));
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
  userMessage: string;
  assistantFinal: string;
  recentCorrections?: string[];
  earlierTurnDigests?: string[];
  tools?: MemoryReviewSnapshotToolEntry[];
  currentMemoryIndex: string;
  relevantTopics?: MemoryReviewSnapshotTopicExcerpt[];
  nativeMemoryChangeSummary?: string;
  releaseSha: string;
  packageVersion: string;
}

export interface MemoryReviewSnapshot {
  userMessage: string;
  assistantFinal: string;
  recentCorrections: string[];
  earlierTurnDigests: string[];
  tools: MemoryReviewSnapshotToolEntry[];
  currentMemoryIndex: string;
  relevantTopics: MemoryReviewSnapshotTopicExcerpt[];
  nativeMemoryChangeSummary: string;
  releaseSha: string;
  packageVersion: string;
}

const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;

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
        path: bounded(topic?.path, 128).replace(/[^a-zA-Z0-9._/-]/g, "_"),
        contentHash: /^[0-9a-f]{64}$/.test(String(topic?.contentHash)) ? String(topic.contentHash) : "",
        excerpt: bounded(topic?.excerpt, MAX_FIELD_CHARS)
      }))
    : [];

  const snapshot: MemoryReviewSnapshot = {
    userMessage: bounded(input.userMessage),
    assistantFinal: bounded(input.assistantFinal),
    recentCorrections: boundedList(input.recentCorrections, 4),
    earlierTurnDigests: boundedList(input.earlierTurnDigests, MAX_EARLIER_DIGESTS, 240),
    tools,
    currentMemoryIndex: bounded(input.currentMemoryIndex, MAX_FIELD_CHARS),
    relevantTopics,
    nativeMemoryChangeSummary: bounded(input.nativeMemoryChangeSummary, 400),
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
