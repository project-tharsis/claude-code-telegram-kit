import { describe, expect, test } from "bun:test";
import {
  DELEGATING_LABEL,
  isInternalSidecarTool,
  SAFE_STEP_LABELS,
  safeStepLabel
} from "../src/progress-labels.js";

describe("internal sidecar tool filtering", () => {
  test("filters every renderer and control tool, public or internal", () => {
    for (const name of [
      "mcp__telegram-renderer__send_reply",
      "mcp__telegram-renderer__bind_turn",
      "mcp__telegram-renderer__record_tool",
      "mcp__session-control__schedule_session_reset",
      "mcp__session-control__list_sessions",
      "mcp__session-control__bind_command"
    ]) {
      expect(isInternalSidecarTool(name)).toBe(true);
      expect(safeStepLabel(name)).toBeNull();
    }
  });

  test("does not filter the official channel or unrelated MCP servers", () => {
    expect(isInternalSidecarTool("mcp__plugin_telegram_telegram__reply")).toBe(false);
    expect(isInternalSidecarTool("mcp__other__telegram-renderer")).toBe(false);
    expect(isInternalSidecarTool("Read")).toBe(false);
  });
});

describe("safe step labels", () => {
  test("maps known tools to fixed labels", () => {
    expect(safeStepLabel("Read")).toBe("Reading files");
    expect(safeStepLabel("Grep")).toBe("Reading files");
    expect(safeStepLabel("Edit")).toBe("Editing files");
    expect(safeStepLabel("Write")).toBe("Editing files");
    expect(safeStepLabel("Bash")).toBe("Running commands");
    expect(safeStepLabel("WebSearch")).toBe("Searching the web");
    expect(safeStepLabel("WebFetch")).toBe("Searching the web");
    expect(safeStepLabel("TodoWrite")).toBe("Planning");
    expect(safeStepLabel("Skill")).toBe("Running a skill");
    expect(safeStepLabel("Task")).toBe(DELEGATING_LABEL);
  });

  test("maps unrelated MCP tools to one integration label without leaking the server", () => {
    expect(safeStepLabel("mcp__claude_ai_Notion__notion-search")).toBe("Using an integration");
    expect(safeStepLabel("mcp__plugin_telegram_telegram__reply")).toBe("Using an integration");
  });

  test("maps unknown tools to a generic label instead of echoing the name", () => {
    expect(safeStepLabel("SomeBrandNewTool")).toBe("Working");
    expect(SAFE_STEP_LABELS).toContain("Working");
  });

  test("collapses every subagent internal to one delegating label", () => {
    for (const name of ["Read", "Bash", "mcp__x__y", "SomeBrandNewTool", "Task"]) {
      expect(safeStepLabel(name, "agent-7")).toBe(DELEGATING_LABEL);
    }
  });

  test("still filters sidecar tools called from inside a subagent", () => {
    expect(safeStepLabel("mcp__telegram-renderer__send_reply", "agent-7")).toBeNull();
  });

  test("every produced label is in the fixed safe set", () => {
    const produced = ["Read", "Edit", "Bash", "WebFetch", "TodoWrite", "Skill", "Task", "mcp__a__b", "Zzz"]
      .map(name => safeStepLabel(name))
      .filter(label => label !== null);
    for (const label of produced) expect(SAFE_STEP_LABELS).toContain(label);
    expect(SAFE_STEP_LABELS).toContain(DELEGATING_LABEL);
  });

  test("labels never contain path, argument, or URL characters", () => {
    for (const label of SAFE_STEP_LABELS) {
      expect(label).toMatch(/^[A-Za-z ]{1,32}$/);
    }
  });
});
