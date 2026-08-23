import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOOK_TOOL_NAMES, INTERNAL_HOOK_TOOLS } from "../src/hook-tools.js";

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
  statusLine?: { type: string; command: string };
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  hooks: Record<string, HookEntry[]>;
}

const settings = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../../examples/telegram-settings.json"),
  "utf8"
)) as Settings;
const mcp = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../../examples/.mcp.json"),
  "utf8"
)) as { mcpServers: {
  "telegram-renderer": { env?: Record<string, string> };
  "session-control": { env?: Record<string, string> };
} };
const service = readFileSync(resolve(import.meta.dir, "../../../examples/claude-telegram.service"), "utf8");
const guidance = readFileSync(resolve(import.meta.dir, "../../../examples/CLAUDE.md"), "utf8");

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
  test("keeps model guidance transport-transparent and free of runtime inventory", () => {
    expect(guidance).toContain("ordinary Claude Code TUI session");
    expect(guidance).toContain("Use normal assistant text, tool calls, and final responses");
    expect(guidance).toContain("The deterministic harness owns delivery and control routing");
    expect(guidance).toContain("inspect the deployed artifact and live runtime state");
    expect(guidance).not.toContain("Put the complete answer in the final response");
    expect(guidance).not.toContain("Do not rely on earlier assistant text");
    for (const command of ["/sessions", "/resume", "/usage", "/model", "/reset"]) {
      expect(guidance).not.toContain(command);
    }
  });

  test("uses one exact workspace/session pair across service and sidecars", () => {
    const workspace = "/home/USER/claude-bot-workspace";
    const sessions = "/home/USER/.claude/projects/-home-USER-claude-bot-workspace";
    expect(service).toContain(`Environment=CLAUDE_WORKSPACE_DIR=${workspace}`);
    expect(service).toContain(`Environment=CLAUDE_PROJECT_SESSIONS_DIR=${sessions}`);
    expect(mcp.mcpServers["telegram-renderer"].env?.CLAUDE_PROJECT_SESSIONS_DIR).toBe(sessions);
    expect(mcp.mcpServers["session-control"].env).toMatchObject({
      CLAUDE_WORKSPACE_DIR: workspace,
      CLAUDE_PROJECT_SESSIONS_DIR: sessions
    });
  });

  test("gives the renderer only the fixed transcript root, never model credentials or auth mode", () => {
    const env = mcp.mcpServers["telegram-renderer"].env ?? {};
    expect(env.CLAUDE_PROJECT_SESSIONS_DIR).toBe("/home/USER/.claude/projects/-home-USER-claude-bot-workspace");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CODE_AUTH_PREFLIGHT");
  });

  test("opts the control sidecar into per-chat command-menu sync", () => {
    const env = mcp.mcpServers["session-control"].env ?? {};
    expect(env.TELEGRAM_COMMAND_MENU_ENABLED).toBe("true");
    expect(env.CLAUDE_WORKSPACE_DIR).toBe("/home/USER/claude-bot-workspace");
    expect(env.CLAUDE_PROJECT_SESSIONS_DIR).toBe("/home/USER/.claude/projects/-home-USER-claude-bot-workspace");
    expect(env).not.toHaveProperty("CLAUDE_SESSION_RESET_HELPER");
    expect(env).not.toHaveProperty("CLAUDE_SESSION_RESET_CONFIG");
    expect(env).not.toHaveProperty("CLAUDE_SESSION_RESET_UNIT_PREFIX");
  });

  test("wires a private statusLine rate-limit snapshot writer", () => {
    expect(settings.statusLine?.type).toBe("command");
    expect(settings.statusLine?.command).toMatch(/^\/usr\/local\/sbin\/claude-usage-snapshot --output \/home\/USER\//);
  });

  test("denies every model-facing reply and session-control tool", () => {
    for (const tool of HOOK_TOOL_NAMES) {
      expect(settings.permissions.deny).toContain(`mcp__telegram-renderer__${tool}`);
    }
    expect([
      ...settings.permissions.allow,
      ...settings.permissions.ask,
      ...settings.permissions.deny
    ]).not.toContain("mcp__telegram-renderer__send_reply");
    expect(settings.permissions.deny).toContain("mcp__plugin_telegram_telegram__reply");
    for (const tool of ["dispatch_command"]) {
      expect(settings.permissions.deny).toContain(`mcp__session-control__${tool}`);
    }
    for (const removed of ["bind_command", "list_sessions", "resume_session"]) {
      expect(settings.permissions.deny).not.toContain(`mcp__session-control__${removed}`);
    }
    expect(settings.permissions.allow.some(tool => tool.startsWith("mcp__session-control__"))).toBe(false);
    expect(settings.permissions.ask.some(tool => tool.startsWith("mcp__session-control__"))).toBe(false);
    expect(settings.permissions.deny).not.toContain("mcp__session-control__schedule_session_reset");
  });

  test("wires each lifecycle event to the exact internal MCP tool", () => {
    expect(toolsFor("UserPromptSubmit").map(hook => `${hook.server}:${hook.tool}`)).toEqual([
      "telegram-renderer:bind_turn",
      "session-control:dispatch_command"
    ]);
    expect(toolsFor("UserPromptSubmit")[0]!.input.transcript_path).toBe("${transcript_path}");
    expect(toolsFor("PreToolUse").map(hook => hook.tool)).toEqual(["record_tool"]);
    expect(toolsFor("PostToolUse").map(hook => hook.tool)).toEqual(["record_tool_success"]);
    expect(toolsFor("PostToolUseFailure").map(hook => hook.tool)).toEqual(["record_tool_failure"]);
    expect(toolsFor("Stop").map(hook => hook.tool)).toEqual(["finish_turn"]);
    expect(toolsFor("Stop")[0]!.input.last_assistant_message).toBe("${last_assistant_message}");
    expect(toolsFor("StopFailure").map(hook => hook.tool)).toEqual(["finish_turn"]);
    expect(toolsFor("StopFailure")[0]!.input.last_assistant_message).toBe("${last_assistant_message}");
  });

  test("keeps example hook inputs inside each advertised renderer schema", () => {
    const declared = new Map<string, Set<string>>(INTERNAL_HOOK_TOOLS.map(tool => [
      tool.name,
      new Set(Object.keys(tool.inputSchema.properties))
    ]));
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"]) {
      for (const hook of toolsFor(event).filter(item => item.server === "telegram-renderer")) {
        expect(declared.has(hook.tool), `${event}:${hook.tool}`).toBe(true);
        for (const key of Object.keys(hook.input)) {
          expect(declared.get(hook.tool)!.has(key), `${event}:${hook.tool}:${key}`).toBe(true);
        }
      }
    }
  });

  test("fails control namespaces closed with an independent command hook guard", () => {
    const guard = settings.hooks.UserPromptSubmit!
      .flatMap(entry => entry.hooks)
      .find(hook => hook.type === "command");
    expect(guard?.command).toBe("/usr/local/sbin/claude-control-command-guard");
    expect(guard?.timeout).toBe(5);
  });

  test("schedules automatic title jobs from command hooks without running the model there", () => {
    for (const event of ["UserPromptSubmit", "Stop"] as const) {
      const hook = settings.hooks[event]!
        .flatMap(entry => entry.hooks)
        .find(item => item.type === "command" && item.command?.includes("session-title-command.ts"));
      expect(hook?.command).toMatch(/^\/home\/USER\/\.bun\/bin\/bun run .*session-title-command\.ts$/);
      expect(hook?.timeout).toBe(30);
    }
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
    expect(settings.hooks.PostToolUse![0]!.matcher).toBe(internal);
    expect(settings.hooks.PostToolUseFailure![0]!.matcher).toBe(internal);
    expect(settings.hooks.Stop![0]!.matcher).toBeUndefined();
  });

  test("passes only selected bounded preview fields, never raw tool_input or output", () => {
    const input = toolsFor("PreToolUse")[0]!.input;
    expect(input).toEqual({
      session_id: "${session_id}",
      prompt_id: "${prompt_id}",
      tool_use_id: "${tool_use_id}",
      tool_name: "${tool_name}",
      agent_id: "${agent_id}",
      command: "${tool_input.command}",
      file_path: "${tool_input.file_path}",
      path: "${tool_input.path}",
      offset: "${tool_input.offset}",
      limit: "${tool_input.limit}",
      pattern: "${tool_input.pattern}",
      query: "${tool_input.query}",
      url: "${tool_input.url}",
      skill: "${tool_input.skill}",
      description: "${tool_input.description}",
      hook_event_name: "PreToolUse"
    });
    expect(input).not.toHaveProperty("tool_input");

  });
});
