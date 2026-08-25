import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLearningDelta, writeLearningDelta } from "@project-tharsis/claude-code-telegram-shared";
import { prepareLearningDeltaForPrompt } from "../src/learning-delta-command.js";

const SESSION = "33333333-3333-4333-8333-333333333333";
const RELEASE = "c".repeat(40);
const direct = (body: string) => `<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">${body}</channel>`;

describe("learning delta UserPromptSubmit command", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "learning-delta-command-"));
    writeLearningDelta({
      receiptId: "d".repeat(64),
      sessionId: SESSION,
      releaseSha: RELEASE,
      topics: ["concise-replies"],
      summary: "Applied concise reply preference.",
      createdAt: 1_000,
    }, { directory });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("injects once on the next direct non-control prompt", () => {
    const output = prepareLearningDeltaForPrompt({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      prompt: direct("hello"),
    }, { enabled: true, releaseSha: RELEASE, directory, now: 2_000 });
    expect(JSON.parse(output!.output)).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit" },
    });
    expect(readLearningDelta(SESSION, { directory })).not.toBeNull();
    expect(prepareLearningDeltaForPrompt({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      prompt: direct("concurrent"),
    }, { enabled: true, releaseSha: RELEASE, directory, now: 2_000 })).toBeNull();
    expect(output!.acknowledge()).toBe(true);
    output!.release();
    expect(readLearningDelta(SESSION, { directory })).toBeNull();
    expect(prepareLearningDeltaForPrompt({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: direct("again") }, {
      enabled: true, releaseSha: RELEASE, directory, now: 2_001,
    })).toBeNull();
  });

  test("does not consume on control, malformed, wrong event, or disabled paths", () => {
    expect(prepareLearningDeltaForPrompt({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: direct("/reset") }, {
      enabled: true, releaseSha: RELEASE, directory, now: 2_000,
    })).toBeNull();
    expect(prepareLearningDeltaForPrompt({ hook_event_name: "Stop", session_id: SESSION, prompt: direct("hello") }, {
      enabled: true, releaseSha: RELEASE, directory, now: 2_000,
    })).toBeNull();
    expect(prepareLearningDeltaForPrompt({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: direct("hello") }, {
      enabled: false, releaseSha: RELEASE, directory, now: 2_000,
    })).toBeNull();
    expect(readLearningDelta(SESSION, { directory })).not.toBeNull();
  });
});
