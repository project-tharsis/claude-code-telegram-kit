import { describe, expect, test } from "bun:test";
import { evaluateMemoryReviewTrigger, loadMemoryReviewPolicy, type MemoryReviewTriggerInput } from "../src/memory-review-trigger.js";

function baseInput(overrides: Partial<MemoryReviewTriggerInput> = {}): MemoryReviewTriggerInput {
  return {
    deliveryOutcome: "delivered",
    backgroundTasksActive: false,
    hasExistingReceipt: false,
    isReviewAuthorityTurn: false,
    userCorrection: false,
    turnOrdinal: 1,
    ...overrides
  };
}

describe("memory review production policy defaults", () => {
  test("is disabled with an empty environment", () => {
    expect(loadMemoryReviewPolicy({})).toEqual({ enabled: false, cadenceTurns: 12 });
  });

  test("stays disabled unless MEMORY_REVIEW_ENABLED is exactly the string true", () => {
    expect(loadMemoryReviewPolicy({ MEMORY_REVIEW_ENABLED: "1" }).enabled).toBe(false);
    expect(loadMemoryReviewPolicy({ MEMORY_REVIEW_ENABLED: "yes" }).enabled).toBe(false);
    expect(loadMemoryReviewPolicy({ MEMORY_REVIEW_ENABLED: "true" }).enabled).toBe(true);
  });

  test("fails closed to disabled on an invalid cadence rather than falling back open", () => {
    const policy = loadMemoryReviewPolicy({ MEMORY_REVIEW_ENABLED: "true", MEMORY_REVIEW_CADENCE_TURNS: "not-a-number" });
    expect(policy.enabled).toBe(false);
  });

  test("fails closed to disabled on an out-of-range cadence", () => {
    expect(loadMemoryReviewPolicy({ MEMORY_REVIEW_ENABLED: "true", MEMORY_REVIEW_CADENCE_TURNS: "0" }).enabled).toBe(false);
    expect(loadMemoryReviewPolicy({ MEMORY_REVIEW_ENABLED: "true", MEMORY_REVIEW_CADENCE_TURNS: "10000" }).enabled).toBe(false);
  });
});

describe("verified-delivery enqueue trigger (handoff doc A1)", () => {
  const disabledPolicy = { enabled: false, cadenceTurns: 12 };
  const enabledPolicy = { enabled: true, cadenceTurns: 12 };

  test("never fires when the production policy is disabled, even with a strong correction signal", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ userCorrection: true }), disabledPolicy);
    expect(decision).toEqual({ due: false, reason: "disabled" });
  });

  test("does not trigger for a rejected, uncertain, or too-large delivery outcome", () => {
    for (const outcome of ["rejected", "uncertain", "too_large"] as const) {
      const decision = evaluateMemoryReviewTrigger(baseInput({ deliveryOutcome: outcome, userCorrection: true }), enabledPolicy);
      expect(decision).toEqual({ due: false, reason: "not_delivered" });
    }
  });

  test("does not trigger while a background task from this session is still active", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ backgroundTasksActive: true, userCorrection: true }), enabledPolicy);
    expect(decision).toEqual({ due: false, reason: "background_tasks_active" });
  });

  test("does not trigger a second time for the same (session_id, prompt_id)", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ hasExistingReceipt: true, userCorrection: true }), enabledPolicy);
    expect(decision).toEqual({ due: false, reason: "duplicate_receipt" });
  });

  test("never triggers from a control command, title worker, or Harness's own turn", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ isReviewAuthorityTurn: true, userCorrection: true }), enabledPolicy);
    expect(decision).toEqual({ due: false, reason: "review_authority_turn" });
  });

  test("fires immediately on an explicit user correction", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ userCorrection: true }), enabledPolicy);
    expect(decision).toEqual({ due: true, reason: "user_correction" });
  });

  test("fires on cadence for an ordinary turn with no correction signal", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ turnOrdinal: 12 }), enabledPolicy);
    expect(decision).toEqual({ due: true, reason: "cadence_due" });
  });

  test("does not fire between cadence marks with no correction signal", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ turnOrdinal: 11 }), enabledPolicy);
    expect(decision).toEqual({ due: false, reason: "no_signal" });
  });

  test("an ordinary, smooth, one-off turn is a no_op", () => {
    const decision = evaluateMemoryReviewTrigger(baseInput({ turnOrdinal: 1 }), enabledPolicy);
    expect(decision).toEqual({ due: false, reason: "no_signal" });
  });
});
