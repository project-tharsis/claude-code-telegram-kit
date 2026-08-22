import { describe, expect, test } from "bun:test";
import { BIND_TURN_TOOL, createHookToolHandler, HOOK_TOOL_NAMES, INTERNAL_HOOK_TOOLS, RECORD_TOOL_TOOL } from "../src/hook-tools.js";
import { RecordToolInputSchema } from "../src/hook-contract.js";
import { createTurnDisclosure } from "../src/progress-disclosure.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";


const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";

function recorder() {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const disclosure = {
    bindTurn: (input: unknown) => {
      calls.push({ kind: "bind", input });
      return null;
    },
    recordTool: (input: unknown) => {
      calls.push({ kind: "tool", input });
    },

    recordSuccess: (input: unknown) => {
      calls.push({ kind: "success", input });
    },
    recordFailure: (input: unknown) => {
      calls.push({ kind: "failure", input });
    },
    finishTurn: async (input: unknown) => {
      calls.push({ kind: "finish", input });
      return "finished" as const;
    }
  };
  return { calls, handle: createHookToolHandler(disclosure) };
}

describe("internal hook tool declarations", () => {
  test("advertise only the internal hook tools", () => {
    expect(HOOK_TOOL_NAMES).toEqual([
      "bind_turn", "record_tool", "record_tool_success", "record_tool_failure", "finish_turn"
    ]);
    expect(HOOK_TOOL_NAMES).not.toContain("send_reply");

    for (const tool of INTERNAL_HOOK_TOOLS) {
      expect(tool.description).toContain("Internal Claude Code hook tool");
      expect(tool.annotations.readOnlyHint).toBe(tool.name !== "finish_turn");
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  test("declare strict schemas that require the hook event name", () => {
    for (const tool of INTERNAL_HOOK_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toContain("hook_event_name");
      expect(tool.inputSchema.required).toContain("session_id");
      expect(tool.inputSchema.required).toContain("prompt_id");
      expect(Object.keys(tool.inputSchema.properties)).not.toContain("tool_input");
    }
  });

  test("declares the optional transcript authority accepted by bind_turn", () => {
    expect(BIND_TURN_TOOL.inputSchema.properties.transcript_path).toEqual({
      type: "string",
      maxLength: 8192
    });
  });

  test("allows Claude's empty substitution for an absent optional agent_id", () => {
    expect(RECORD_TOOL_TOOL.inputSchema.properties.agent_id.pattern).toBe(
      "^(?:|[A-Za-z0-9_.:-]{1,128})$"
    );
    expect(RecordToolInputSchema.parse({
      session_id: SESSION,
      prompt_id: "p1",
      tool_use_id: "t1",
      tool_name: "Read",
      agent_id: "",
      hook_event_name: "PreToolUse"
    }).agent_id).toBeUndefined();
  });
});

describe("internal hook tool handler", () => {
  test("routes a transport-large final instead of swallowing it", async () => {
    const { calls, handle } = recorder();
    const result = await handle("finish_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      last_assistant_message: "x".repeat(100_001),
      hook_event_name: "Stop"
    });
    expect(calls.map(call => call.kind)).toEqual(["finish"]);
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("blocks Stop only when final delivery asks Claude to shorten", async () => {
    const handle = createHookToolHandler({
      bindTurn: () => undefined,
      recordTool: () => undefined,

      recordSuccess: () => undefined,
      recordFailure: () => undefined,
      finishTurn: async () => "retry"
    });
    const result = await handle("finish_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      last_assistant_message: "x".repeat(5_000),
      hook_event_name: "Stop"
    });
    const first = result!.content[0]!;
    if (first.type !== "text") throw new Error("expected text");
    expect(JSON.parse(first.text)).toEqual({
      decision: "block",
      reason: "Final Telegram reply is too long. Return a shorter final response.",
      hookSpecificOutput: { hookEventName: "Stop" }
    });
  });

  test("routes each hook event to its disclosure entry point", async () => {
    const { calls, handle } = recorder();
    await handle("bind_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      prompt: "<channel source=\"telegram\" chat_id=\"1\" message_id=\"2\">hi",
      hook_event_name: "UserPromptSubmit"
    });
    await handle("record_tool", {
      session_id: SESSION,
      prompt_id: "p1",
      tool_use_id: "t1",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    });

    await handle("record_tool_success", {
      session_id: SESSION,
      prompt_id: "p1",
      tool_use_id: "t1",
      hook_event_name: "PostToolUse"
    });
    await handle("record_tool_failure", {
      session_id: SESSION,
      prompt_id: "p1",
      tool_use_id: "t1",
      hook_event_name: "PostToolUseFailure"
    });
    await handle("finish_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      last_assistant_message: "",
      hook_event_name: "Stop"
    });
    expect(calls.map(call => call.kind)).toEqual(["bind", "tool", "success", "failure", "finish"]);
  });

  test("returns a non-blocking empty receipt so no hook output enters the transcript", async () => {
    const { handle } = recorder();
    const result = await handle("finish_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      hook_event_name: "Stop"
    });
    expect(result!.isError).toBeFalsy();
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("bind_turn never emits a sessionTitle for ordinary Telegram messages", async () => {
    const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };
    const realDisclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      send: async () => ({ kind: "sent", messageId: 1 }),
      edit: async () => ({ kind: "edited" }),
      schedule: () => () => undefined
    });
    const handle = createHookToolHandler(realDisclosure);
    const result = await handle("bind_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">git bisect is stuck</channel>',
      hook_event_name: "UserPromptSubmit"
    });
    expect(result!.isError).toBeFalsy();
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("a second message in the same session still binds progress without a sessionTitle", async () => {
    const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };
    const sends: string[] = [];
    const scheduled: { run: (() => Promise<void>) | null } = { run: null };
    const realDisclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      send: async () => {
        sends.push("sent");
        return { kind: "sent", messageId: 1 };
      },
      edit: async () => ({ kind: "edited" }),
      schedule: run => {
        scheduled.run = run;
        return () => {
          scheduled.run = null;
        };
      }
    });
    const handle = createHookToolHandler(realDisclosure);

    const first = await handle("bind_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">first message</channel>',
      hook_event_name: "UserPromptSubmit"
    });
    expect(first!.content).toEqual([{ type: "text", text: "" }]);

    const second = await handle("bind_turn", {
      session_id: SESSION,
      prompt_id: "p2",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="10">second message</channel>',
      hook_event_name: "UserPromptSubmit"
    });
    expect(second!.content).toEqual([{ type: "text", text: "" }]);

    await handle("record_tool", {
      session_id: SESSION,
      prompt_id: "p2",
      tool_use_id: "t1",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    });
    expect(scheduled.run).not.toBeNull();
    await scheduled.run!();
    expect(sends).toEqual(["sent"]);
  });

  test("bind_turn never titles control commands or empty bodies", async () => {
    const { handle } = recorder();
    for (const body of ["/sessions", "/resume 1", "/reset", ""]) {
      const result = await handle("bind_turn", {
        session_id: SESSION,
        prompt_id: "p9",
        prompt: `<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">${body}</channel>`,
        hook_event_name: "UserPromptSubmit"
      });
      expect(result!.content).toEqual([{ type: "text", text: "" }]);
    }
  });

  test("rejects a spoofed or mismatched hook_event_name without acting", async () => {
    const { calls, handle } = recorder();
    const result = await handle("record_tool", {
      session_id: SESSION,
      prompt_id: "p1",
      tool_use_id: "t1",
      tool_name: "Read",
      hook_event_name: "UserPromptSubmit"
    });
    expect(calls).toEqual([]);
    expect(result!.isError).toBeFalsy();
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("rejects malformed payloads and raw tool_input without acting", async () => {
    const { calls, handle } = recorder();
    await handle("record_tool", {
      session_id: SESSION,
      prompt_id: "p1",
      tool_use_id: "t1",
      tool_name: "Read",
      tool_input: { file_path: "/etc/shadow" },
      hook_event_name: "PreToolUse"
    });
    await handle("bind_turn", { session_id: "", prompt_id: "", prompt: "x", hook_event_name: "UserPromptSubmit" });
    await handle("finish_turn", null);
    expect(calls).toEqual([]);
  });

  test("never throws even when the disclosure engine fails", async () => {
    const handle = createHookToolHandler({
      bindTurn: () => {
        throw new Error("boom");
      },
      recordTool: () => {
        throw new Error("boom");
      },

      recordSuccess: () => {
        throw new Error("boom");
      },
      recordFailure: () => {
        throw new Error("boom");
      },
      finishTurn: async () => {
        throw new Error("boom");
      }
    });
    const result = await handle("finish_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      hook_event_name: "Stop"
    });
    expect(result!.isError).toBeFalsy();
  });

  test("returns null for tools it does not own so the server can reject them uniformly", async () => {
    const { handle } = recorder();
    expect(await handle("send_reply", {})).toBeNull();
    expect(await handle("anything_else", {})).toBeNull();
  });
});
