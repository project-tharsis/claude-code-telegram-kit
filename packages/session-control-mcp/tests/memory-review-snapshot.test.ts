import { describe, expect, test } from "bun:test";
import { buildMemoryReviewSnapshot, serializeMemoryReviewSnapshot } from "../src/memory-review-snapshot.js";

const VALID_RELEASE_SHA = "c".repeat(40);

function baseInput() {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    promptId: "prompt-1",
    assistantMessageSha256: "a".repeat(64),
    userMessage: "please remember I prefer short replies",
    assistantFinal: "Got it, I will keep replies short from now on.",
    currentMemoryIndex: "- no-em-dash.md\n- obsidian-vault.md",
    nativeMemoryWatermark: "f".repeat(64),
    releaseSha: VALID_RELEASE_SHA,
    packageVersion: "0.4.0"
  };
}

describe("bounded memory review snapshot builder (handoff doc A4)", () => {
  test("passes ordinary bounded input through unchanged", () => {
    const snapshot = buildMemoryReviewSnapshot(baseInput());
    expect(snapshot.userMessage).toBe(baseInput().userMessage);
    expect(snapshot.releaseSha).toBe(VALID_RELEASE_SHA);
  });

  test("truncates an oversized single field instead of throwing", () => {
    const snapshot = buildMemoryReviewSnapshot({ ...baseInput(), assistantFinal: "x".repeat(50_000) });
    expect(snapshot.assistantFinal.length).toBeLessThanOrEqual(1_200);
  });

  test("caps total snapshot size even when every field is independently within its own cap", () => {
    const snapshot = buildMemoryReviewSnapshot({
      ...baseInput(),
      userMessage: "a".repeat(1_200),
      assistantFinal: "b".repeat(1_200),
      recentCorrections: Array.from({ length: 4 }, () => "c".repeat(1_200)),
      earlierTurnDigests: Array.from({ length: 6 }, () => "d".repeat(240)),
      currentMemoryIndex: "e".repeat(1_200),
      relevantTopics: [{ path: "topic.md", contentHash: "f".repeat(64), excerpt: "g".repeat(1_200) }],
      nativeMemoryChangeSummary: "h".repeat(400)
    });
    const total = snapshot.userMessage.length + snapshot.assistantFinal.length
      + snapshot.recentCorrections.join("").length + snapshot.earlierTurnDigests.join("").length
      + snapshot.currentMemoryIndex.length + snapshot.relevantTopics.map(t => t.excerpt).join("").length
      + snapshot.nativeMemoryChangeSummary.length;
    expect(total).toBeLessThanOrEqual(6_000);
  });

  test("enforces the total budget by scaling every contributing field, not by crushing only assistantFinal", () => {
    const snapshot = buildMemoryReviewSnapshot({
      ...baseInput(),
      userMessage: "a".repeat(1_200),
      assistantFinal: "b".repeat(1_200),
      recentCorrections: Array.from({ length: 4 }, () => "c".repeat(1_200)),
      earlierTurnDigests: Array.from({ length: 6 }, () => "d".repeat(240)),
      currentMemoryIndex: "e".repeat(1_200),
      relevantTopics: [{ path: "topic.md", contentHash: "f".repeat(64), excerpt: "g".repeat(1_200) }],
      nativeMemoryChangeSummary: "h".repeat(400)
    });
    const total = snapshot.userMessage.length + snapshot.assistantFinal.length
      + snapshot.recentCorrections.join("").length + snapshot.earlierTurnDigests.join("").length
      + snapshot.currentMemoryIndex.length + snapshot.relevantTopics.map(t => t.excerpt).join("").length
      + snapshot.nativeMemoryChangeSummary.length;
    expect(total).toBeLessThanOrEqual(6_000);
    // Every field shrank by roughly the same proportion instead of only assistantFinal being
    // trimmed to fit -- none of the maxed-out fields is crushed to (near) zero while another
    // stays at its full per-field cap.
    expect(snapshot.assistantFinal.length).toBeGreaterThan(0);
    expect(snapshot.userMessage.length).toBeGreaterThan(0);
    expect(snapshot.currentMemoryIndex.length).toBeGreaterThan(0);
  });

  test("caps the number of tool entries and earlier-turn digests independent of content size", () => {
    const snapshot = buildMemoryReviewSnapshot({
      ...baseInput(),
      tools: Array.from({ length: 100 }, (_, index) => ({ name: `Tool${index}`, classification: "success" as const })),
      earlierTurnDigests: Array.from({ length: 100 }, (_, index) => `digest-${index}`)
    });
    expect(snapshot.tools.length).toBeLessThanOrEqual(20);
    expect(snapshot.earlierTurnDigests.length).toBeLessThanOrEqual(6);
  });

  test("caps the number of relevant topic excerpts (file count cap)", () => {
    const snapshot = buildMemoryReviewSnapshot({
      ...baseInput(),
      relevantTopics: Array.from({ length: 50 }, (_, index) => ({ path: `topic-${index}.md`, contentHash: "0".repeat(64), excerpt: "text" }))
    });
    expect(snapshot.relevantTopics.length).toBeLessThanOrEqual(4);
  });

  test("redacts a credential-shaped substring embedded in transcript-derived text", () => {
    const snapshot = buildMemoryReviewSnapshot({
      ...baseInput(),
      userMessage: "here is my token: sk-live-abcdefghijklmnop please remember it",
      assistantFinal: "the header carries bearer aaaaaaaaaaaaaaaaaaaaaaaa for auth"
    });
    expect(snapshot.userMessage).not.toContain("sk-live-abcdefghijklmnop");
    expect(snapshot.assistantFinal).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(snapshot.userMessage).toContain("[redacted]");
  });

  test("redacts a quoted-JSON-style credential shape, not just bare key: value prose", () => {
    const snapshot = buildMemoryReviewSnapshot({
      ...baseInput(),
      userMessage: 'here is the config: {"password": "hunter2value"}',
      assistantFinal: 'and the header: {"api_key":"abcdefghij1234567890zzzz"}'
    });
    expect(snapshot.userMessage).not.toContain("hunter2value");
    expect(snapshot.assistantFinal).not.toContain("abcdefghij1234567890zzzz");
  });

  test("never exceeds the per-field char cap even when a credential match straddles the truncation boundary", () => {
    // "token=x" is a 7-char credential-shaped match (shorter than the 10-char "[redacted]"
    // marker it gets replaced with); placing it exactly at the 1200-char field boundary means
    // a naive truncate-then-redact ordering would let redaction grow the final string past
    // maxChars. Redact-then-truncate must clip the already-redacted text back down to exactly
    // the cap.
    const field = "a".repeat(1193) + "token=x";
    expect(field.length).toBe(1_200);
    const snapshot = buildMemoryReviewSnapshot({ ...baseInput(), userMessage: field });
    expect(snapshot.userMessage.length).toBeLessThanOrEqual(1_200);
    expect(snapshot.userMessage).not.toContain("token=x");
  });

  test("rejects an invalid release SHA rather than passing it through", () => {
    const snapshot = buildMemoryReviewSnapshot({ ...baseInput(), releaseSha: "not-a-sha; rm -rf" });
    expect(snapshot.releaseSha).toBe("0".repeat(40));
  });

  test("silently tolerates hostile non-string/oversized-array input without throwing", () => {
    expect(() => buildMemoryReviewSnapshot({
      ...baseInput(),
      recentCorrections: "not an array" as unknown as string[],
      tools: "also not an array" as unknown as never
    })).not.toThrow();
  });

  test("serialization enforces a hard byte cap", () => {
    const snapshot = buildMemoryReviewSnapshot(baseInput());
    expect(() => serializeMemoryReviewSnapshot(snapshot)).not.toThrow();
  });
});
