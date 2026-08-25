#!/usr/bin/env bun
import { readFileSync, writeSync } from "node:fs";
import {
  claimLearningDelta,
  formatLearningDeltaContext,
  parseDirectTelegramEnvelope,
  type LearningDelta,
} from "@project-tharsis/claude-code-telegram-shared";
import { parseControlCommand } from "./control-command.js";

const MAX_STDIN_BYTES = 256 * 1024;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_RE = /^[0-9a-f]{40}$/;

interface PromptPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  prompt?: unknown;
}

export interface LearningDeltaCommandOptions {
  enabled?: boolean;
  releaseSha?: string;
  directory?: string;
  now?: number;
}

export interface PreparedLearningDelta {
  output: string;
  delta: LearningDelta;
  acknowledge: () => boolean;
  release: () => void;
}

export function prepareLearningDeltaForPrompt(
  payload: PromptPayload,
  options: LearningDeltaCommandOptions = {},
): PreparedLearningDelta | null {
  if (payload.hook_event_name !== "UserPromptSubmit") return null;
  const enabled = options.enabled ?? process.env.MEMORY_LEARNING_DELTA_ENABLED === "true";
  if (!enabled || typeof payload.session_id !== "string" || !SESSION_RE.test(payload.session_id)) return null;
  if (typeof payload.prompt !== "string") return null;
  const envelope = parseDirectTelegramEnvelope(payload.prompt);
  if (envelope === null || parseControlCommand(envelope.body).kind !== "other") return null;
  const releaseSha = options.releaseSha ?? process.env.CLAUDE_RUNTIME_RELEASE_SHA ?? "";
  if (!RELEASE_RE.test(releaseSha)) return null;
  const claim = claimLearningDelta({
    sessionId: payload.session_id,
    releaseSha,
    isDirectTelegram: true,
  }, {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    now: () => options.now ?? Date.now(),
  });
  if (claim === null) return null;
  return {
    delta: claim.delta,
    acknowledge: claim.acknowledge,
    release: claim.release,
    output: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: formatLearningDeltaContext(claim.delta),
      },
    }),
  };
}

function main(): void {
  let prepared: PreparedLearningDelta | null = null;
  try {
    const raw = readFileSync(0);
    if (raw.byteLength === 0 || raw.byteLength > MAX_STDIN_BYTES) return;
    prepared = prepareLearningDeltaForPrompt(JSON.parse(raw.toString("utf8")) as PromptPayload);
    if (prepared === null) return;
    const bytes = Buffer.from(prepared.output);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(1, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("short learning delta hook write");
      offset += written;
    }
    prepared.acknowledge();
  } catch {
    // Advisory context must never block the prompt. Unacknowledged output remains pending.
  } finally {
    prepared?.release();
  }
}

if (import.meta.main) main();
