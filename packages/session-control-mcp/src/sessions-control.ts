import { z } from "zod";
import {
  assertAuthorizedChat,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import { MAX_SESSION_INDEX } from "./control-input.js";
import { formatActivity, type SessionCatalogEntry } from "./session-catalog.js";
import { escapeTelegramHtml } from "./telegram-html.js";
import {
  resolveSelection,
  type SelectionEntry,
  type SelectionSnapshot
} from "./session-selection.js";

export const NO_SESSIONS_TEXT = "<b>Recent sessions</b>\n<i>No other resumable sessions.</i>";
export const RESUME_SCHEDULER_FAILED_TEXT =
  "<b>Resume failed</b>\n<i>No session switch was started.</i>";

const telegramChatId = z.string().regex(/^-?\d+$/);
const trustedMessageId = z.string().regex(/^\d+$/);
const trustedSessionId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "invalid current session UUID"
);

export const TrustedListSessionsRequestSchema = z.object({
  chatId: telegramChatId,
  messageId: trustedMessageId,
  currentSessionId: trustedSessionId
}).strict();

export const TrustedResumeSessionRequestSchema = z.object({
  chatId: telegramChatId,
  messageId: trustedMessageId,
  currentSessionId: trustedSessionId,
  index: z.number().int().min(1).max(MAX_SESSION_INDEX)
}).strict();

export type TrustedListSessionsRequest = z.infer<typeof TrustedListSessionsRequestSchema>;
export type TrustedResumeSessionRequest = z.infer<typeof TrustedResumeSessionRequestSchema>;


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
    replyTo?: string,
    parseMode?: "HTML"
  ) => Promise<number>;
  react: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    state: "success" | "failure"
  ) => Promise<boolean>;
  scheduleResume: (
    chatId: string,
    messageId: string,
    currentSessionId: string,
    sessionId: string
  ) => Promise<string>;
  helperReady: () => Promise<boolean>;
  now: () => number;
}

function renderList(entries: readonly SessionCatalogEntry[], nowMs: number): string {
  const lines = entries.map(
    (entry, offset) => `<b>${offset + 1}.</b> ${escapeTelegramHtml(entry.title)} `
      + `<i>· ${escapeTelegramHtml(formatActivity(entry.lastActivityMs, nowMs))}</i>`
  );
  return `<b>Recent sessions</b>\n<i>${entries.length} available</i> · use <code>/resume N</code>\n\n${lines.join("\n")}`;
}

export function createSessionsController(deps: SessionsControllerDeps) {
  function authorize(chatId: string): RuntimeConfig {
    const config = deps.loadConfig();
    assertAuthorizedChat(config, chatId);
    return config;
  }

  async function listSessionsTrusted(rawRequest: TrustedListSessionsRequest): Promise<ListSessionsReceipt> {
    const request = TrustedListSessionsRequestSchema.parse(rawRequest);
    const config = authorize(request.chatId);

    // The listing session is excluded here, so it can never be offered as a resume target.
    const entries = deps.scanSessions(request.currentSessionId);

    const text = entries.length === 0 ? NO_SESSIONS_TEXT : renderList(entries, deps.now());
    let ackMessageId: number;
    try {
      ackMessageId = await deps.sendMessage(config, request.chatId, text, request.messageId, "HTML");
    } catch {
      throw new Error("session list delivery failed");
    }
    if (entries.length > 0) {
      // Activate the mapping only after the list is visible. A failed replacement request must
      // never silently repoint an older list the user can still see.
      deps.writeSnapshot({
        chatId: request.chatId,
        sessionId: request.currentSessionId,
        entries: entries.map((entry, offset) => ({ index: offset + 1, sessionId: entry.sessionId }))
      });
    }
    try {
      await deps.react(config, request.chatId, request.messageId, "success");
    } catch {
      // Reaction UX is best-effort and never changes a confirmed list delivery.
    }
    return { status: "listed", count: entries.length, ackMessageId };
  }

  async function resumeSessionTrusted(rawRequest: TrustedResumeSessionRequest): Promise<ResumeSessionReceipt> {
    const request = TrustedResumeSessionRequestSchema.parse(rawRequest);
    if (!await deps.helperReady()) throw new Error("session resume is unavailable on this host");
    const config = authorize(request.chatId);

    const snapshot = deps.readSnapshot(request.chatId);
    if (snapshot === null) throw new Error("session selection expired; send /resume again");
    if (snapshot.chatId !== request.chatId) throw new Error("session selection does not match this chat");

    // The UUID comes from the user-private snapshot and from nowhere else.
    const sessionId = resolveSelection(snapshot, request.index);
    if (sessionId === null) throw new Error("session selection expired; send /resume again");
    if (sessionId === request.currentSessionId || sessionId === snapshot.sessionId) {
      throw new Error("cannot resume the current session");
    }
    deps.verifySelectedSession(sessionId);

    let ackMessageId: number;
    try {
      ackMessageId = await deps.sendMessage(
        config,
        request.chatId,
        `<b>Resuming session ${request.index}</b>\n<i>Switching now…</i>`,
        request.messageId,
        "HTML"
      );
    } catch {
      throw new Error("ACK delivery failed; resume was not scheduled");
    }
    try {
      await deps.react(config, request.chatId, request.messageId, "success");
    } catch {
      // Reaction UX is best-effort and never blocks a confirmed resume ACK.
    }

    let unit: string;
    try {
      unit = await deps.scheduleResume(
        request.chatId,
        request.messageId,
        request.currentSessionId,
        sessionId
      );
    } catch {
      try {
        await deps.sendMessage(config, request.chatId, RESUME_SCHEDULER_FAILED_TEXT, undefined, "HTML");
      } catch {
        // The primary failure is scheduler rejection; notification is best-effort.
      }
      try {
        // The ACK already marked the command with 👍; a rejection that never started the
        // resume must not leave the triggering message looking successful.
        await deps.react(config, request.chatId, request.messageId, "failure");
      } catch {
        // Reaction UX is best-effort and never changes the reported failure.
      }
      throw new Error("resume scheduler failed");
    }

    return { status: "scheduled", ackMessageId, unit };
  }

  return { listSessionsTrusted, resumeSessionTrusted };
}
