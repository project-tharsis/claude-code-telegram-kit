import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlMessageClaims,
  isAttestedUsageQueueRuntime,
  parseQueuedUsageEvent,
  watchQueuedUsageControls
} from "../src/usage-queue-watcher.js";

const SESSION = "65e1e787-6af1-4beb-a7ac-6b43e48cb087";
const NOW = Date.parse("2026-08-24T07:13:40.000Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(content = '<channel source="plugin:telegram:telegram" chat_id="123" message_id="644">/usage</channel>') {
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-08-24T07:13:38.097Z",
    sessionId: SESSION,
    content
  });
}

describe("queued usage control wire", () => {
  test("enables only under a complete activation attestation", () => {
    expect(isAttestedUsageQueueRuntime({})).toBe(false);
    expect(isAttestedUsageQueueRuntime({
      CLAUDE_RUNTIME_RELEASE_SHA: "a".repeat(40),
      CLAUDE_RUNTIME_GENERATION: "b".repeat(32)
    })).toBe(true);
    expect(() => isAttestedUsageQueueRuntime({
      CLAUDE_RUNTIME_RELEASE_SHA: "a".repeat(40)
    })).toThrow("runtime attestation is incomplete");
  });

  test("accepts only an exact fresh usage enqueue for the transcript session", () => {
    expect(parseQueuedUsageEvent(row(), SESSION, NOW)).toEqual({
      session_id: SESSION,
      prompt_id: "queue:644",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="644">/usage</channel>',
      hook_event_name: "UserPromptSubmit"
    });
  });

  test("rejects non-usage, session mismatch, stale, malformed, and extra-key rows", () => {
    const values = [
      row('<channel source="plugin:telegram:telegram" chat_id="123" message_id="644">hello</channel>'),
      JSON.stringify({ ...JSON.parse(row()), sessionId: "75e1e787-6af1-4beb-a7ac-6b43e48cb087" }),
      JSON.stringify({ ...JSON.parse(row()), timestamp: "2026-08-24T06:00:00.000Z" }),
      JSON.stringify({ ...JSON.parse(row()), operation: "dequeue" }),
      JSON.stringify({ ...JSON.parse(row()), extra: true }),
      "not-json"
    ];
    for (const value of values) expect(parseQueuedUsageEvent(value, SESSION, NOW)).toBeNull();
  });

  test("tails only post-baseline appends from startup transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-queue-watcher-"));
    roots.push(root);
    chmodSync(root, 0o755);
    const existing = join(root, `${SESSION}.jsonl`);
    writeFileSync(existing, `${row()}\n`, { mode: 0o600 });
    const seen: string[] = [];
    const watcher = watchQueuedUsageControls({
      directory: root,
      expectedUid: process.getuid!(),
      now: () => NOW,
      dispatch: async input => { seen.push(input.prompt_id); },
      schedule: () => ({ cancel: () => undefined })
    });
    const laterSession = "75e1e787-6af1-4beb-a7ac-6b43e48cb087";
    writeFileSync(join(root, `${laterSession}.jsonl`), "", { mode: 0o600 });
    appendFileSync(existing, `${row()}\n`);
    appendFileSync(join(root, `${laterSession}.jsonl`), `${row().replaceAll(SESSION, laterSession)}\n`);

    await watcher.poll();
    expect(seen).toEqual(["queue:644"]);
    watcher.close();
  });

  test("reserves each Telegram message once with a bounded set", () => {
    const claims = createControlMessageClaims(2);
    expect(claims.claim("123", "644")).toBe(true);
    expect(claims.claim("123", "644")).toBe(false);
    expect(claims.claim("123", "645")).toBe(true);
    expect(claims.claim("123", "646")).toBe(false);
    expect(claims.claim("123", "644")).toBe(false);
  });
});
