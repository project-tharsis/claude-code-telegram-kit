import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOOK_TOOL_NAMES } from "../src/hook-tools.js";

interface HookEntry {
  matcher?: string;
  hooks: Array<{
    type: string;
    server?: string;
    tool?: string;
    command?: string;
    timeout?: number;
    input: Record<string, string>;
  }>;
}

interface Settings {
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  hooks: Record<string, HookEntry[]>;
}

const settings = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../../examples/telegram-settings.json"),
  "utf8"
)) as Settings;

function toolsFor(event: string): Array<{ server: string; tool: string; input: Record<string, string> }> {
  return (settings.hooks[event] ?? []).flatMap(entry =>
    entry.hooks
      .filter((hook): hook is { type: string; server: string; tool: string; input: Record<string, string> } =>
        hook.type === "mcp_tool" && typeof hook.server === "string" && typeof hook.tool === "string"
      )
      .map(hook => ({ server: hook.server, tool: hook.tool, input: hook.input }))
  );
}

describe("supported Claude Code hook configuration", () => {
  test("denies every internal hook tool to the model while allowing public delivery", () => {
    for (const tool of HOOK_TOOL_NAMES) {
      expect(settings.permissions.deny).toContain(`mcp__telegram-renderer__${tool}`);
    }
    expect(settings.permissions.deny).toContain("mcp__session-control__bind_command");
    expect(settings.permissions.allow).toContain("mcp__telegram-renderer__send_reply");
    expect(settings.permissions.allow).toContain("mcp__session-control__list_sessions");
    expect(settings.permissions.ask).toContain("mcp__session-control__resume_session");
    expect(settings.permissions.ask).toContain("mcp__session-control__schedule_session_reset");
  });

  test("wires each lifecycle event to the exact internal MCP tool", () => {
    expect(toolsFor("UserPromptSubmit").map(hook => `${hook.server}:${hook.tool}`)).toEqual([
      "telegram-renderer:bind_turn",
      "session-control:bind_command"
    ]);
    expect(toolsFor("PreToolUse").map(hook => hook.tool)).toEqual(["record_tool"]);
    expect(toolsFor("PostToolUseFailure").map(hook => hook.tool)).toEqual(["record_tool_failure"]);
    expect(toolsFor("Stop").map(hook => hook.tool)).toEqual(["finish_turn"]);
    expect(toolsFor("StopFailure").map(hook => hook.tool)).toEqual(["finish_turn"]);
  });

  test("wires a deterministic SessionStart receipt hook for fresh resets", () => {
    const starts = settings.hooks.SessionStart ?? [];
    const startup = starts.find(entry => entry.matcher === "startup");
    expect(startup).toBeDefined();
    const hook = startup!.hooks[0]!;
    expect(hook.type).toBe("command");
    expect(hook.command).toMatch(/^\/usr\/local\/sbin\/claude-session-start-receipt\b/);
    expect(hook.timeout ?? 10).toBeLessThanOrEqual(10);
  });

  test("excludes internal sidecar tools from tool-event matchers", () => {
    const internal = "^(?!mcp__telegram-renderer__|mcp__session-control__).*";
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe(internal);
    expect(settings.hooks.PostToolUseFailure![0]!.matcher).toBe(internal);
    expect(settings.hooks.Stop![0]!.matcher).toBeUndefined();
  });

  test("passes only bounded identifiers to tool disclosure and preserves optional subagent identity", () => {
    const input = toolsFor("PreToolUse")[0]!.input;
    expect(input).toEqual({
      session_id: "${session_id}",
      prompt_id: "${prompt_id}",
      tool_use_id: "${tool_use_id}",
      tool_name: "${tool_name}",
      agent_id: "${agent_id}",
      hook_event_name: "PreToolUse"
    });
    expect(input).not.toHaveProperty("tool_input");
  });
});
