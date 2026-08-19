import { z } from "zod";
import {
  assertAuthorizedChat,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import { MAX_SESSION_INDEX, type CommandCapability, type SessionCommandName } from "./command-capability.js";
import { formatActivity, type SessionCatalogEntry } from "./session-catalog.js";
import {
  resolveSelection,
  type SelectionEntry,
  type SelectionSnapshot
} from "./session-selection.js";

export const NO_SESSIONS_TEXT = "No other resumable sessions were found.";
export const RESUME_SCHEDULER_FAILED_TEXT =
  "Session resume scheduling failed. No resume was started.";

const telegramChatId = z.string().regex(/^-?\d+$/);

export const ListSessionsRequestSchema = z.object({
  chat_id: telegramChatId
}).strict();

export const ResumeSessionRequestSchema = z.object({
  chat_id: telegramChatId,
  index: z.number().int().min(1).max(MAX_SESSION_INDEX)
}).strict();

export type ListSessionsRequest = z.infer<typeof ListSessionsRequestSchema>;
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

export interface ListSessionsReceipt {
  status: "listed";
  count: number;
  ackMessageId: number;
}

export interface ResumeSessionReceipt {
  status: "scheduled";
  ackMessageId: number;
  unit: string;
}

export interface SessionsControllerDeps {
  loadConfig: () => RuntimeConfig;
  capabilities: {
    take: (chatId: string, command: SessionCommandName, index?: number) => CommandCapability | null;
  };
  scanSessions: (currentSessionId: string) => SessionCatalogEntry[];
  readSnapshot: (chatId: string) => SelectionSnapshot | null;
  writeSnapshot: (snapshot: {
    chatId: string;
    sessionId: string;
    entries: SelectionEntry[];
  }) => void;
  /** Re-checks the selected transcript's path, owner, and file type at resume time. */
  verifySelectedSession: (sessionId: string) => void;
  sendMessage: (
    config: RuntimeConfig,
    chatId: string,
    text: string,
    replyTo?: string
  ) => Promise<number>;
  react: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    state: "success" | "failure"
  ) => Promise<boolean>;
  scheduleResume: (chatId: string, messageId: string, sessionId: string) => Promise<string>;
  helperReady: () => boolean;
  now: () => number;
}

function renderList(entries: readonly SessionCatalogEntry[], nowMs: number): string {
  const lines = entries.map(
    (entry, offset) => `${offset + 1}. ${entry.title} — ${formatActivity(entry.lastActivityMs, nowMs)}`
  );
  return `Recent sessions (${entries.length}). Reply /resume N to continue one.\n\n${lines.join("\n")}`;
}

export function createSessionsController(deps: SessionsControllerDeps) {
  function authorize(chatId: string): RuntimeConfig {
    const config = deps.loadConfig();
    assertAuthorizedChat(config, chatId);
    return config;
  }

  return {
    async listSessions(rawRequest: ListSessionsRequest): Promise<ListSessionsReceipt> {
      const request = ListSessionsRequestSchema.parse(rawRequest);
      const capability = deps.capabilities.take(request.chat_id, "sessions");
      if (capability === null) throw new Error("no current /sessions command is authorized");
      const config = authorize(capability.chatId);

      // The listing session is excluded here, so it can never be offered as a resume target.
      const entries = deps.scanSessions(capability.sessionId);

      const text = entries.length === 0 ? NO_SESSIONS_TEXT : renderList(entries, deps.now());
      let ackMessageId: number;
      try {
        ackMessageId = await deps.sendMessage(config, capability.chatId, text, capability.messageId);
      } catch {
        throw new Error("session list delivery failed");
      }
      if (entries.length > 0) {
        // Activate the mapping only after the list is visible. A failed replacement request must
        // never silently repoint an older list the user can still see.
        deps.writeSnapshot({
          chatId: capability.chatId,
          sessionId: capability.sessionId,
          entries: entries.map((entry, offset) => ({ index: offset + 1, sessionId: entry.sessionId }))
        });
      }
      try {
        await deps.react(config, capability.chatId, capability.messageId, "success");
      } catch {
        // Reaction UX is best-effort and never changes a confirmed list delivery.
      }
      return { status: "listed", count: entries.length, ackMessageId };
    },

    async resumeSession(rawRequest: ResumeSessionRequest): Promise<ResumeSessionReceipt> {
      const request = ResumeSessionRequestSchema.parse(rawRequest);
      const capability = deps.capabilities.take(request.chat_id, "resume", request.index);
      if (capability === null) throw new Error("no current /resume N command is authorized");
      if (!deps.helperReady()) throw new Error("session resume is unavailable on this host");
      const config = authorize(capability.chatId);

      const snapshot = deps.readSnapshot(capability.chatId);
      if (snapshot === null) throw new Error("session selection expired; send /sessions again");
      if (snapshot.chatId !== capability.chatId) throw new Error("session selection does not match this chat");

      // The UUID comes from the user-private snapshot and from nowhere else.
      const sessionId = resolveSelection(snapshot, request.index);
      if (sessionId === null) throw new Error("session selection expired; send /sessions again");
      if (sessionId === capability.sessionId || sessionId === snapshot.sessionId) {
        throw new Error("cannot resume the current session");
      }
      deps.verifySelectedSession(sessionId);

      let ackMessageId: number;
      try {
        ackMessageId = await deps.sendMessage(
          config,
          capability.chatId,
          `Resuming session ${request.index}. Switching now…`,
          capability.messageId
        );
      } catch {
        throw new Error("ACK delivery failed; resume was not scheduled");
      }
      try {
        await deps.react(config, capability.chatId, capability.messageId, "success");
      } catch {
        // Reaction UX is best-effort and never blocks a confirmed resume ACK.
      }

      let unit: string;
      try {
        unit = await deps.scheduleResume(capability.chatId, capability.messageId, sessionId);
      } catch {
        try {
          await deps.sendMessage(config, capability.chatId, RESUME_SCHEDULER_FAILED_TEXT);
        } catch {
          // The primary failure is scheduler rejection; notification is best-effort.
        }
        try {
          // The ACK already marked the command with 👍; a rejection that never started the
          // resume must not leave the triggering message looking successful.
          await deps.react(config, capability.chatId, capability.messageId, "failure");
        } catch {
          // Reaction UX is best-effort and never changes the reported failure.
        }
        throw new Error("resume scheduler failed");
      }

      return { status: "scheduled", ackMessageId, unit };
    }
  };
}
