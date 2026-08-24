/**
 * Verified-delivery enqueue seam (handoff doc section A1).
 *
 * This is a pure decision function. It never touches the filesystem, the broker, or the
 * network; a caller with the exact Stop/delivery facts asks it whether a review receipt is
 * due, then owns the singleflight write through memory-review-receipt.ts.
 *
 * Policy is fail-closed by construction: any missing or invalid config value disables
 * automatic review rather than defaulting it open, and the shipped production default is
 * disabled regardless of config presence until an operator opts in.
 */

export interface MemoryReviewPolicy {
  enabled: boolean;
  /** Every Nth complex turn is due on cadence alone, independent of a correction signal. */
  cadenceTurns: number;
}

const DEFAULT_CADENCE_TURNS = 12;
const MIN_CADENCE_TURNS = 1;
const MAX_CADENCE_TURNS = 500;

function parseBooleanFlag(value: string | undefined): boolean {
  return value === "true";
}

function parseCadence(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_CADENCE_TURNS;
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CADENCE_TURNS || parsed > MAX_CADENCE_TURNS) return null;
  return parsed;
}

/**
 * Reads MEMORY_REVIEW_ENABLED / MEMORY_REVIEW_CADENCE_TURNS from the process environment.
 * Production ships with neither set, which resolves to disabled: this is deliberate so PR1
 * can wire the full enqueue path without any automatic model call ever firing outside an
 * explicit operator opt-in.
 */
export function loadMemoryReviewPolicy(env: Record<string, string | undefined> = process.env): MemoryReviewPolicy {
  const cadence = parseCadence(env.MEMORY_REVIEW_CADENCE_TURNS);
  if (cadence === null) return { enabled: false, cadenceTurns: DEFAULT_CADENCE_TURNS };
  return { enabled: parseBooleanFlag(env.MEMORY_REVIEW_ENABLED), cadenceTurns: cadence };
}

export interface MemoryReviewTriggerInput {
  /** "delivered" is the only outcome that can ever make a receipt due. */
  deliveryOutcome: "delivered" | "rejected" | "uncertain" | "too_large";
  /** True while any background task from this session is still running. */
  backgroundTasksActive: boolean;
  /** True when a durable receipt already exists for this exact (session_id, prompt_id). */
  hasExistingReceipt: boolean;
  /** True when the hook chain itself is a control command, title worker, or Harness turn. */
  isReviewAuthorityTurn: boolean;
  /** True when the user's message reads as an explicit style/format/workflow correction. */
  userCorrection: boolean;
  /** 1-based ordinal of this turn's complexity for cadence purposes (e.g. tool iterations bucket). */
  turnOrdinal: number;
}

export type MemoryReviewTriggerReason =
  | "disabled"
  | "not_delivered"
  | "background_tasks_active"
  | "duplicate_receipt"
  | "review_authority_turn"
  | "user_correction"
  | "cadence_due"
  | "no_signal";

export interface MemoryReviewTriggerDecision {
  due: boolean;
  reason: MemoryReviewTriggerReason;
}

export function evaluateMemoryReviewTrigger(
  input: MemoryReviewTriggerInput,
  policy: MemoryReviewPolicy
): MemoryReviewTriggerDecision {
  if (!policy.enabled) return { due: false, reason: "disabled" };
  if (input.isReviewAuthorityTurn) return { due: false, reason: "review_authority_turn" };
  if (input.deliveryOutcome !== "delivered") return { due: false, reason: "not_delivered" };
  if (input.backgroundTasksActive) return { due: false, reason: "background_tasks_active" };
  if (input.hasExistingReceipt) return { due: false, reason: "duplicate_receipt" };
  if (input.userCorrection) return { due: true, reason: "user_correction" };
  if (Number.isSafeInteger(input.turnOrdinal) && input.turnOrdinal > 0 && input.turnOrdinal % policy.cadenceTurns === 0) {
    return { due: true, reason: "cadence_due" };
  }
  return { due: false, reason: "no_signal" };
}
