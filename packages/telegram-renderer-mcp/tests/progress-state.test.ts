import { describe, expect, test } from "bun:test";
import type { SafeStepLabel } from "../src/progress-labels.js";
import type { ProgressStep } from "../src/progress-preview.js";
import {
  MAX_PROGRESS_CHARACTERS,
  selectTurnVerbPair,
  TURN_VERB_PAIRS,
  TurnProgress
} from "../src/progress-state.js";

const TINKERING = { active: "Tinkering…", complete: "Tinkered" };

function newTurn(): TurnProgress {
  return new TurnProgress({ chatId: "123", messageId: "9", sessionId: "s", promptId: "p" }, TINKERING);
}

function inline(label: SafeStepLabel, preview?: string, emoji = "📖"): ProgressStep {
  return { emoji, label, kind: "inline", connector: " ", ...(preview ? { preview } : {}) };
}

function command(preview?: string): ProgressStep {
  return { emoji: "💻", label: "terminal", kind: "command", connector: " ", ...(preview ? { preview } : {}) };
}

describe("turn progress state", () => {
  test("selects one stable Claude-compatible verb pair per turn", () => {
    const key = { sessionId: "session", promptId: "prompt" };
    const first = selectTurnVerbPair(key);
    expect(selectTurnVerbPair(key)).toEqual(first);
    expect(TURN_VERB_PAIRS).toContainEqual(first);
    expect(TURN_VERB_PAIRS).toHaveLength(8);
    expect(TURN_VERB_PAIRS).toContainEqual({ active: "Tinkering…", complete: "Tinkered" });
    expect(TURN_VERB_PAIRS).not.toContainEqual({ active: "Working…", complete: "Worked" });
    expect(first.active.endsWith("…")).toBe(true);
    expect(first.complete.endsWith("…")).toBe(false);
  });
  test("a turn with no tools has nothing to show", () => {
    const turn = newTurn();
    expect(turn.hasSteps).toBe(false);
    expect(turn.render()).toBe("");
  });

  test("records a friendly emoji step", () => {
    const turn = newTurn();
    expect(turn.recordTool("t1", inline("Reading", "file.ts"))).toBe(true);
    expect(turn.hasSteps).toBe(true);
    expect(turn.render()).toBe("Tinkering…\n📖 Reading file.ts");
  });

  test("dedupes a repeated tool_use_id", () => {
    const turn = newTurn();
    expect(turn.recordTool("t1", inline("Reading", "a.ts"))).toBe(true);
    expect(turn.recordTool("t1", inline("Reading", "a.ts"))).toBe(false);
    expect(turn.recordTool("t1", command("pwd"))).toBe(false);
    expect(turn.render()).toBe("Tinkering…\n📖 Reading a.ts");
  });

  test("merges consecutive identical steps with a count and preserves arrival order", () => {
    const turn = newTurn();
    turn.recordTool("a", inline("Reading", "a.ts"));
    turn.recordTool("b", inline("Reading", "a.ts"));
    turn.recordTool("c", command("pwd"));
    turn.recordTool("d", inline("Reading", "a.ts"));
    expect(turn.render()).toBe([
      "Tinkering…",
      "📖 Reading a.ts ×2",
      "💻 terminal",
      "```shell",
      "pwd",
      "```",
      "📖 Reading a.ts"
    ].join("\n"));
  });

  test("renders every step while the turn fits one Telegram message", () => {
    const turn = newTurn();
    for (let index = 0; index < 12; index += 1) {
      turn.recordTool(`t${index}`, inline("Reading", `file-${index}.ts`));
    }
    const lines = turn.render().split("\n");
    expect(lines[0]).toBe("Tinkering…");
    expect(lines).toHaveLength(13);
    expect(lines.at(-1)).toBe("📖 Reading file-11.ts");
    expect(lines.some(line => line.includes("more steps"))).toBe(false);
  });

  test("folds only when the Telegram wire limit is reached", () => {
    const turn = newTurn();
    for (let index = 0; index < 5_000; index += 1) {
      turn.recordTool(`t${index}`, inline("Working", `Step ${index} ${"x".repeat(40)}`, "⚙️"));
    }
    const rendered = turn.render();
    expect(rendered.length).toBeLessThanOrEqual(MAX_PROGRESS_CHARACTERS);
    expect(rendered.split("\n").length).toBeGreaterThan(9);
    expect(rendered.split("\n").at(-1)).toMatch(/^… \+\d+ more steps$/u);
  });

  test("marks completion without adding redundant status chrome", () => {
    const turn = newTurn();
    turn.recordTool("a", inline("Reading", "a.ts"));
    expect(turn.recordSuccess("a")).toBe(true);
    expect(turn.recordSuccess("a")).toBe(false);
    expect(turn.render()).toBe("Tinkering…\n📖 Reading a.ts");
  });

  test("marks only a failed step with a failure prefix", () => {
    const turn = newTurn();
    turn.recordTool("a", inline("Reading", "a.ts"));
    turn.recordTool("b", command("false"));
    expect(turn.recordFailure("b")).toBe(true);
    expect(turn.recordFailure("b")).toBe(false);
    expect(turn.recordFailure("unknown")).toBe(false);
    expect(turn.render()).toBe([
      "Tinkering…",
      "📖 Reading a.ts",
      "❌ 💻 terminal",
      "```shell",
      "false",
      "```"
    ].join("\n"));
  });

  test("closing switches the header and blocks further steps", () => {
    const turn = newTurn();
    turn.recordTool("a", inline("Reading", "a.ts"));
    turn.close("Stop");
    expect(turn.closed).toBe(true);
    expect(turn.render()).toBe("Tinkered\n📖 Reading a.ts");
    expect(turn.recordTool("b", command("pwd"))).toBe(false);
    expect(turn.recordFailure("a")).toBe(false);
    expect(turn.render()).toBe("Tinkered\n📖 Reading a.ts");
  });

  test("a failed stop uses its own header and marks unfinished work", () => {
    const turn = newTurn();
    turn.recordTool("a", inline("Reading", "a.ts"));
    turn.close("StopFailure");
    expect(turn.render()).toBe("Failed\n❌ 📖 Reading a.ts");
  });

  test("closing twice keeps the first outcome", () => {
    const turn = newTurn();
    turn.recordTool("a", inline("Reading", "a.ts"));
    turn.close("Stop");
    turn.close("StopFailure");
    expect(turn.render()).toBe("Tinkered\n📖 Reading a.ts");
  });

  test("the generation advances on every accepted change and only then", () => {
    const turn = newTurn();
    const start = turn.generation;
    turn.recordTool("a", inline("Reading", "a.ts"));
    const afterFirst = turn.generation;
    expect(afterFirst).toBeGreaterThan(start);
    turn.recordTool("a", inline("Reading", "a.ts"));
    expect(turn.generation).toBe(afterFirst);
    turn.recordFailure("a");
    expect(turn.generation).toBeGreaterThan(afterFirst);
  });

  test("repeated identical tools stay compact within one Telegram message", () => {
    const turn = newTurn();
    for (let index = 0; index < 5_000; index += 1) {
      turn.recordTool(`t${index}`, inline("Working", undefined, "⚙️"));
    }
    expect(turn.render().length).toBeLessThanOrEqual(MAX_PROGRESS_CHARACTERS);
  });
});
