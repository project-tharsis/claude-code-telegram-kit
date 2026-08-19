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

  test("all mode gives a shorter bounded preview", () => {
    const step = buildProgressStep("Bash", { command: "x".repeat(200) }, "all")!;
    expect(step.endsWith("…")).toBe(true);
    expect(step.length).toBeLessThan(120);
  });

  test("shows integration names but never internal sidecar plumbing", () => {
    expect(buildProgressStep("mcp__github__search_issues", { query: "bug" }, "verbose"))
      .toBe("Use github.search_issues — bug");
    expect(buildProgressStep("mcp__telegram-renderer__send_reply", {}, "verbose")).toBeNull();
  });

  test("subagent internals collapse to delegation with a bounded description", () => {
    expect(buildProgressStep("Bash", { description: "review auth flow" }, "verbose", "agent-1"))
      .toBe("Delegate work");
    expect(buildProgressStep("Task", { description: "review auth flow" }, "verbose", "agent-1"))
      .toBe("Delegate work — review auth flow");
  });

  test("invalid configured modes fail safe", () => {
    expect(parseToolDisclosureMode("verbose")).toBe("verbose");
    expect(parseToolDisclosureMode("nope")).toBe("safe");
    expect(parseToolDisclosureMode(undefined)).toBe("safe");
  });
});
