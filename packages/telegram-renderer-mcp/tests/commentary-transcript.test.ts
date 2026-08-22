import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommentaryTranscriptTracker } from "../src/commentary-transcript.js";

const session = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
function textRow(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
}
function toolRow(id = "tool"): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id }] } }) + "\n";
}
function row(text: string, id = "tool"): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id }] } }) + "\n";
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "commentary-"));
  const path = join(root, `${session}.jsonl`);
  writeFileSync(path, row("old text"));
  chmodSync(root, 0o700); chmodSync(path, 0o600);
  const tracker = startCommentaryTranscriptTracker({ session_id: session, prompt_id: "p1", prompt: "", transcript_path: path, hook_event_name: "UserPromptSubmit" }, { expectedRoot: root, uid: process.getuid?.() ?? -1 });
  expect(tracker).not.toBeNull();
  return { path, tracker: tracker! };
}

describe("commentary transcript provenance", () => {
  test("bind offset ignores old rows and reservation preserves distinct row/block keys", () => {
    const h = setup();
    appendFileSync(h.path, textRow("first") + textRow("second") + toolRow("tool"));
    const blocks = h.tracker.collectBeforeTool("tool");
    expect(blocks.map(block => block.text)).toEqual(["first", "second"]);
    expect(h.tracker.collectBeforeTool("tool").map(block => block.text)).toEqual(["first", "second"]);
    for (const block of blocks) h.tracker.reserve(block.key);
    expect(h.tracker.collectBeforeTool("tool")).toEqual([]);
    h.tracker.close();
  });

  test("partial JSONL is silent until the row is complete", () => {
    const h = setup();
    const complete = row("later");
    appendFileSync(h.path, complete.slice(0, -1));
    expect(h.tracker.collectBeforeTool("tool")).toEqual([]);
    appendFileSync(h.path, complete.slice(-1));
    expect(h.tracker.collectBeforeTool("tool").map(block => block.text)).toEqual(["later"]);
    h.tracker.close();
  });

  test("untrusted transcript permissions suppress commentary", () => {
    const h = setup();
    chmodSync(h.path, 0o644);
    expect(h.tracker.collectBeforeTool("tool")).toEqual([]);
    h.tracker.close();
  });

  test("PreToolUse proves continuation before its tool row is flushed", () => {
    const h = setup();
    appendFileSync(h.path, textRow("flushed commentary"));
    expect(h.tracker.collectBeforeTool("not-yet-flushed").map(block => block.text)).toEqual(["flushed commentary"]);
    h.tracker.close();
  });

  test("collects completed assistant text from an earlier row before the proving tool row", () => {
    const h = setup();
    appendFileSync(h.path, textRow("between tools") + toolRow("next-tool"));
    expect(h.tracker.collectBeforeTool("next-tool").map(block => block.text)).toEqual(["between tools"]);
    h.tracker.close();
  });

  test("only text before the proving tool is eligible", () => {
    const h = setup();
    appendFileSync(h.path, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "text", text: "before" }, { type: "tool_use", id: "second" }, { type: "text", text: "after" }
    ] } }) + "\n");
    expect(h.tracker.collectBeforeTool("second").map(block => block.text)).toEqual(["before"]);
    h.tracker.close();
  });
});
