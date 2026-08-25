import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeNativeMemory } from "../src/native-memory-observer.js";
import {
  MEMORY_OBSERVER_LEDGER_RETENTION_MS,
  readMemoryObserverLedger,
  recordMemoryObservation
} from "../src/memory-observer-ledger.js";

const RELEASE_SHA = "b".repeat(40);

function writeMemory(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o644 });
}

describe("native memory observer ledger", () => {
  let root: string;
  let memory: string;
  let state: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-observer-ledger-"));
    memory = join(root, "native-memory");
    state = join(root, "state", "observer");
    mkdirSync(memory, { mode: 0o755 });
    writeMemory(join(memory, "MEMORY.md"), "# Index\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function observe(now: number) {
    return observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, now });
  }

  test("atomically persists exact readback outside the production memory root", () => {
    const ledger = recordMemoryObservation(observe(1_000), { directory: state });
    const readback = readMemoryObserverLedger({ directory: state });
    expect(readback).toEqual(ledger);
    expect(readback?.latest.directory_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readback?.latest.files[0]?.path).toBe("MEMORY.md");
    expect(readback?.events[0]?.kind).toBe("created");
    expect(readback?.events[0]?.provenance).toBe("claude_native_auto_memory");
    expect(JSON.stringify(readback)).not.toContain(memory);

    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    const ledgerPath = join(state, "ledger.json");
    expect(lstatSync(ledgerPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(ledgerPath).nlink).toBe(1);
  });

  test("records created, modified, and deleted deltas while unchanged scans create no event", () => {
    recordMemoryObservation(observe(1_000), { directory: state });
    const unchanged = recordMemoryObservation(observe(2_000), { directory: state });
    expect(unchanged.events).toHaveLength(1);

    writeMemory(join(memory, "MEMORY.md"), "# Changed\n");
    writeMemory(join(memory, "topic.md"), "topic\n");
    const changed = recordMemoryObservation(observe(3_000), { directory: state });
    expect(changed.events.slice(-2).map(event => [event.path, event.kind])).toEqual([
      ["MEMORY.md", "modified"],
      ["topic.md", "created"]
    ]);

    rmSync(join(memory, "topic.md"));
    const deleted = recordMemoryObservation(observe(4_000), { directory: state });
    expect(deleted.events.at(-1)?.kind).toBe("deleted");
    expect(deleted.events.at(-1)?.before_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(deleted.events.at(-1)?.after_sha256).toBeNull();
    expect(deleted.watermark.sequence).toBe(deleted.events.at(-1)!.sequence);
  });

  test("retains only bounded recent events with monotonic sequence across restart", () => {
    recordMemoryObservation(observe(1_000), { directory: state, maxEvents: 2, retentionMs: 10_000 });
    writeMemory(join(memory, "one.md"), "1");
    recordMemoryObservation(observe(2_000), { directory: state, maxEvents: 2, retentionMs: 10_000 });
    writeMemory(join(memory, "two.md"), "2");
    const capped = recordMemoryObservation(observe(3_000), { directory: state, maxEvents: 2, retentionMs: 10_000 });
    expect(capped.events).toHaveLength(2);
    expect(capped.events.map(event => event.sequence)).toEqual([2, 3]);

    writeMemory(join(memory, "three.md"), "3");
    const restarted = recordMemoryObservation(observe(4_000), { directory: state, maxEvents: 2, retentionMs: 10_000 });
    expect(restarted.events.at(-1)?.sequence).toBe(4);
  });

  test("prunes events older than retention without losing the current inventory", () => {
    recordMemoryObservation(observe(1_000), { directory: state });
    writeMemory(join(memory, "topic.md"), "topic\n");
    const later = 1_000 + MEMORY_OBSERVER_LEDGER_RETENTION_MS + 1;
    const ledger = recordMemoryObservation(observe(later), { directory: state });
    expect(ledger.events.every(event => event.observed_at >= later - MEMORY_OBSERVER_LEDGER_RETENTION_MS)).toBe(true);
    expect(ledger.latest.files.map(file => file.path)).toContain("MEMORY.md");
  });

  test("recovers from a corrupt ledger by rebuilding current inventory and recording the recovery", () => {
    recordMemoryObservation(observe(1_000), { directory: state });
    writeFileSync(join(state, "ledger.json"), "{broken", { mode: 0o600 });

    const recovered = recordMemoryObservation(observe(2_000), { directory: state });
    expect(recovered.recovery).toBe("corrupt_ledger_rebuilt");
    expect(recovered.latest.files.map(file => file.path)).toEqual(["MEMORY.md"]);
    expect(readMemoryObserverLedger({ directory: state })).toEqual(recovered);
  });

  test("fails closed without changing the ledger when autoMemoryDirectory moves", () => {
    writeMemory(join(memory, "MEMORY.md"), "root A\n");
    const first = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, now: 1_000 });
    const baseline = recordMemoryObservation(first, { directory: state });

    const other = join(root, "other-memory");
    mkdirSync(other, { mode: 0o755 });
    writeMemory(join(other, "MEMORY.md"), "root B\n");
    const second = observeNativeMemory({ memoryDirectory: other, releaseSha: RELEASE_SHA, now: 2_000 });
    expect(() => recordMemoryObservation(second, { directory: state })).toThrow("authority changed");
    expect(readMemoryObserverLedger({ directory: state })).toEqual(baseline);
  });

  test("serializes writers with a PID/start-time lock and recovers a dead-owner lock", () => {
    writeMemory(join(memory, "MEMORY.md"), "index\n");
    const observation = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, now: 1_000 });
    recordMemoryObservation(observation, { directory: state });
    const raw = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = fields[19]!;
    const lock = join(state, "ledger.lock");
    writeFileSync(lock, JSON.stringify({ schema: 1, pid: process.pid, start_ticks: startTicks }), { mode: 0o600 });
    expect(() => recordMemoryObservation(observation, { directory: state })).toThrow("busy");

    rmSync(lock);
    writeFileSync(lock, JSON.stringify({ schema: 1, pid: 99_999_999, start_ticks: "1" }), { mode: 0o600 });
    expect(recordMemoryObservation(observation, { directory: state }).latest.inventory_sha256).toBe(observation.watermark);
    expect(readdirSync(state)).not.toContain("ledger.lock");
  });

  test("rejects unsafe ledger leaves instead of following or overwriting them", () => {
    recordMemoryObservation(observe(1_000), { directory: state });
    chmodSync(join(state, "ledger.json"), 0o660);
    expect(() => readMemoryObserverLedger({ directory: state })).toThrow("unsafe ledger");
    expect(() => recordMemoryObservation(observe(2_000), { directory: state })).toThrow("unsafe ledger");
  });

  test("refuses any ledger directory inside the production native memory root", () => {
    const nested = join(memory, ".observer-state");
    expect(() => recordMemoryObservation(observe(1_000), { directory: nested })).toThrow("outside native memory");
    expect(() => readMemoryObserverLedger({ directory: nested, nativeMemoryDirectory: memory })).toThrow("outside native memory");
  });

  test("fails closed when the ledger exceeds its validated event cap", () => {
    recordMemoryObservation(observe(1_000), { directory: state, maxEvents: 1 });
    const bytes = readFileSync(join(state, "ledger.json"), "utf8");
    const parsed = JSON.parse(bytes) as Record<string, unknown>;
    parsed.events = Array.from({ length: 20 }, (_value, index) => ({ sequence: index + 1 }));
    writeFileSync(join(state, "ledger.json"), JSON.stringify(parsed), { mode: 0o600 });
    expect(() => readMemoryObserverLedger({ directory: state, maxEvents: 1 })).toThrow("invalid ledger");
  });
});
