import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUsableSessionTranscript,
  formatActivity,
  MAX_LISTED_SESSIONS,
  readLatestSessionModel,
  readSessionTitleContext,
  scanResumableSessions
} from "../src/session-catalog.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-catalog-"));
  roots.push(root);
  return root;
}

function uuid(n: number): string {
  const hex = n.toString(16).padStart(2, "0");
  return `${hex.repeat(4)}-${hex.repeat(2)}-4${hex.repeat(2).slice(1)}-8${hex.repeat(2).slice(1)}-${hex.repeat(6)}`;
}

function writeSession(
  root: string,
  id: string,
  options: { title?: string; mtimeSeconds?: number; extraLines?: string[]; sessionIdInFile?: string } = {}
): string {
  const lines = [
    JSON.stringify({ type: "mode", mode: "normal", sessionId: options.sessionIdInFile ?? id }),
    ...(options.extraLines ?? []),
    ...(options.title === undefined
      ? []
      : [JSON.stringify({ type: "ai-title", aiTitle: options.title, sessionId: options.sessionIdInFile ?? id })])
  ];
  const path = join(root, `${id}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  if (options.mtimeSeconds !== undefined) utimesSync(path, options.mtimeSeconds, options.mtimeSeconds);
  return path;
}

describe("bounded resumable session catalog", () => {
  test("defers for a live forked Skill result and resumes after completed task notification", () => {
    const root = makeRoot();
    const id = uuid(9);
    const envelope = '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">build it</channel>';
    const path = writeSession(root, id, { extraLines: [
      JSON.stringify({ type: "user", message: { content: envelope } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet", content: [
        { type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "review" } }
      ] } }),
      JSON.stringify({ type: "user", toolUseResult: { status: "forked", agentId: "agent-1" }, message: { content: [
        { type: "tool_result", tool_use_id: "skill-1", content: "Async agent launched successfully." }
      ] } })
    ] });
    expect(readSessionTitleContext({ directory: root, sessionId: id }).hasIncompleteForkedTask).toBe(true);
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({
      type: "user", message: { content:
        '<task-notification><task-id>task-1</task-id><tool-use-id>skill-1</tool-use-id><status>completed</status><summary>done</summary></task-notification>'
      }
    })}\n`);
    expect(readSessionTitleContext({ directory: root, sessionId: id }).hasIncompleteForkedTask).toBe(false);
  });

  test("clears a fork after a failed terminal notification", () => {
    const root = makeRoot();
    const id = uuid(19);
    const path = writeSession(root, id, { extraLines: [
      JSON.stringify({ type: "user", toolUseResult: { status: "forked", agentId: "agent-f" }, message: { content: [
        { type: "tool_result", tool_use_id: "skill-failed", content: "Async agent launched successfully." }
      ] } })
    ] });
    expect(readSessionTitleContext({ directory: root, sessionId: id }).hasIncompleteForkedTask).toBe(true);
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({
      type: "user", message: { content: '<task-notification><task-id>task-f</task-id><tool-use-id>skill-failed</tool-use-id><status>failed</status></task-notification>' }
    })}\n`);
    expect(readSessionTitleContext({ directory: root, sessionId: id }).hasIncompleteForkedTask).toBe(false);
  });

  test("finds an incomplete fork in the middle of a large transcript", () => {
    const root = makeRoot();
    const id = uuid(8);
    const envelope = '<channel source="plugin:telegram:telegram" chat_id="123" message_id="8">review it</channel>';
    const filler = JSON.stringify({ type: "progress", text: "x".repeat(900) });
    const path = writeSession(root, id, { extraLines: [
      JSON.stringify({ type: "user", message: { content: envelope } }),
      ...Array.from({ length: 700 }, () => filler),
      JSON.stringify({ type: "user", toolUseResult: { status: "forked", agentId: "agent-8" }, message: { content: [
        { type: "tool_result", tool_use_id: "skill-middle", content: "Async agent launched successfully." }
      ] } }),
      ...Array.from({ length: 700 }, () => filler)
    ] });
    expect(readSessionTitleContext({ directory: root, sessionId: id }).hasIncompleteForkedTask).toBe(true);
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({
      type: "user", message: { content: '<task-notification><task-id>task-8</task-id><tool-use-id>skill-middle</tool-use-id><status>completed</status></task-notification>' }
    })}\n`);
    expect(readSessionTitleContext({ directory: root, sessionId: id }).hasIncompleteForkedTask).toBe(false);
  });

  test("returns titled sessions newest first", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Older work", mtimeSeconds: 1_000 });
    writeSession(root, uuid(2), { title: "Newer work", mtimeSeconds: 2_000 });

    const entries = scanResumableSessions({ directory: root });

    expect(entries.map(entry => entry.title)).toEqual(["Newer work", "Older work"]);
    expect(entries.map(entry => entry.sessionId)).toEqual([uuid(2), uuid(1)]);
    expect(entries[0]!.lastActivityMs).toBe(2_000_000);
  });

  test("excludes the current session", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Keep" });
    writeSession(root, uuid(2), { title: "Current" });

    const entries = scanResumableSessions({ directory: root, currentSessionId: uuid(2) });

    expect(entries.map(entry => entry.sessionId)).toEqual([uuid(1)]);
  });

  test("returns at most ten sessions", () => {
    const root = makeRoot();
    for (let index = 1; index <= 15; index += 1) {
      writeSession(root, uuid(index), { title: `Session ${index}`, mtimeSeconds: 1_000 + index });
    }

    const entries = scanResumableSessions({ directory: root });

    expect(entries.length).toBe(MAX_LISTED_SESSIONS);
    expect(entries[0]!.title).toBe("Session 15");
  });

  test("ignores non-UUID names, other extensions, symlinks, and directories", () => {
    const root = makeRoot();
    const real = writeSession(root, uuid(1), { title: "Real" });
    writeFileSync(join(root, "notes.jsonl"), "{}\n");
    writeFileSync(join(root, `${uuid(2)}.json`), "{}\n");
    writeFileSync(join(root, "not-a-uuid.jsonl"), "{}\n");
    symlinkSync(real, join(root, `${uuid(3)}.jsonl`));
    mkdirSync(join(root, `${uuid(4)}.jsonl`));

    const entries = scanResumableSessions({ directory: root });

    expect(entries.map(entry => entry.sessionId)).toEqual([uuid(1)]);
  });

  test("ignores files owned by another user", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Real" });

    expect(scanResumableSessions({ directory: root, expectedUid: 999_999 })).toEqual([]);
  });

  test("ignores group-writable transcripts and files with extra hardlinks", () => {
    const root = makeRoot();
    const writable = writeSession(root, uuid(1), { title: "Writable" });
    chmodSync(writable, 0o620);
    const linked = writeSession(root, uuid(2), { title: "Linked" });
    linkSync(linked, join(root, "shadow.jsonl"));

    expect(scanResumableSessions({ directory: root })).toEqual([]);
  });

  test("ignores empty and oversized transcripts", () => {
    const root = makeRoot();
    writeFileSync(join(root, `${uuid(1)}.jsonl`), "");
    writeSession(root, uuid(2), { title: "Big", extraLines: ["x".repeat(4_000)] });
    writeSession(root, uuid(3), { title: "Small" });

    const entries = scanResumableSessions({ directory: root, maxFileBytes: 2_000 });

    expect(entries.map(entry => entry.sessionId)).toEqual([uuid(3)]);
  });

  test("tolerates malformed and truncated lines", () => {
    const root = makeRoot();
    const path = join(root, `${uuid(1)}.jsonl`);
    writeFileSync(path, [
      "not json at all",
      JSON.stringify({ type: "mode", sessionId: uuid(1) }),
      "{\"type\": \"ai-title\", \"aiTitle\": \"Survived",
      JSON.stringify({ type: "ai-title", aiTitle: "Good title", sessionId: uuid(1) }),
      "{\"truncated\""
    ].join("\n"));

    const entries = scanResumableSessions({ directory: root });

    expect(entries.map(entry => entry.title)).toEqual(["Good title"]);
  });

  test("uses the latest title in the file", () => {
    const root = makeRoot();
    const path = join(root, `${uuid(1)}.jsonl`);
    writeFileSync(path, [
      JSON.stringify({ type: "ai-title", aiTitle: "First guess", sessionId: uuid(1) }),
      JSON.stringify({ type: "ai-title", aiTitle: "Final title", sessionId: uuid(1) })
    ].join("\n"));

    expect(scanResumableSessions({ directory: root })[0]!.title).toBe("Final title");
  });

  test("prefers an explicit custom title over the latest ai-title", () => {
    const root = makeRoot();
    const id = uuid(1);
    const path = join(root, `${id}.jsonl`);
    writeFileSync(path, [
      JSON.stringify({ type: "ai-title", aiTitle: "AI guess", sessionId: id }),
      JSON.stringify({ type: "custom-title", customTitle: "Renamed", sessionId: id }),
      JSON.stringify({ type: "ai-title", aiTitle: "Late AI guess", sessionId: id })
    ].join("\n"));

    expect(scanResumableSessions({ directory: root })[0]!.title).toBe("Renamed");
  });

  test("keeps an early title when the bounded tail no longer contains it", () => {
    const root = makeRoot();
    const id = uuid(1);
    const path = join(root, `${id}.jsonl`);
    writeFileSync(path, [
      JSON.stringify({ type: "ai-title", aiTitle: "Early title", sessionId: id }),
      ...Array.from({ length: 40 }, (_, index) =>
        JSON.stringify({ type: "progress", index, sessionId: id, text: "x".repeat(20) }))
    ].join("\n"));

    expect(scanResumableSessions({ directory: root, tailBytes: 128 })[0]!.title).toBe("Early title");
  });

  test("excludes a transcript whose records belong to another session", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Foreign", sessionIdInFile: uuid(9) });
    writeSession(root, uuid(2), { title: "Local" });

    expect(scanResumableSessions({ directory: root }).map(entry => entry.sessionId)).toEqual([uuid(2)]);
  });

  test("uses honest non-content fallbacks when native ai-title is absent", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { mtimeSeconds: 1_000 });
    writeSession(root, uuid(2), {
      mtimeSeconds: 2_000,
      extraLines: [JSON.stringify({ type: "assistant", message: { model: "claude-opus-5" } })]
    });
    writeSession(root, uuid(3), {
      mtimeSeconds: 1_500,
      extraLines: [JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } })]
    });

    expect(scanResumableSessions({ directory: root }).map(entry => entry.title)).toEqual([
      "Conversation with Claudio",
      "Control-only session",
      "Control-only session"
    ]);
  });

  test("sanitizes and truncates titles instead of forwarding transcript text", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: `line one\nline\ttwo ${"x".repeat(200)}`, mtimeSeconds: 2_000 });
    writeSession(root, uuid(2), { title: "  spaced   out  ", mtimeSeconds: 1_000 });

    const entries = scanResumableSessions({ directory: root });

    expect(entries[0]!.title.length).toBeLessThanOrEqual(61);
    expect(entries[0]!.title).not.toContain("\n");
    expect(entries[0]!.title).not.toContain("\t");
    expect(entries[0]!.title.endsWith("…")).toBe(true);
    expect(entries[1]!.title).toBe("spaced out");
  });

  test("never returns transcript bodies, paths, or prompts", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), {
      title: "Titled",
      extraLines: [JSON.stringify({
        type: "user",
        sessionId: uuid(1),
        message: { role: "user", content: "my secret prompt about /srv/secret" }
      })]
    });

    const entry = scanResumableSessions({ directory: root })[0]!;

    expect(Object.keys(entry).sort()).toEqual(["lastActivityMs", "sessionId", "title"]);
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  test("returns nothing for a missing, non-directory, or symlinked directory", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Real" });
    const link = join(root, "link");
    symlinkSync(root, link);

    expect(scanResumableSessions({ directory: join(root, "missing") })).toEqual([]);
    expect(scanResumableSessions({ directory: join(root, `${uuid(1)}.jsonl`) })).toEqual([]);
    expect(scanResumableSessions({ directory: link })).toEqual([]);
  });

  test("stops after the directory entry budget", () => {
    const root = makeRoot();
    for (let index = 1; index <= 20; index += 1) {
      writeSession(root, uuid(index), { title: `Session ${index}`, mtimeSeconds: 1_000 + index });
    }

    expect(scanResumableSessions({ directory: root, maxDirectoryEntries: 3 }).length).toBeLessThanOrEqual(3);
  });
});

describe("bounded activity formatting", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");

  test("renders coarse relative time and falls back to an ISO date", () => {
    expect(formatActivity(now - 5_000, now)).toBe("just now");
    expect(formatActivity(now - 12 * 60_000, now)).toBe("12m ago");
    expect(formatActivity(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatActivity(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatActivity(now - 40 * 86_400_000, now)).toBe("2026-07-10");
  });

  test("never renders a future or clock-skewed activity as negative", () => {
    expect(formatActivity(now + 60_000, now)).toBe("just now");
  });
});

describe("selected session revalidation", () => {
  test("extracts only bounded semantic title context", () => {
    const root = makeRoot();
    const id = uuid(1);
    writeSession(root, id, { extraLines: [
      JSON.stringify({ type: "user", message: { content: "<local-command-output>agents</local-command-output>" } }),
      JSON.stringify({ type: "user", message: { content: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="1">/usage</channel>' } }),
      JSON.stringify({ type: "user", message: { content: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="2">Build the auth flow</channel>' } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [
        { type: "tool_use", name: "Read", input: { password: "never-return-this" } },
        { type: "text", text: "Implemented the authentication flow." }
      ] } }),
      JSON.stringify({ type: "tool_result", output: "never-return-this" }),
      JSON.stringify({ type: "custom-title", customTitle: "Manual title", sessionId: id }),
      JSON.stringify({ type: "ai-title", aiTitle: "Late AI title", sessionId: id })
    ] });

    const context = readSessionTitleContext({ directory: root, sessionId: id });
    expect(context).toEqual({
      customTitle: "Manual title",
      aiTitle: "Late AI title",
      chatId: "123",
      chatMessageId: "2",
      userPrompt: "Build the auth flow",
      assistantText: "Implemented the authentication flow.",
      toolNames: ["Read"],
      hasIncompleteForkedTask: false
    });
    expect(JSON.stringify(context)).not.toContain("never-return-this");
  });

  test("accepts a session that is still a valid owned transcript", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Real" });

    expect(() => assertUsableSessionTranscript({ directory: root, sessionId: uuid(1) })).not.toThrow();
  });

  test("reads only the latest concrete assistant model", () => {
    const root = makeRoot();
    const id = uuid(1);
    writeSession(root, id, { extraLines: [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6" } }),
      JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5" } })
    ] });
    expect(readLatestSessionModel({ directory: root, sessionId: id })).toBe("claude-opus-5");
  });

  test("rejects a non-UUID, traversal, or absolute session identifier", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Real" });

    for (const bad of ["../../etc/passwd", "/etc/passwd", "not-a-uuid", "", `${uuid(1)}.jsonl`]) {
      expect(() => assertUsableSessionTranscript({ directory: root, sessionId: bad })).toThrow();
    }
  });

  test("rejects a missing, symlinked, empty, oversized, or foreign transcript", () => {
    const root = makeRoot();
    const real = writeSession(root, uuid(1), { title: "Real" });
    symlinkSync(real, join(root, `${uuid(2)}.jsonl`));
    writeFileSync(join(root, `${uuid(3)}.jsonl`), "");
    writeSession(root, uuid(4), { title: "Foreign", sessionIdInFile: uuid(9) });

    expect(() => assertUsableSessionTranscript({ directory: root, sessionId: uuid(5) })).toThrow();
    expect(() => assertUsableSessionTranscript({ directory: root, sessionId: uuid(2) })).toThrow();
    expect(() => assertUsableSessionTranscript({ directory: root, sessionId: uuid(3) })).toThrow();
    expect(() => assertUsableSessionTranscript({ directory: root, sessionId: uuid(4) })).toThrow();
    expect(() => assertUsableSessionTranscript({
      directory: root,
      sessionId: uuid(1),
      maxFileBytes: 4
    })).toThrow();
  });

  test("rejects a transcript owned by another user", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Real" });

    expect(() => assertUsableSessionTranscript({
      directory: root,
      sessionId: uuid(1),
      expectedUid: 999_999
    })).toThrow();
  });

  test("rejects a writable or multiply-linked selected transcript", () => {
    const root = makeRoot();
    const writable = writeSession(root, uuid(1), { title: "Writable" });
    chmodSync(writable, 0o620);
    expect(() => assertUsableSessionTranscript({ directory: root, sessionId: uuid(1) })).toThrow();

    const linked = writeSession(root, uuid(2), { title: "Linked" });
    linkSync(linked, join(root, "shadow.jsonl"));
    expect(() => assertUsableSessionTranscript({ directory: root, sessionId: uuid(2) })).toThrow();
  });

  test("rejects a symlinked or missing sessions directory", () => {
    const root = makeRoot();
    writeSession(root, uuid(1), { title: "Real" });
    const link = join(root, "link");
    symlinkSync(root, link);

    expect(() => assertUsableSessionTranscript({ directory: link, sessionId: uuid(1) })).toThrow();
    expect(() => assertUsableSessionTranscript({ directory: join(root, "missing"), sessionId: uuid(1) })).toThrow();
  });
});
