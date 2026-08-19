import type { TypingOutcome } from "./progress-transport.js";

export const DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS = 2_000;
export const DEFAULT_TYPING_THROTTLE_COOLDOWN_MS = 10_000;
export const DEFAULT_TYPING_MAX_DURATION_MS = 10 * 60_000;

export type CancelTypingHeartbeat = () => void;
export type ScheduleTypingHeartbeat = (
  run: () => Promise<void>,
  delayMs: number
) => CancelTypingHeartbeat;

export interface TypingHeartbeatManagerDeps {
  sendChatAction: (chatId: string, signal: AbortSignal) => Promise<TypingOutcome>;
  schedule?: ScheduleTypingHeartbeat;
  intervalMs?: number;
  throttleCooldownMs?: number;
  maxDurationMs?: number;
  now?: () => number;
}

interface Heartbeat {
  cancel: CancelTypingHeartbeat | null;
  abort: AbortController | null;
  stopped: boolean;
  startedAt: number;
}

function defaultSchedule(run: () => Promise<void>, delayMs: number): CancelTypingHeartbeat {
  const timer = setTimeout(() => { void run(); }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function createTypingHeartbeatManager(deps: TypingHeartbeatManagerDeps) {
  const schedule = deps.schedule ?? defaultSchedule;
  const intervalMs = deps.intervalMs ?? DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS;
  const throttleCooldownMs = deps.throttleCooldownMs ?? DEFAULT_TYPING_THROTTLE_COOLDOWN_MS;
  const maxDurationMs = deps.maxDurationMs ?? DEFAULT_TYPING_MAX_DURATION_MS;
  const now = deps.now ?? Date.now;
  const heartbeats = new Map<string, Heartbeat>();

  function stopHeartbeat(chatId: string, heartbeat: Heartbeat): void {
    heartbeat.stopped = true;
    heartbeat.cancel?.();
    heartbeat.cancel = null;
    heartbeat.abort?.abort();
    heartbeat.abort = null;
    if (heartbeats.get(chatId) === heartbeat) heartbeats.delete(chatId);
  }

  function scheduleNext(chatId: string, heartbeat: Heartbeat, delayMs: number): void {
    if (heartbeat.stopped || heartbeats.get(chatId) !== heartbeat) return;
    if (now() - heartbeat.startedAt >= maxDurationMs) {
      stopHeartbeat(chatId, heartbeat);
      return;
    }
    try {
      heartbeat.cancel = schedule(async () => {
        heartbeat.cancel = null;
        await beat(chatId, heartbeat);
      }, delayMs);
    } catch {
      heartbeat.cancel = null;
    }
  }

  async function beat(chatId: string, heartbeat: Heartbeat): Promise<void> {
    if (heartbeat.stopped || heartbeats.get(chatId) !== heartbeat) return;
    let outcome: TypingOutcome = "transient";
    const abort = new AbortController();
    heartbeat.abort = abort;
    try {
      outcome = await deps.sendChatAction(chatId, abort.signal);
    } catch {
      // Presentation-only; transient retry below.
    } finally {
      if (heartbeat.abort === abort) heartbeat.abort = null;
    }
    if (heartbeat.stopped || heartbeats.get(chatId) !== heartbeat) return;
    if (outcome === "rejected") {
      stopHeartbeat(chatId, heartbeat);
      return;
    }
    scheduleNext(chatId, heartbeat, outcome === "throttled" ? throttleCooldownMs : intervalMs);
  }

  function start(chatId: string): CancelTypingHeartbeat {
    const previous = heartbeats.get(chatId);
    if (previous !== undefined) stopHeartbeat(chatId, previous);
    const heartbeat: Heartbeat = { cancel: null, abort: null, stopped: false, startedAt: now() };
    heartbeats.set(chatId, heartbeat);
    void beat(chatId, heartbeat);
    return () => stopHeartbeat(chatId, heartbeat);
  }

  return {
    start,
    stop(chatId: string): void {
      const heartbeat = heartbeats.get(chatId);
      if (heartbeat !== undefined) stopHeartbeat(chatId, heartbeat);
    },
    stopAll(): void {
      for (const [chatId, heartbeat] of heartbeats) stopHeartbeat(chatId, heartbeat);
    },
    get size(): number { return heartbeats.size; }
  };
}

export type TypingHeartbeatManager = ReturnType<typeof createTypingHeartbeatManager>;
export const createTypingHeartbeat = createTypingHeartbeatManager;
