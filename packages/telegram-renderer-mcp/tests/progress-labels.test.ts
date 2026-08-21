import { describe, expect, test } from "bun:test";
import {
  DELEGATING_LABEL,
  isInternalSidecarTool,
  SAFE_STEP_LABELS,
  safeStepLabel,
  safeStepPresentation
} from "../src/progress-labels.js";

describe("internal sidecar tool filtering", () => {
  test("filters every renderer and control tool, public or internal", () => {
    for (const name of [
      "mcp__telegram-renderer__send_reply",
      "mcp__telegram-renderer__bind_turn",
      "mcp__telegram-renderer__record_tool",
      "mcp__telegram-renderer__finish_turn",
      "mcp__session-control__dispatch_command"
    ]) {
      expect(isInternalSidecarTool(name)).toBe(true);
      expect(safeStepPresentation(name)).toBeNull();
    }
  });

  test("does not filter the official channel or unrelated MCP servers", () => {
    expect(isInternalSidecarTool("mcp__plugin_telegram_telegram__reply")).toBe(false);
    expect(isInternalSidecarTool("mcp__other__telegram-renderer")).toBe(false);
    expect(isInternalSidecarTool("Read")).toBe(false);
  });
});

describe("safe step presentation", () => {
  test("maps known tools to fixed emoji and friendly verbs", () => {
    expect(safeStepPresentation("Read")).toMatchObject({ emoji: "📖", label: "Reading", kind: "inline" });
    expect(safeStepPresentation("Grep")).toMatchObject({ emoji: "🔎", label: "Searching code", connector: " for " });
    expect(safeStepPresentation("Edit")).toMatchObject({ emoji: "🔧", label: "Editing" });
    expect(safeStepPresentation("Write")).toMatchObject({ emoji: "✍️", label: "Writing" });
    expect(safeStepPresentation("Bash")).toEqual({ emoji: "💻", label: "terminal", kind: "command", connector: " " });
    expect(safeStepPresentation("WebSearch")).toMatchObject({ emoji: "🔍", label: "Searching web" });
    expect(safeStepPresentation("Skill")).toMatchObject({ emoji: "📚", label: "Reading skill" });
    expect(safeStepLabel("Task")).toBe(DELEGATING_LABEL);
    expect(safeStepPresentation("Artifact")).toMatchObject({ emoji: "📦", label: "Creating artifact" });
  });

  test("maps unrelated MCP tools without leaking the server name", () => {
    expect(safeStepPresentation("mcp__claude_ai_Notion__notion-search"))
      .toEqual({ emoji: "🔌", label: "Using integration", kind: "inline", connector: " " });
    expect(safeStepPresentation("mcp__plugin_telegram_telegram__reply")?.label).toBe("Using integration");
  });

  test("maps unknown tools to one generic presentation", () => {
    expect(safeStepPresentation("SomeBrandNewTool"))
      .toEqual({ emoji: "⚙️", label: "Working", kind: "inline", connector: " " });
    expect(SAFE_STEP_LABELS).toContain("Working");
  });

  test("keeps granular tool presentation inside a subagent", () => {
    expect(safeStepPresentation("Read", "agent-7")?.label).toBe("Reading");
    expect(safeStepPresentation("Bash", "agent-7")?.kind).toBe("command");
    expect(safeStepPresentation("mcp__x__y", "agent-7")?.label).toBe("Using integration");
    expect(safeStepPresentation("Task", "agent-7")?.label).toBe(DELEGATING_LABEL);
  });

  test("still filters sidecar tools called from inside a subagent", () => {
    expect(safeStepPresentation("mcp__telegram-renderer__send_reply", "agent-7")).toBeNull();
  });

  test("every produced label is in the fixed safe set", () => {
    const produced = ["Read", "Edit", "Bash", "WebFetch", "TodoWrite", "Skill", "Artifact", "Task", "mcp__a__b", "Zzz"]
      .map(name => safeStepLabel(name))
      .filter(label => label !== null);
    for (const label of produced) expect(SAFE_STEP_LABELS).toContain(label);
    expect(SAFE_STEP_LABELS).toContain(DELEGATING_LABEL);
  });

  test("labels never contain path, argument, or URL characters", () => {
    for (const label of SAFE_STEP_LABELS) expect(label).toMatch(/^[A-Za-z ]{1,32}$/);
  });
});
