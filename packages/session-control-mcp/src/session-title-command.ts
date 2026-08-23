#!/usr/bin/env bun
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { parseDirectTelegramEnvelope } from "@project-tharsis/claude-code-telegram-shared";
import { parseControlCommand } from "./control-command.js";
import {
  isRetryableTitleFailure,
  readSessionTitleState,
  type SessionTitleState
} from "./session-title-state.js";
import { createSessionScheduler } from "./runtime.js";

const MAX_STDIN_BYTES = 256 * 1024;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
  prompt?: unknown;
  last_assistant_message?: unknown;
}

export function shouldEnsureSessionTitle(payload: HookPayload): boolean {
  if (payload.hook_event_name === "Stop") return true;
  if (payload.hook_event_name !== "UserPromptSubmit" || typeof payload.prompt !== "string") return false;
  const envelope = parseDirectTelegramEnvelope(payload.prompt);
  if (envelope === null) return false;
  const command = parseControlCommand(envelope.body);
  return command.kind === "sessions" || command.kind === "reset" || command.kind === "reset-confirm";
}

function canonicalDirectory(path: string | undefined, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`invalid ${label}`);
  const resolved = resolve(path);
  const info = lstatSync(resolved);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(resolved) !== resolved ||
      (expectedUid !== undefined && info.uid !== expectedUid) || (info.mode & 0o002) !== 0) {
    throw new Error(`invalid ${label}`);
  }
  return resolved;
}

function resolveAuthority(payload: HookPayload, roots: {
  workspaceDir: string | undefined;
  projectSessionsDir: string | undefined;
}): {
  sessionId: string;
  workspaceDir: string;
  projectSessionsDir: string;
  assistantText?: string;
} {
  if (typeof payload.session_id !== "string" || !SESSION_UUID.test(payload.session_id)) {
    throw new Error("invalid session identity");
  }
  const workspaceDir = canonicalDirectory(roots.workspaceDir, "configured workspace");
  const projectSessionsDir = canonicalDirectory(roots.projectSessionsDir, "configured sessions directory");
  // Claude Code reports the active tool working directory here; it can legitimately change during a turn.
  // The configured workspace and exact transcript path are the title authority, not payload.cwd.
  if (typeof payload.transcript_path !== "string" || !isAbsolute(payload.transcript_path)) {
    throw new Error("invalid transcript authority");
  }
  const transcript = resolve(payload.transcript_path);
  if (parse(transcript).base !== `${payload.session_id}.jsonl`) throw new Error("transcript identity mismatch");
  if (dirname(transcript) !== projectSessionsDir) throw new Error("transcript authority mismatch");
  const assistantText = payload.hook_event_name === "Stop" && typeof payload.last_assistant_message === "string"
    ? Array.from(payload.last_assistant_message).slice(0, 2_000).join("")
    : undefined;
  return {
    sessionId: payload.session_id,
    workspaceDir,
    projectSessionsDir,
    ...(assistantText === undefined ? {} : { assistantText })
  };
}

export interface SessionTitleCommandOptions {
  ensure?: (authority: { sessionId: string; workspaceDir: string; projectSessionsDir: string; assistantText?: string }) => Promise<unknown>;
  schedule?: (sessionId: string) => Promise<unknown>;
  readState?: (sessionId: string) => SessionTitleState | null;
  now?: () => number;
  workspaceDir?: string;
  projectSessionsDir?: string;
}

export async function handleSessionTitleCommand(
  payload: HookPayload,
  options: SessionTitleCommandOptions = {}
): Promise<void> {
  if (!shouldEnsureSessionTitle(payload)) return;
  const authority = resolveAuthority(payload, {
    workspaceDir: options.workspaceDir ?? process.env.CLAUDE_WORKSPACE_DIR,
    projectSessionsDir: options.projectSessionsDir ?? process.env.CLAUDE_PROJECT_SESSIONS_DIR
  });
  if (options.ensure === undefined || options.readState !== undefined) {
    const state = (options.readState ?? (sessionId => readSessionTitleState({ sessionId })))(authority.sessionId);
    if (state !== null) {
      if (state.status !== "failed") return;
      if (state.attempts !== 1
          || state.phase === undefined
          || state.reason === undefined
          || state.retryAt === undefined
          || !isRetryableTitleFailure(state.phase, state.reason)
          || state.retryAt > (options.now ?? Date.now)()) return;
    }
  }
  if (options.ensure !== undefined) {
    await options.ensure(authority);
    return;
  }
  await (options.schedule ?? (sessionId => createSessionScheduler().scheduleTitle(sessionId)))(authority.sessionId);
}

async function main(): Promise<void> {
  try {
    const raw = readFileSync(0);
    if (raw.byteLength === 0 || raw.byteLength > MAX_STDIN_BYTES) return;
    const payload = JSON.parse(raw.toString("utf8")) as HookPayload;
    await handleSessionTitleCommand(payload);
  } catch {
    // Automatic naming is display-only and never blocks a Claude hook.
  }
}

if (import.meta.main) await main();
