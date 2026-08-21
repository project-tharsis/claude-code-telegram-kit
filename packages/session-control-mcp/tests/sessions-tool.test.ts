import { describe, expect, test } from "bun:test";
import {
  BIND_COMMAND_TOOL,
  createSessionsToolHandler,
  LIST_SESSIONS_TOOL,
  RESUME_SESSION_TOOL,
  SESSIONS_TOOL_NAMES
} from "../src/sessions-tool.js";


const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";

function harness(overrides: {
  list?: () => Promise<unknown>;
  resume?: () => Promise<unknown>;
  bind?: (input: unknown) => boolean;
} = {}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const handler = createSessionsToolHandler({
    controller: {
      listSessions: async input => {
        calls.push({ kind: "list", input });
        return (await overrides.list?.() ?? { status: "listed", count: 2, ackMessageId: 900 }) as never;
      },
      resumeSession: async input => {
        calls.push({ kind: "resume", input });
        return (await overrides.resume?.() ?? {
          status: "scheduled",
          ackMessageId: 900,
          unit: "claude-session-reset-resume-abc"
        }) as never;
      }
    },
    capabilities: {
      bind: input => {
        calls.push({ kind: "bind", input });
        return overrides.bind?.(input) ?? true;
      }
    }
  });
  return { calls, handler };
}

describe("session control tool declarations", () => {
  test("adds two bounded session tools and one internal binder", () => {
    expect(SESSIONS_TOOL_NAMES).toEqual(["list_sessions", "resume_session", "bind_command"]);
    expect(LIST_SESSIONS_TOOL.annotations.readOnlyHint).toBe(false);
    expect(LIST_SESSIONS_TOOL.annotations.idempotentHint).toBe(false);
    expect(RESUME_SESSION_TOOL.annotations.destructiveHint).toBe(true);
    expect(RESUME_SESSION_TOOL.annotations.idempotentHint).toBe(false);
    expect(BIND_COMMAND_TOOL.description).toContain("Internal Claude Code hook tool");
  });

  test("never exposes a session identifier, path, or command parameter to the model", () => {
    for (const tool of [LIST_SESSIONS_TOOL, RESUME_SESSION_TOOL]) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const properties = Object.keys(tool.inputSchema.properties);
      for (const forbidden of ["session_id", "path", "unit", "service", "command", "helper"]) {
        expect(properties).not.toContain(forbidden);
      }
    }
    expect(Object.keys(RESUME_SESSION_TOOL.inputSchema.properties).sort()).toEqual(["chat_id", "index"]);
  });

  test("bounds the resume index in the declared schema", () => {
    const index = RESUME_SESSION_TOOL.inputSchema.properties.index;
    expect(index.type).toBe("integer");
    expect(index.minimum).toBe(1);
    expect(index.maximum).toBe(10);
  });
});

describe("session control tool handler", () => {
  test("routes list_sessions and returns a bounded receipt", async () => {
    const { calls, handler } = harness();

    const result = await handler("list_sessions", { chat_id: "123" });

    expect(calls).toEqual([{ kind: "list", input: { chat_id: "123" } }]);
    const first = result!.content[0]!;
    if (first.type !== "text") throw new Error("expected text receipt");
    expect(JSON.parse(first.text)).toEqual({ status: "listed", count: 2, ack_message_id: 900 });
  });

  test("routes resume_session and returns the scheduled unit", async () => {
    const { calls, handler } = harness();

    const result = await handler("resume_session", { chat_id: "123", index: 2 });

    expect(calls).toEqual([{ kind: "resume", input: { chat_id: "123", index: 2 } }]);
    const first = result!.content[0]!;
    if (first.type !== "text") throw new Error("expected text receipt");
    expect(JSON.parse(first.text)).toEqual({
      status: "scheduled",
      ack_message_id: 900,
      unit: "claude-session-reset-resume-abc"
    });
  });

  test("rejects a session UUID or a path smuggled into a public tool", async () => {
    const { calls, handler } = harness();

    for (const args of [
      { chat_id: "123", index: 1, session_id: SESSION },
      { chat_id: "123", session_id: SESSION },
      { chat_id: "123", index: "1" },
      { chat_id: "123", index: 0 },
      { chat_id: "123", index: 11 },
      { chat_id: "/etc/passwd", index: 1 }
    ]) {
      const result = await handler("resume_session", args);
      expect(result!.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  test("reports a controller failure as an error receipt without leaking internals", async () => {
    const { handler } = harness({
      resume: async () => {
        throw new Error("selected transcript /srv/secret/x.jsonl is not usable");
      }
    });

    const result = await handler("resume_session", { chat_id: "123", index: 1 });

    expect(result!.isError).toBe(true);
    const first = result!.content[0]!;
    if (first.type !== "text") throw new Error("expected text receipt");
    expect(first.text).toBe("resume request failed");
    expect(first.text).not.toContain("/srv/secret");
  });

  test("binds a command from the hook and returns a non-blocking empty receipt", async () => {
    const { calls, handler } = harness();

    const result = await handler("bind_command", {
      session_id: SESSION,
      prompt_id: "p1",
      prompt: "<channel source=\"telegram\" chat_id=\"123\" message_id=\"9\">/sessions",
      hook_event_name: "UserPromptSubmit"
    });

    expect(calls[0]!.kind).toBe("bind");
    expect(result!.isError).toBeFalsy();
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("rejects a spoofed hook event without binding and without failing", async () => {
    const { calls, handler } = harness();

    const result = await handler("bind_command", {
      session_id: SESSION,
      prompt_id: "p1",
      prompt: "<channel source=\"telegram\" chat_id=\"123\" message_id=\"9\">/sessions",
      hook_event_name: "PreToolUse"
    });

    expect(calls).toEqual([]);
    expect(result!.isError).toBeFalsy();
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("never throws out of the binder even when the store fails", async () => {
    const { handler } = harness({
      bind: () => {
        throw new Error("boom");
      }
    });

    const result = await handler("bind_command", {
      session_id: SESSION,
      prompt_id: "p1",
      prompt: "<channel source=\"telegram\" chat_id=\"123\" message_id=\"9\">/sessions",
      hook_event_name: "UserPromptSubmit"
    });

    expect(result!.isError).toBeFalsy();
  });

  test("returns null for tools it does not own", async () => {
    const { handler } = harness();
    expect(await handler("schedule_session_reset", {})).toBeNull();
    expect(await handler("send_reply", {})).toBeNull();
  });
});
