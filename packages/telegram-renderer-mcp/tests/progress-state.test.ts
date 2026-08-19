import { describe, expect, test } from "bun:test";
import { MAX_STEP_LINES, TurnProgress } from "../src/progress-state.js";

function newTurn(): TurnProgress {
  return new TurnProgress({ chatId: "123", messageId: "9", sessionId: "s", promptId: "p" });
}

describe("turn progress state", () => {
  test("a turn with no tools has nothing to show", () => {
    const turn = newTurn();
    expect(turn.hasSteps).toBe(false);
    expect(turn.render()).toBe("");
  });

  test("records a step and renders a bounded bubble", () => {
    const turn = newTurn();
    expect(turn.recordTool("t1", "Reading files")).toBe(true);
    expect(turn.hasSteps).toBe(true);
    expect(turn.render()).toBe("Working…\n• Reading files");
  });

  test("dedupes a repeated tool_use_id", () => {
    const turn = newTurn();
    expect(turn.recordTool("t1", "Reading files")).toBe(true);
    expect(turn.recordTool("t1", "Reading files")).toBe(false);
    expect(turn.recordTool("t1", "Running commands")).toBe(false);
    expect(turn.render()).toBe("Working…\n• Reading files");
  });

  test("merges consecutive identical labels with a count and preserves arrival order", () => {
    const turn = newTurn();
    turn.recordTool("a", "Reading files");
    turn.recordTool("b", "Reading files");
    turn.recordTool("c", "Running commands");
    turn.recordTool("d", "Reading files");
    expect(turn.render()).toBe(
      "Working…\n• Reading files ×2\n• Running commands\n• Reading files"
    );
  });

  test("caps the bubble at eight lines and reports the overflow count", () => {
    const turn = newTurn();
    const labels = ["Reading files", "Running commands"] as const;
    for (let index = 0; index < 12; index += 1) {
      turn.recordTool(`t${index}`, labels[index % 2]!);
    }
    const lines = turn.render().split("\n");
    expect(lines[0]).toBe("Working…");
    expect(lines.length).toBe(1 + MAX_STEP_LINES + 1);
    expect(lines[lines.length - 1]).toBe("… +4 more steps");
    expect(lines.slice(1, -1).every(line => line.startsWith("• "))).toBe(true);
  });

  test("earlier lines stay stable once the cap is reached", () => {
    const turn = newTurn();
    for (let index = 0; index < MAX_STEP_LINES; index += 1) {
      turn.recordTool(`t${index}`, index % 2 === 0 ? "Reading files" : "Planning");
    }
    const before = turn.render().split("\n").slice(1, 1 + MAX_STEP_LINES);
    turn.recordTool("extra", "Running commands");
    const after = turn.render().split("\n").slice(1, 1 + MAX_STEP_LINES);
    expect(after).toEqual(before);
  });

  test("marks a failed step by tool_use_id only", () => {
    const turn = newTurn();
    turn.recordTool("a", "Reading files");
    turn.recordTool("b", "Running commands");
    expect(turn.recordFailure("b")).toBe(true);
    expect(turn.recordFailure("b")).toBe(false);
    expect(turn.recordFailure("unknown")).toBe(false);
    expect(turn.render()).toBe("Working…\n• Reading files\n• Running commands (failed)");
  });

  test("closing switches the header and blocks further steps", () => {
    const turn = newTurn();
    turn.recordTool("a", "Reading files");
    turn.close("Stop");
    expect(turn.closed).toBe(true);
    expect(turn.render()).toBe("Done\n• Reading files");
    expect(turn.recordTool("b", "Running commands")).toBe(false);
    expect(turn.recordFailure("a")).toBe(false);
    expect(turn.render()).toBe("Done\n• Reading files");
  });

  test("a failed stop uses its own fixed header", () => {
    const turn = newTurn();
    turn.recordTool("a", "Reading files");
    turn.close("StopFailure");
    expect(turn.render()).toBe("Failed\n• Reading files");
  });

  test("closing twice keeps the first outcome", () => {
    const turn = newTurn();
    turn.recordTool("a", "Reading files");
    turn.close("Stop");
    turn.close("StopFailure");
    expect(turn.render()).toBe("Done\n• Reading files");
  });

  test("the generation advances on every accepted change and only then", () => {
    const turn = newTurn();
    const start = turn.generation;
    turn.recordTool("a", "Reading files");
    const afterFirst = turn.generation;
    expect(afterFirst).toBeGreaterThan(start);
    turn.recordTool("a", "Reading files");
    expect(turn.generation).toBe(afterFirst);
    turn.recordFailure("a");
    expect(turn.generation).toBeGreaterThan(afterFirst);
  });

  test("the rendered bubble never exceeds a single Telegram message", () => {
    const turn = newTurn();
    for (let index = 0; index < 5_000; index += 1) turn.recordTool(`t${index}`, "Working");
    expect(turn.render().length).toBeLessThan(4_096);
  });
});
