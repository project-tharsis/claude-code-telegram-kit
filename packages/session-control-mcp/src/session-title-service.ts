import {
  readSessionTitleContext,
  type SessionTitleContext as TranscriptTitleContext
} from "./session-catalog.js";
import {
  claimAutoTitle,
  completeAutoTitle,
  defaultSessionTitleStateDirectory,
  failAutoTitle,
  lockUserTitle,
  readSessionTitleState,
  withSessionTitleLock
} from "./session-title-state.js";
import {
  generateSessionTitle,
  type SessionTitleContext as GeneratorTitleContext
} from "./session-title-generator.js";
import { renameSessionWithClaude } from "./session-title-rename.js";

export type EnsureTitleResult = "applied" | "existing" | "no_context" | "already_attempted" | "failed";

export interface SessionTitleServiceOptions {
  projectSessionsDir: string;
  workspaceDir: string;
  stateDirectory?: string;
  isAuthorizedChat?: (chatId: string) => boolean;
  readContext?: (sessionId: string) => TranscriptTitleContext;
  generate?: (context: GeneratorTitleContext) => Promise<string>;
  rename?: (sessionId: string, title: string, workspaceDir: string) => Promise<void>;
}

function normalizeManualTitle(raw: string): string {
  if (typeof raw !== "string") throw new Error("invalid session title");
  const title = raw.replace(/\s+/gu, " ").trim();
  const chars = Array.from(title);
  if (chars.length < 1 || chars.length > 60) throw new Error("invalid session title");
  if (chars.some(character => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) throw new Error("invalid session title");
  return title;
}

export function createSessionTitleService(options: SessionTitleServiceOptions) {
  const stateDirectory = options.stateDirectory ?? defaultSessionTitleStateDirectory();
  const readContext = options.readContext ?? (sessionId => readSessionTitleContext({
    directory: options.projectSessionsDir,
    sessionId
  }));
  const generate = options.generate ?? (context => generateSessionTitle(context, {
    claudePath: process.env.CLAUDE_TITLE_CLI ?? "claude"
  }));
  const rename = options.rename ?? (async (sessionId, title, workspaceDir) => {
    await renameSessionWithClaude(sessionId, title, {
      workspaceDir,
      claudePath: process.env.CLAUDE_TITLE_CLI ?? "claude"
    });
  });
  const stateOptions = (sessionId: string) => ({ directory: stateDirectory, sessionId });
  const isAuthorizedChat = options.isAuthorizedChat ?? (() => false);

  async function ensureAutoTitle(
    sessionId: string,
    override: { assistantText?: string } = {}
  ): Promise<EnsureTitleResult> {
    try {
      return await withSessionTitleLock(stateOptions(sessionId), async () => {
      const state = readSessionTitleState(stateOptions(sessionId));
      if (state !== null) return "already_attempted";

      const before = readContext(sessionId);
      const assistantText = override.assistantText?.trim() || before.assistantText;
      if (before.chatId === null || !isAuthorizedChat(before.chatId)) return "no_context";

      if (before.customTitle !== null) {
        lockUserTitle({ ...stateOptions(sessionId), title: before.customTitle });
        return "existing";
      }
      if (before.aiTitle !== null) {
        lockUserTitle({ ...stateOptions(sessionId), title: before.aiTitle });
        return "existing";
      }
      if (before.userPrompt === null || (!assistantText && before.toolNames.length === 0)) {
        return "no_context";
      }
      if (!claimAutoTitle(stateOptions(sessionId))) return "already_attempted";

      try {
        const title = await generate({
          userPrompt: before.userPrompt,
          assistantText,
          toolNames: before.toolNames
        });
        const preApply = readContext(sessionId);
        if (preApply.customTitle !== null) {
          lockUserTitle({ ...stateOptions(sessionId), title: preApply.customTitle });
          return "existing";
        }
        if (preApply.aiTitle !== null) {
          failAutoTitle(stateOptions(sessionId));
          return "existing";
        }

        await rename(sessionId, title, options.workspaceDir);
        const readback = readContext(sessionId);
        if (readback.customTitle !== title) throw new Error("session title readback failed");
        if (!completeAutoTitle({ ...stateOptions(sessionId), title })) {
          throw new Error("session title state transition failed");
        }
        return "applied";
      } catch {
        failAutoTitle(stateOptions(sessionId));
        return "failed";
      }
      }, 30_000);
    } catch {
      return "failed";
    }
  }

  async function renameUserSession(sessionId: string, rawTitle: string): Promise<string> {
    const title = normalizeManualTitle(rawTitle);
    return withSessionTitleLock(stateOptions(sessionId), async () => {
      await rename(sessionId, title, options.workspaceDir);
      const readback = readContext(sessionId);
      if (readback.customTitle !== title) throw new Error("session rename failed");
      try {
        lockUserTitle({ ...stateOptions(sessionId), title });
      } catch {
        // The official CLI mutation already succeeded; a later ensure observes customTitle and locks it again.
      }
      return title;
    }, 30_000);
  }

  return { ensureAutoTitle, renameUserSession };
}
