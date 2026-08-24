import { describe, expect, test } from "bun:test";
import { BackgroundProgress } from "../src/background-progress.js";
import type { ProgressStep } from "../src/progress-preview.js";

const reading = (preview = "broker.test.ts"): ProgressStep => ({
  emoji: "📖",
  label: "Reading",
  kind: "inline",
  connector: " ",
  preview
});

const editing = (preview = "broker.test.ts"): ProgressStep => ({
  emoji: "🔧",
  label: "Editing",
  kind: "inline",
  connector: " ",
  preview
});

describe("event-driven background progress", () => {
  test("renders active agents and only their latest verified tool activity", () => {
    const progress = new BackgroundProgress();
    expect(progress.recordStart("agent-1", "code-review")).toBe(true);
    expect(progress.recordTool("agent-1", "tool-1", reading())).toBe(true);
    expect(progress.recordSuccess("tool-1")).toBe(true);
    expect(progress.recordTool("agent-1", "tool-2", editing())).toBe(true);

    expect(progress.render()).toBe([
      "Background work · 1 running…",
      "👥 code-review · Running",
      "└ 🔧 Editing broker.test.ts"
    ].join("\n"));
  });

  test("waits for the parent task terminal event after every observed agent stops", () => {
    const progress = new BackgroundProgress();
    expect(progress.recordTaskStart("parent-tool")).toBe(true);
    expect(progress.recordStart("agent-1", "code-review")).toBe(true);
    expect(progress.recordStop("agent-1")).toBe(true);
    expect(progress.hasActive).toBe(false);
    expect(progress.render()).toBe([
      "Background work · Finalizing…",
      "✅ code-review · Done"
    ].join("\n"));
    expect(progress.recordTaskTerminal("parent-tool")).toBe(true);
    expect(progress.render()).toBe([
      "Background work · Done",
      "✅ code-review · Done"
    ].join("\n"));
  });

  test("renders killed and failed agent terminals distinctly", () => {
    const stopped = new BackgroundProgress();
    stopped.recordTaskStart("parent-stop");
    stopped.recordStart("agent-stop", "reviewer");
    stopped.recordTool("agent-stop", "tool-stop", reading());
    expect(stopped.recordAgentTerminal("agent-stop", "killed")).toBe(true);
    stopped.recordTaskTerminal("parent-stop");
    expect(stopped.render()).toBe([
      "Background work · Stopped",
      "⏹ reviewer · Stopped",
      "└ ⏹ 📖 Reading broker.test.ts"
    ].join("\n"));

    const failed = new BackgroundProgress();
    failed.recordStart("agent-fail", "tester");
    expect(failed.recordAgentTerminal("agent-fail", "failed")).toBe(true);
    expect(failed.render()).toBe([
      "Background work · Failed",
      "❌ tester · Failed"
    ].join("\n"));
  });

  test("isolates parallel agents and marks a failed last action without ingesting output", () => {
    const progress = new BackgroundProgress();
    progress.recordStart("agent-1", "reviewer");
    progress.recordStart("agent-2", "tester");
    progress.recordTool("agent-1", "tool-1", reading("router.ts"));
    progress.recordTool("agent-2", "tool-2", editing("server.test.ts"));
    progress.recordFailure("tool-2");
    progress.recordStop("agent-1");

    expect(progress.render()).toBe([
      "Background work · 1 running…",
      "✅ reviewer · Done",
      "└ 📖 Reading router.ts",
      "👥 tester · Running",
      "└ ❌ 🔧 Editing server.test.ts"
    ].join("\n"));
  });

  test("bounds retained agents and strips terminal command previews", () => {
    const progress = new BackgroundProgress();
    for (let index = 0; index < 16; index += 1) {
      expect(progress.recordTaskStart(`parent-${index}`)).toBe(true);
      expect(progress.recordStart(`agent-${index}`, "reviewer")).toBe(true);
    }
    expect(progress.recordTaskStart("parent-overflow")).toBe(false);
    expect(progress.recordStart("agent-overflow", "reviewer")).toBe(false);
    expect(progress.recordTool("agent-0", "shell-1", {
      emoji: "💻",
      label: "terminal",
      kind: "command",
      connector: " ",
      preview: "gh pr checks 79 --watch"
    })).toBe(true);
    expect(progress.render()).not.toContain("gh pr checks");
    expect(progress.render().length).toBeLessThanOrEqual(4_096);
  });

  test("ignores tools whose agent was never started on this bound turn", () => {
    const progress = new BackgroundProgress();
    expect(progress.recordTool("other-agent", "tool-1", reading())).toBe(false);
    expect(progress.hasAgents).toBe(false);
    expect(progress.render()).toBe("");
  });
});
