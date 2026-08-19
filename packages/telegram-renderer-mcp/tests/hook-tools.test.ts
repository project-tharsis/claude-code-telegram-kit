import { describe, expect, test } from "bun:test";
import {
  createHookToolHandler,
  HOOK_TOOL_NAMES,
  INTERNAL_HOOK_TOOLS,
  RECORD_TOOL_TOOL
} from "../src/hook-tools.js";
import { RecordToolInputSchema } from "../src/hook-contract.js";
import { SEND_REPLY_TOOL } from "../src/unified-tool.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";

function recorder() {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const disclosure = {
    bindTurn: (input: unknown) => {
      calls.push({ kind: "bind", input });
    },
    recordTool: (input: unknown) => {
      calls.push({ kind: "tool", input });
    },
    recordFailure: (input: unknown) => {
      calls.push({ kind: "failure", input });
    },
    finishTurn: async (input: unknown) => {
      calls.push({ kind: "finish", input });
    }
  };
  return { calls, handle: createHookToolHandler(disclosure) };
}

describe("internal hook tool declarations", () => {
  test("are distinguishable from the public reply tool", () => {
    expect(HOOK_TOOL_NAMES).toEqual(["bind_turn", "record_tool", "record_tool_failure", "finish_turn"]);
    expect(HOOK_TOOL_NAMES).not.toContain(SEND_REPLY_TOOL.name);
    for (const tool of INTERNAL_HOOK_TOOLS) {
      expect(tool.description).toContain("Internal Claude Code hook tool");
      expect(tool.annotations.readOnlyHint).toBe(true);
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
    await handle("record_tool_failure", {
      session_id: SESSION,
      prompt_id: "p1",
      tool_use_id: "t1",
      hook_event_name: "PostToolUseFailure"
    });
    await handle("finish_turn", {
      session_id: SESSION,
      prompt_id: "p1",
      hook_event_name: "Stop"
    });
    expect(calls.map(call => call.kind)).toEqual(["bind", "tool", "failure", "finish"]);
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

  test("returns null for a tool it does not own so the reply tool still routes", async () => {
    const { handle } = recorder();
    expect(await handle("send_reply", {})).toBeNull();
    expect(await handle("anything_else", {})).toBeNull();
  });
});
