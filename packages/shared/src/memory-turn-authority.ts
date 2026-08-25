/** Conservative Stop authority shared by review triggering and the dormant applier. */
import type { MemoryIdleProof } from "./memory-applier.js";

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface TurnIdleAuthorityInput {
  stopHookActive: unknown;
  backgroundTasks: unknown;
  sessionCrons: unknown;
}

export function hasIdleTurnAuthority(input: TurnIdleAuthorityInput): boolean {
  return input.stopHookActive === false
    && Array.isArray(input.backgroundTasks)
    && input.backgroundTasks.length === 0
    && Array.isArray(input.sessionCrons)
    && input.sessionCrons.length === 0;
}

export function buildMemoryIdleProof(input: {
  sessionId: string;
  promptId: string;
  observedAt: number;
  stopHookActive: unknown;
  backgroundTasks: unknown;
  sessionCrons: unknown;
}): MemoryIdleProof | null {
  if (
    !SESSION_RE.test(input.sessionId) ||
    !PROMPT_RE.test(input.promptId) ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0 ||
    !hasIdleTurnAuthority(input)
  ) return null;
  return {
    schema: 1,
    session_id: input.sessionId,
    prompt_id: input.promptId,
    observed_at: input.observedAt,
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
  };
}
