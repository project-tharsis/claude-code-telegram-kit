import { describe, expect, test } from "bun:test";
import { buildProgressStep, parseToolDisclosureMode } from "../src/progress-preview.js";

describe("progress preview modes", () => {
  test("safe mode shows granular labels without arguments", () => {
    expect(buildProgressStep("Read", { file_path: "/home/USER/private/file.ts" }, "safe")).toBe("Read file");
    expect(buildProgressStep("Grep", { pattern: "secret", path: "/srv/repo" }, "safe")).toBe("Search code");
  });

  test("verbose mode shows VM paths and commands but redacts actual secrets", () => {
    expect(buildProgressStep("Read", { file_path: "/home/USER/repo/src/auth.ts" }, "verbose"))
      .toBe("Read file — /home/USER/repo/src/auth.ts");
    expect(buildProgressStep("Bash", { command: "pytest tests/auth.py --token abc123" }, "verbose"))
      .toBe("Run command — pytest tests/auth.py --token=[REDACTED]");
  });

  test("all and verbose modes use distinct mobile-width preview bounds", () => {
    const all = buildProgressStep("Bash", { command: "x".repeat(200) }, "all")!;
    const verbose = buildProgressStep("Bash", { command: "x".repeat(200) }, "verbose")!;
    const allPreview = all.split(" — ")[1]!;
    const verbosePreview = verbose.split(" — ")[1]!;
    expect(allPreview.endsWith("…")).toBe(true);
    expect(verbosePreview.endsWith("…")).toBe(true);
    expect(Array.from(allPreview)).toHaveLength(28);
    expect(Array.from(verbosePreview)).toHaveLength(40);
  });

  test("shows integration and tool-search names without internal sidecar plumbing", () => {
    const toolSearch = buildProgressStep(
      "ToolSearch",
      { query: "select:mcp__telegram-renderer__send_reply" },
      "verbose"
    )!;
    expect(toolSearch.startsWith("Find tool — select:mcp__telegram-renderer__")).toBe(true);
    expect(toolSearch.endsWith("…")).toBe(true);
    expect(buildProgressStep("mcp__github__search_issues", { query: "bug" }, "verbose"))
      .toBe("Use integration — bug");
    expect(buildProgressStep("mcp__telegram-renderer__send_reply", {}, "verbose")).toBeNull();
    expect(buildProgressStep("VendorControlledToolName", { command: "leak-me" }, "verbose"))
      .toBe("Working");
  });

  test("subagent internals retain granular sanitized previews", () => {
    expect(buildProgressStep("Bash", { command: "printf secret-material" }, "verbose", "agent-1"))
      .toBe("Run command — printf secret-material");
    expect(buildProgressStep("Task", { description: "review auth flow" }, "verbose", "agent-1"))
      .toBe("Delegate work — review auth flow");
  });

  test("shows the exact Skill tool name", () => {
    const skill = `skill-${"x".repeat(80)}`;
    expect(buildProgressStep("Skill", { skill }, "verbose"))
      .toBe(`Run skill — ${skill}`);
  });

  test("invalid configured modes fail safe", () => {
    expect(parseToolDisclosureMode("verbose")).toBe("verbose");
    expect(parseToolDisclosureMode("nope")).toBe("safe");
    expect(parseToolDisclosureMode(undefined)).toBe("safe");
  });
});
