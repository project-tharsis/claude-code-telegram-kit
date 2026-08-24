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

const MAX_FIELD_CHARS = 1_200;
const MAX_TOTAL_CHARS = 6_000;
const MAX_EARLIER_DIGESTS = 6;
const MAX_TOOL_ENTRIES = 20;
const MAX_TOPIC_EXCERPTS = 4;
const MAX_TOOL_NAME_CHARS = 60;

const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:password|passwd|token|secret|api[_ -]?key|authorization|credential)\s*[:=]\s*[^\s,;]+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /https?:\/\/[^:\s/@]+:[^@\s/]+@/gi
];

function redact(value: string): string {
  let result = value;
  for (const pattern of CREDENTIAL_PATTERNS) result = result.replace(pattern, "[redacted]");
  return result;
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
  // built from many maximally-sized fields still cannot grow past a fixed size.
  let total = snapshot.userMessage.length + snapshot.assistantFinal.length
    + snapshot.recentCorrections.reduce((sum, value) => sum + value.length, 0)
    + snapshot.earlierTurnDigests.reduce((sum, value) => sum + value.length, 0)
    + snapshot.currentMemoryIndex.length
    + snapshot.relevantTopics.reduce((sum, topic) => sum + topic.excerpt.length, 0)
    + snapshot.nativeMemoryChangeSummary.length;
  if (total > MAX_TOTAL_CHARS) {
    const overflow = total - MAX_TOTAL_CHARS;
    snapshot.assistantFinal = snapshot.assistantFinal.slice(0, Math.max(0, snapshot.assistantFinal.length - overflow));
  }
  return snapshot;
}

export function serializeMemoryReviewSnapshot(snapshot: MemoryReviewSnapshot): string {
  const bytes = JSON.stringify(snapshot);
  if (Buffer.byteLength(bytes, "utf8") > 32 * 1024) throw new Error("snapshot exceeds byte limit");
  return bytes;
}
