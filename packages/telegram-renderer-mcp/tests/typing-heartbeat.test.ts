import { describe, expect, test } from "bun:test";
import {
  createTypingHeartbeatManager,
  DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS,
  DEFAULT_TYPING_THROTTLE_COOLDOWN_MS
} from "../src/typing-heartbeat.js";
import type { TypingOutcome } from "../src/progress-transport.js";

interface Harness {
  manager: ReturnType<typeof createTypingHeartbeatManager>;
  runs: Array<() => Promise<void>>;
  delays: number[];
  actions: string[];
  tick: () => Promise<void>;
}

function harness(
  send?: (chatId: string, signal: AbortSignal) => TypingOutcome | void | Promise<TypingOutcome | void>,
  options: { now?: () => number; maxDurationMs?: number } = {}
): Harness {
  const runs: Array<() => Promise<void>> = [];
  const delays: number[] = [];
  const actions: string[] = [];
  const manager = createTypingHeartbeatManager({
    sendChatAction: async (chatId, signal) => {
      actions.push(chatId);
      return (await send?.(chatId, signal)) ?? "sent";
    },
    schedule: (run, delayMs) => {
      delays.push(delayMs);
      runs.push(run);
      return () => {
        const index = runs.indexOf(run);
        if (index >= 0) runs.splice(index, 1);
      };
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs })
  });
  return {
    manager,
    runs,
    delays,
    actions,
    tick: async () => {
      const run = runs.shift();
      if (run) await run();
    }
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Telegram typing heartbeat manager", () => {
  test("starts immediately and refreshes every two seconds", async () => {
    const h = harness();
    const stop = h.manager.start("123");
    await settle();
    expect(h.actions).toEqual(["123"]);
    expect(h.delays).toEqual([DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS]);
    await h.tick();
    expect(h.actions).toEqual(["123", "123"]);
    stop();
    expect(h.runs).toEqual([]);
  });

  test("stopping before an in-flight send resolves prevents rescheduling", async () => {
    let release!: () => void;
    let signal!: AbortSignal;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const h = harness((_chatId, currentSignal) => {
      signal = currentSignal;
      return pending;
    });
    const stop = h.manager.start("123");
    stop();
    expect(signal.aborted).toBe(true);
    release();
    await settle();
    expect(h.runs).toEqual([]);
  });

  test("does not overlap sends when a heartbeat is in flight", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const h = harness(() => pending);
    const stop = h.manager.start("123");
    await settle();
    expect(h.actions).toEqual(["123"]);
    expect(h.runs).toEqual([]);
    release();
    await settle();
    expect(h.runs.length).toBe(1);
    stop();
  });

  test("transient failure is swallowed and the heartbeat continues", async () => {
    const h = harness(() => "transient");
    const stop = h.manager.start("123");
    await settle();
    expect(h.runs.length).toBe(1);
    await h.tick();
    expect(h.actions).toEqual(["123", "123"]);
    stop();
  });

  test("backs off on 429 and stops on permanent rejection", async () => {
    const outcomes: TypingOutcome[] = ["throttled", "rejected"];
    const h = harness(() => outcomes.shift()!);
    h.manager.start("123");
    await settle();
    expect(h.delays).toEqual([DEFAULT_TYPING_THROTTLE_COOLDOWN_MS]);
    await h.tick();
    expect(h.manager.size).toBe(0);
    expect(h.runs).toEqual([]);
  });

  test("dead-man cutoff stops a leaked heartbeat", async () => {
    let now = 0;
    const h = harness(undefined, { now: () => now, maxDurationMs: 5_000 });
    h.manager.start("123");
    await settle();
    now = 5_000;
    await h.tick();
    expect(h.manager.size).toBe(0);
    expect(h.runs).toEqual([]);
  });

  test("starting the same chat replaces its previous heartbeat", async () => {
    const h = harness();
    const firstStop = h.manager.start("123");
    await settle();
    const secondStop = h.manager.start("123");
    await settle();
    expect(h.actions).toEqual(["123", "123"]);
    firstStop();
    expect(h.runs.length).toBe(1);
    secondStop();
    expect(h.runs).toEqual([]);
  });
});
