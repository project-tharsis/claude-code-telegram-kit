#!/usr/bin/env bun
import { homedir } from "node:os";
import { assertAuthorizedChat, loadRuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import { createSessionTitleService, type EnsureTitleResult } from "./session-title-service.js";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SessionTitleWorkerOptions {
  sessionId: string;
  workspaceDir: string;
  projectSessionsDir: string;
  telegramStateDir: string;
  ensure?: () => Promise<EnsureTitleResult>;
}

export async function runSessionTitleWorker(options: SessionTitleWorkerOptions): Promise<EnsureTitleResult> {
  if (!SESSION_UUID.test(options.sessionId)) throw new Error("invalid session identity");
  let result: EnsureTitleResult;
  if (options.ensure !== undefined) {
    result = await options.ensure();
  } else {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN
        && !process.env.ANTHROPIC_API_KEY
        && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("authenticated title source is unavailable");
    }
    const telegramConfig = loadRuntimeConfig(options.telegramStateDir);
    const service = createSessionTitleService({
      projectSessionsDir: options.projectSessionsDir,
      workspaceDir: options.workspaceDir,
      isAuthorizedChat: chatId => {
        try {
          assertAuthorizedChat(telegramConfig, chatId);
          return true;
        } catch {
          return false;
        }
      }
    });
    result = await service.ensureAutoTitle(options.sessionId);
  }
  if (result === "failed") throw new Error("automatic title failed");
  return result;
}

if (import.meta.main) {
  try {
    const sessionId = process.argv[2];
    if (process.argv.length !== 3 || typeof sessionId !== "string") throw new Error("exactly one session ID is required");
    await runSessionTitleWorker({
      sessionId,
      workspaceDir: process.env.CLAUDE_WORKSPACE_DIR ?? "",
      projectSessionsDir: process.env.CLAUDE_PROJECT_SESSIONS_DIR ?? "",
      telegramStateDir: process.env.TELEGRAM_STATE_DIR ?? `${homedir()}/.claude/channels/telegram`
    });
  } catch {
    process.exitCode = 1;
  }
}
