import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryObserverLedger } from "@project-tharsis/claude-code-telegram-shared";
import { handleMemoryObserverPreflight } from "../src/memory-observer-command.js";

const RELEASE_SHA = "c".repeat(40);

describe("native memory startup preflight", () => {
  let root: string;
  let memory: string;
  let state: string;
  let settings: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-observer-command-"));
    memory = join(root, "memory");
    state = join(root, "state");
    settings = join(root, "settings.json");
    mkdirSync(memory, { mode: 0o755 });
    writeFileSync(join(memory, "MEMORY.md"), "# Index\n", { mode: 0o644 });
    writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: memory }), { mode: 0o600 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("is a no-op while the observer flag is disabled", () => {
    const outcome = handleMemoryObserverPreflight(
      { hook_event_name: "SessionStart", source: "startup" },
      { enabled: false, settingsPath: settings, ledgerDirectory: state, releaseSha: RELEASE_SHA }
    );
    expect(outcome).toEqual({ status: "disabled" });
    expect(readdirSync(root).sort()).toEqual(["memory", "settings.json"]);
  });

  test("ignores non-startup hook payloads even when enabled", () => {
    const outcome = handleMemoryObserverPreflight(
      { hook_event_name: "SessionStart", source: "resume" },
      { enabled: true, settingsPath: settings, ledgerDirectory: state, releaseSha: RELEASE_SHA }
    );
    expect(outcome).toEqual({ status: "ignored" });
  });

  test("discovers native memory from Claude settings and records an exact ledger readback", () => {
    const memoryBefore = readFileSync(join(memory, "MEMORY.md"));
    const outcome = handleMemoryObserverPreflight(
      { hook_event_name: "SessionStart", source: "startup" },
      { enabled: true, settingsPath: settings, ledgerDirectory: state, releaseSha: RELEASE_SHA, now: 1_000 }
    );
    expect(outcome.status).toBe("recorded");
    if (outcome.status !== "recorded") throw new Error("unreachable");
    const readback = readMemoryObserverLedger({ directory: state });
    expect(outcome.watermark).toBe(readback!.latest.inventory_sha256);
    expect(outcome.fileCount).toBe(1);
    expect(readFileSync(join(memory, "MEMORY.md"))).toEqual(memoryBefore);
  });

  test("fails closed on missing configured native memory instead of creating it", () => {
    const missing = join(root, "missing-memory");
    writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: missing }), { mode: 0o600 });
    expect(() => handleMemoryObserverPreflight(
      { hook_event_name: "SessionStart", source: "startup" },
      { enabled: true, settingsPath: settings, ledgerDirectory: state, releaseSha: RELEASE_SHA }
    )).toThrow("memory directory");
    expect(readdirSync(root).sort()).toEqual(["memory", "settings.json"]);
  });
});
