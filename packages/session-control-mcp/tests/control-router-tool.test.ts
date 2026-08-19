import { describe, expect, test } from "bun:test";
import {
  CONTROL_COMMAND_TOOL,
  createControlRouterToolHandler
} from "../src/control-router-tool.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
function args(body: string) {
  return {
    session_id: SESSION,
    prompt_id: "p1",
    prompt: `<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">${body}</channel>`,
    hook_event_name: "UserPromptSubmit"
  };
}

describe("deterministic control router hook tool", () => {
  test("is an internal strict UserPromptSubmit tool", () => {
    expect(CONTROL_COMMAND_TOOL.name).toBe("dispatch_command");
    expect(CONTROL_COMMAND_TOOL.description).toContain("Internal Claude Code hook tool");
    expect(CONTROL_COMMAND_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(CONTROL_COMMAND_TOOL.inputSchema.required).toEqual([
      "session_id", "prompt_id", "prompt", "hook_event_name"
    ]);
  });

  test("blocks a handled control command before it reaches the LLM", async () => {
    const handle = createControlRouterToolHandler(async () => ({ handled: true }));
    const result = await handle("dispatch_command", args("/sessions"));
    const first = result!.content[0]!;
    if (first.type !== "text") throw new Error("expected text");
    expect(JSON.parse(first.text)).toEqual({
      decision: "block",
      reason: "Handled by deterministic Telegram session control.",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        suppressOriginalPrompt: true
      }
    });
  });

  test("lets ordinary messages continue to the LLM with no injected context", async () => {
    const handle = createControlRouterToolHandler(async () => ({ handled: false }));
    const result = await handle("dispatch_command", args("hello"));
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("fails a control namespace closed even if dispatcher throws", async () => {
    const handle = createControlRouterToolHandler(async () => {
      throw new Error("boom");
    });
    for (const body of ["/reset", "/resume 1", "/sessions please"]) {
      const result = await handle("dispatch_command", args(body));
      const first = result!.content[0]!;
      if (first.type !== "text") throw new Error("expected text");
      expect(JSON.parse(first.text).decision).toBe("block");
    }
  });

  test("rejects spoofed hook events without blocking or dispatching", async () => {
    let calls = 0;
    const handle = createControlRouterToolHandler(async () => {
      calls += 1;
      return { handled: true };
    });
    const result = await handle("dispatch_command", { ...args("/reset"), hook_event_name: "PreToolUse" });
    expect(calls).toBe(0);
    expect(result!.content).toEqual([{ type: "text", text: "" }]);
  });

  test("returns null for tools it does not own", async () => {
    const handle = createControlRouterToolHandler(async () => ({ handled: false }));
    expect(await handle("send_reply", {})).toBeNull();
  });
});
