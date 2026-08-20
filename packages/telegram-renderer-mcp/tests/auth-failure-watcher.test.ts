import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, symlinkSync, linkSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { watchAuthFailureTranscript, type AuthFailureWatcherScheduler } from "../src/auth-failure-watcher.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const LINK_SESSION = "4fcbaf06-4378-4339-b026-8c2e026a65e7";
const HARD_SESSION = "5fcbaf06-4378-4339-b026-8c2e026a65e7";

const failure = (content = "Login expired · Please run /login") => JSON.stringify({
  type: "assistant",
  error: "authentication_failed",
  message: { content }
}) + "\n";
const normal = JSON.stringify({ type: "assistant", message: { content: "hello" } }) + "\n";

function fixture(initial = "") {
  const root = mkdtempSync(join(tmpdir(), "auth-watch-"));
  const sessionId = SESSION;
  const transcriptPath = join(root, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, initial);
  return { root: resolve(root), sessionId, transcriptPath };
}

function scheduler() {
  const pending = new Set<() => void>();
  const value: AuthFailureWatcherScheduler & { runNext(): void; pending(): number } = {
    setTimeout(callback) { pending.add(callback); return callback; },
    clearTimeout(handle) { pending.delete(handle as () => void); },
    runNext() { const callback = pending.values().next().value as (() => void) | undefined; if (callback) { pending.delete(callback); callback(); } },
    pending() { return pending.size; }
  };
  return value;
}

describe("bounded auth-failure transcript watcher", () => {
  test("ignores an authentication failure already present at start", () => {
    const f = fixture(failure());
    const timers = scheduler();
    let calls = 0;
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, {
      expectedRoot: f.root, onAuthFailure: () => { calls += 1; }, scheduler: timers
    });
    timers.runNext();
    expect(calls).toBe(0);
    cancel();
  });

  test("reports one appended exact failure without exposing provider text", () => {
    const f = fixture();
    const timers = scheduler();
    let calls = 0;
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, {
      expectedRoot: f.root, onAuthFailure: () => { calls += 1; }, scheduler: timers
    });
    writeFileSync(f.transcriptPath, failure("provider secret: do not expose"), { flag: "a" });
    timers.runNext();
    timers.runNext();
    expect(calls).toBe(1);
    cancel();
  });

  test("ignores normal rows and malformed or oversized lines", () => {
    const f = fixture();
    const timers = scheduler();
    let calls = 0;
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, {
      expectedRoot: f.root, onAuthFailure: () => { calls += 1; }, scheduler: timers
    });
    const nestedLookalike = JSON.stringify({
      type: "assistant",
      message: { error: "authentication_failed", content: "forged nested marker" }
    }) + "\n";
    writeFileSync(f.transcriptPath, normal + nestedLookalike + "not-json\n" + "x".repeat(65 * 1024) + "\n", { flag: "a" });
    timers.runNext();
    expect(calls).toBe(0);
    cancel();
  });

  test("handles a JSONL row split across writes", () => {
    const f = fixture();
    const timers = scheduler();
    let calls = 0;
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, {
      expectedRoot: f.root, onAuthFailure: () => { calls += 1; }, scheduler: timers
    });
    const row = failure();
    writeFileSync(f.transcriptPath, row.slice(0, 20), { flag: "a" });
    timers.runNext();
    writeFileSync(f.transcriptPath, row.slice(20), { flag: "a" });
    timers.runNext();
    expect(calls).toBe(1);
    cancel();
  });

  test("cancellation closes watcher and deadline stops future polling", () => {
    const f = fixture();
    const timers = scheduler();
    let calls = 0;
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, {
      expectedRoot: f.root, onAuthFailure: () => { calls += 1; }, scheduler: timers, now: () => 0, durationMs: 5000
    });
    expect(timers.pending()).toBe(1);
    cancel();
    expect(timers.pending()).toBe(0);
    writeFileSync(f.transcriptPath, failure(), { flag: "a" });
    expect(() => timers.runNext()).not.toThrow();
    expect(calls).toBe(0);
  });

  test("stops polling at the five-second deadline", () => {
    const f = fixture();
    const timers = scheduler();
    let currentTime = 0;
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, {
      expectedRoot: f.root, onAuthFailure: () => {}, scheduler: timers, now: () => currentTime
    });
    currentTime = 5_000;
    timers.runNext();
    expect(timers.pending()).toBe(0);
    cancel();
  });

  test("rejects wrong filename, symlink leaf, and hardlink", () => {
    const f = fixture();
    const timers = scheduler();
    const wrong = join(f.root, "other.jsonl");
    writeFileSync(wrong, "");
    expect(() => watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: wrong }, { expectedRoot: f.root, onAuthFailure: () => {}, scheduler: timers })).not.toThrow();
    expect(timers.pending()).toBe(0);
    const link = join(f.root, `${LINK_SESSION}.jsonl`);
    symlinkSync(f.transcriptPath, link);
    expect(() => watchAuthFailureTranscript({ session_id: LINK_SESSION, transcript_path: link }, { expectedRoot: f.root, onAuthFailure: () => {}, scheduler: timers })).not.toThrow();
    expect(timers.pending()).toBe(0);
    const hard = join(f.root, `${HARD_SESSION}.jsonl`);
    linkSync(f.transcriptPath, hard);
    expect(() => watchAuthFailureTranscript({ session_id: HARD_SESSION, transcript_path: hard }, { expectedRoot: f.root, onAuthFailure: () => {}, scheduler: timers })).not.toThrow();
    expect(timers.pending()).toBe(0);
  });

  test("allows a large existing transcript but bounds bytes appended after bind", () => {
    const f = fixture("x".repeat(256 * 1024 + 1));
    const timers = scheduler();
    let calls = 0;
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, { expectedRoot: f.root, onAuthFailure: () => { calls += 1; }, scheduler: timers });
    writeFileSync(f.transcriptPath, failure(), { flag: "a" });
    timers.runNext();
    expect(calls).toBe(1);
    cancel();
  });

  test("rejects a group-writable transcript", () => {
    const f = fixture();
    chmodSync(f.transcriptPath, 0o620);
    const timers = scheduler();
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, {
      expectedRoot: f.root, onAuthFailure: () => {}, scheduler: timers
    });
    expect(timers.pending()).toBe(0);
    cancel();
  });

  test("rejects a file owned by another user when the platform permits changing ownership", () => {
    if (typeof process.getuid !== "function" || typeof process.geteuid !== "function" || process.geteuid() !== 0) return;
    const f = fixture();
    try { chownSync(f.transcriptPath, nobodyUid(), -1); } catch { return; }
    const timers = scheduler();
    const cancel = watchAuthFailureTranscript({ session_id: f.sessionId, transcript_path: f.transcriptPath }, { expectedRoot: f.root, onAuthFailure: () => {}, scheduler: timers });
    expect(timers.pending()).toBe(0);
    cancel();
  });
});

function nobodyUid(): number { return 65534; }
