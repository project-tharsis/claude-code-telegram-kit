import { describe, expect, test } from "bun:test";
import { buildProgressStep, parseToolDisclosureMode } from "../src/progress-preview.js";

describe("progress preview modes", () => {
  test("safe mode shows fixed emoji verbs without arguments", () => {
    expect(buildProgressStep("Read", { file_path: "/home/USER/private/file.ts" }, "safe"))
      .toEqual({ emoji: "📖", label: "Reading", kind: "inline", connector: " " });
    expect(buildProgressStep("Grep", { pattern: "secret", path: "/srv/repo" }, "safe"))
      .toEqual({ emoji: "🔎", label: "Searching code", kind: "inline", connector: " for " });
  });

  test("Read shows a basename and optional line range", () => {
    expect(buildProgressStep("Read", {
      file_path: "/home/USER/repo/telegram-channel-settings.json",
      offset: "82",
      limit: "30"
    }, "verbose")).toMatchObject({
      emoji: "📖",
      label: "Reading",
      preview: "telegram-channel-settings.json L82-111"
    });
    expect(buildProgressStep("Read", { file_path: "/home/USER/repo/src/auth.ts" }, "verbose"))
      .toMatchObject({ preview: "auth.ts" });
    expect(buildProgressStep("Read", {
      file_path: "/home/USER/repo/src/auth.ts",
      offset: String(Number.MAX_SAFE_INTEGER),
      limit: String(Number.MAX_SAFE_INTEGER)
    }, "verbose")).toMatchObject({ preview: `auth.ts L${Number.MAX_SAFE_INTEGER}` });
    expect(buildProgressStep("Read", {
      file_path: "/home/USER/repo/src/auth.ts",
      offset: String(Number.MAX_SAFE_INTEGER),
      limit: "2"
    }, "verbose")).toMatchObject({ preview: `auth.ts L${Number.MAX_SAFE_INTEGER}` });
  });

  test("verbose mode shows filenames and commands but redacts actual secrets", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(buildProgressStep(tool, { file_path: "/home/USER/repo/src/auth.ts" }, "verbose"))
        .toMatchObject({ preview: "auth.ts" });
    }
    for (const path of ["/", "\\", "../../", "C:\\"]) {
      expect(buildProgressStep("Edit", { file_path: path }, "verbose"))
        .toEqual({ emoji: "🔧", label: "Editing", kind: "inline", connector: " " });
    }
    expect(buildProgressStep("Edit", { file_path: "/home/USER/repo/src/auth.ts" }, "verbose"))
      .toMatchObject({ emoji: "🔧", label: "Editing" });
    expect(buildProgressStep("Bash", { command: "pytest tests/auth.py --token abc123" }, "verbose"))
      .toEqual({
        emoji: "💻",
        label: "terminal",
        kind: "command",
        connector: " ",
        preview: "pytest tests/auth.py --token=[REDACTED]"
      });
    const wrapped = "cd ~/claude-code-telegram-kit && sed -n 1,60p packages/telegram-renderer-mcp/src/progress-labels.ts";
    expect(buildProgressStep("Bash", { command: wrapped }, "verbose"))
      .toMatchObject({ preview: "sed -n 1,60p package…/progress-labels.ts" });
  });

  test("all and verbose modes use distinct mobile-width preview bounds", () => {
    const all = buildProgressStep("Bash", { command: "x".repeat(200) }, "all")!;
    const verbose = buildProgressStep("Bash", { command: "x".repeat(200) }, "verbose")!;
    expect(all.preview?.includes("…")).toBe(true);
    expect(verbose.preview?.includes("…")).toBe(true);
    expect(Array.from(all.preview ?? "")).toHaveLength(28);
    expect(Array.from(verbose.preview ?? "")).toHaveLength(40);
  });

  test("shows integration and tool-search previews without internal sidecar plumbing", () => {
    const toolSearch = buildProgressStep(
      "ToolSearch",
      { query: "select:mcp__telegram-renderer__finish_turn" },
      "verbose"
    )!;
    expect(toolSearch.preview?.startsWith("select:mcp__telegram-renderer__")).toBe(true);
    expect(toolSearch.preview?.endsWith("…")).toBe(true);
    expect(buildProgressStep("mcp__github__search_issues", { query: "bug" }, "verbose"))
      .toMatchObject({ emoji: "🔌", label: "Using integration", preview: "bug" });
    expect(buildProgressStep("mcp__telegram-renderer__finish_turn", {}, "verbose")).toBeNull();
    expect(buildProgressStep("VendorControlledToolName", { command: "leak-me" }, "verbose"))
      .toEqual({ emoji: "⚙️", label: "Working", kind: "inline", connector: " " });
  });

  test("subagent internals retain granular sanitized previews", () => {
    expect(buildProgressStep("Bash", { command: "printf secret-material" }, "verbose", "agent-1"))
      .toMatchObject({ emoji: "💻", label: "terminal", preview: "printf secret-material" });
    expect(buildProgressStep("Task", { description: "review auth flow" }, "verbose", "agent-1"))
      .toMatchObject({ emoji: "👥", label: "Delegating", preview: "review auth flow" });
  });

  test("shows the exact bounded Skill name", () => {
    const skill = "s".repeat(80);
    expect(buildProgressStep("Skill", { skill }, "verbose"))
      .toMatchObject({ emoji: "📚", label: "Reading skill", preview: skill });
  });

  test("shows a bounded Artifact description inline", () => {
    expect(buildProgressStep("Artifact", { description: "Architecture report" }, "verbose"))
      .toEqual({
        emoji: "📦",
        label: "Creating artifact",
        kind: "inline",
        connector: " ",
        preview: "Architecture report"
      });
  });

  test("invalid configured modes fail safe", () => {
    expect(parseToolDisclosureMode("verbose")).toBe("verbose");
    expect(parseToolDisclosureMode("nope")).toBe("safe");
    expect(parseToolDisclosureMode(undefined)).toBe("safe");
  });
});
