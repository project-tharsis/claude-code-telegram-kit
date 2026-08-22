import { describe, expect, test } from "bun:test";
import { createCommentaryDisplayBuffer } from "../src/commentary-display.js";

const session_id = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const event = (message_id: string, index: number, delta: string, final = false) => ({
  session_id, prompt_id: "p1", turn_id: "turn-1", message_id, index, delta, final, hook_event_name: "MessageDisplay" as const
});

describe("MessageDisplay commentary buffer", () => {
  test("reassembles streaming batches in index order and commits only after final", () => {
    const buffer = createCommentaryDisplayBuffer(session_id);
    buffer.add(event("m1", 0, "hello "));
    expect(buffer.collectBeforeTool("tool")).toEqual([]);
    buffer.add(event("m1", 1, "world", true));
    expect(buffer.collectBeforeTool("tool").map(block => block.text)).toEqual(["hello world"]);
  });

  test("deduplicates replayed chunks and rejects an out-of-order message", () => {
    const buffer = createCommentaryDisplayBuffer(session_id);
    buffer.add(event("m1", 0, "one "));
    buffer.add(event("m1", 0, "duplicate "));
    buffer.add(event("m1", 1, "two", true));
    buffer.add(event("m2", 1, "gap", true));
    buffer.add(event("m2", 0, "must stay rejected", true));
    expect(buffer.collectBeforeTool("tool").map(block => block.text)).toEqual(["one two"]);
  });

  test("rejects a different turn and keeps message keys turn-scoped", () => {
    const buffer = createCommentaryDisplayBuffer(session_id);
    buffer.add(event("m1", 0, "first", true));
    buffer.add({ ...event("m2", 0, "wrong turn", true), turn_id: "turn-2" });
    const blocks = buffer.collectBeforeTool("tool");
    expect(blocks.map(block => block.text)).toEqual(["first"]);
    expect(blocks[0]!.key).toContain("turn-1");
  });

  test("reserves a committed message once and closes/discards the final buffer", () => {
    const buffer = createCommentaryDisplayBuffer(session_id);
    buffer.add(event("m1", 0, "interim", true));
    const [block] = buffer.collectBeforeTool("tool");
    buffer.reserve(block!.key);
    expect(buffer.collectBeforeTool("tool")).toEqual([]);
    buffer.close();
    buffer.add(event("m2", 0, "final", true));
    expect(buffer.collectBeforeTool("tool")).toEqual([]);
  });
});
