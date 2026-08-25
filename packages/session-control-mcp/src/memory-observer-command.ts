#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  observeNativeMemory,
  recordMemoryObservation,
  resolveConfiguredAutoMemoryDirectory
} from "@project-tharsis/claude-code-telegram-shared";

const MAX_STDIN_BYTES = 64 * 1024;

interface SessionStartPayload {
  hook_event_name?: unknown;
  source?: unknown;
}

export interface MemoryObserverPreflightOptions {
  enabled?: boolean;
  settingsPath?: string;
  ledgerDirectory?: string;
  releaseSha?: string;
  expectedUid?: number;
  now?: number;
}

export type MemoryObserverPreflightOutcome =
  | { status: "disabled" }
  | { status: "ignored" }
  | { status: "recorded"; watermark: string; fileCount: number };

function environmentEnabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env.MEMORY_OBSERVER_ENABLED ?? "");
}

/**
 * SessionStart preflight for the read-only observer. Failure is intentionally surfaced to the
 * caller: later review/apply stages must treat a missing fresh ledger as disabled, never infer a
 * native memory path or create one. The CLI wrapper catches the error only to avoid blocking the
 * primary Claude session; it still leaves no ready ledger behind.
 */
export function handleMemoryObserverPreflight(
  payload: SessionStartPayload,
  options: MemoryObserverPreflightOptions = {}
): MemoryObserverPreflightOutcome {
  const enabled = options.enabled ?? environmentEnabled();
  if (!enabled) return { status: "disabled" };
  if (payload.hook_event_name !== "SessionStart" || payload.source !== "startup") {
    return { status: "ignored" };
  }
  const settingsPath = options.settingsPath ?? process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
  const releaseSha = options.releaseSha ?? process.env.CLAUDE_RUNTIME_RELEASE_SHA ?? "";
  const memoryDirectory = resolveConfiguredAutoMemoryDirectory({
    settingsPath,
    ...(options.expectedUid === undefined ? {} : { expectedUid: options.expectedUid })
  });
  const observation = observeNativeMemory({
    memoryDirectory,
    releaseSha,
    ...(options.expectedUid === undefined ? {} : { expectedUid: options.expectedUid }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const ledger = recordMemoryObservation(observation, {
    ...(options.ledgerDirectory === undefined ? {} : { directory: options.ledgerDirectory }),
    ...(options.expectedUid === undefined ? {} : { expectedUid: options.expectedUid })
  });
  return {
    status: "recorded",
    watermark: ledger.latest.inventory_sha256,
    fileCount: ledger.latest.files.length
  };
}

function main(): void {
  try {
    const raw = readFileSync(0);
    if (raw.byteLength === 0 || raw.byteLength > MAX_STDIN_BYTES) return;
    const payload = JSON.parse(raw.toString("utf8")) as SessionStartPayload;
    handleMemoryObserverPreflight(payload);
  } catch {
    // Startup observation is advisory to the primary Claude session. A failed preflight leaves no
    // fresh ready ledger, so the Memory Harness remains fail-closed without blocking startup.
    console.error("native memory observer preflight failed");
  }
}

if (import.meta.main) main();
