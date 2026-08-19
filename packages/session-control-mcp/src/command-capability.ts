import { z } from "zod";
import {
  assertAuthorizedChat,
  parseDirectTelegramEnvelope,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

/**
 * Authority for a session-control action comes from the current turn's hook capability, never
 * from what the model relays. The model may say "the user asked for /resume 3"; only a
 * capability bound by the UserPromptSubmit hook from an exact, direct, allowlisted Telegram
 * command makes that actionable, and only once.
 */

/** Long enough for one turn of tool relaying, far too short to survive into a later turn. */
export const CAPABILITY_TTL_MS = 120_000;
export const MAX_SESSION_INDEX = 10;

export type SessionCommandName = "sessions" | "resume";

export type SessionCommand =
  | { command: "sessions" }
  | { command: "resume"; index: number };

const SESSIONS_PATTERN = /^\/sessions(?:@[A-Za-z0-9_]{1,32})?$/;
const RESUME_PATTERN = /^\/resume(?:@[A-Za-z0-9_]{1,32})? ([1-9]|10)$/;

/** Accepts the two exact commands and nothing else: no prose, no arguments, no UUIDs. */
export function parseSessionCommand(body: string): SessionCommand | null {
  if (typeof body !== "string" || body.length > 64) return null;
  const text = body.trim();
  if (SESSIONS_PATTERN.test(text)) return { command: "sessions" };
  const resume = RESUME_PATTERN.exec(text);
  if (resume === null) return null;
  const index = Number(resume[1]);
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_SESSION_INDEX) return null;
  return { command: "resume", index };
}

const uuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "invalid session UUID"
);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid identifier");

export const BindCommandInputSchema = z.object({
  session_id: uuid,
  prompt_id: identifier,
  /** Parsed for an exact command and then discarded. Never stored, never logged. */
  prompt: z.string().max(1_000_000),
  hook_event_name: z.literal("UserPromptSubmit")
}).strict();

export type BindCommandInput = z.infer<typeof BindCommandInputSchema>;

export interface CommandCapability {
  chatId: string;
  messageId: string;
  sessionId: string;
  promptId: string;
  command: SessionCommandName;
  index?: number;
  expiresAt: number;
}

export interface CapabilityStoreDeps {
  loadConfig: () => RuntimeConfig;
  now?: () => number;
}

export function createCapabilityStore(deps: CapabilityStoreDeps) {
  const now = deps.now ?? Date.now;
  const byChat = new Map<string, CommandCapability>();

  return {
    /** Returns whether the current turn carries an actionable session-control command. */
    bind(input: BindCommandInput): boolean {
      try {
        const envelope = parseDirectTelegramEnvelope(input.prompt);
        if (envelope === null) return false;
        assertAuthorizedChat(deps.loadConfig(), envelope.chatId);
        const parsed = parseSessionCommand(envelope.body);
        if (parsed === null) return false;

        // Latest command per chat only: an older command must never stay actionable.
        byChat.set(envelope.chatId, {
          chatId: envelope.chatId,
          messageId: envelope.messageId,
          sessionId: input.session_id,
          promptId: input.prompt_id,
          command: parsed.command,
          ...(parsed.command === "resume" ? { index: parsed.index } : {}),
          expiresAt: now() + CAPABILITY_TTL_MS
        });
        return true;
      } catch {
        return false;
      }
    },

    /** Fail-closed, single-use consumption. Everything must match exactly or nothing is returned. */
    take(chatId: string, command: SessionCommandName, index?: number): CommandCapability | null {
      const capability = byChat.get(chatId);
      if (capability === undefined) return null;
      if (capability.expiresAt <= now()) {
        byChat.delete(chatId);
        return null;
      }
      if (capability.chatId !== chatId || capability.command !== command) return null;
      if (capability.index !== index) return null;
      byChat.delete(chatId);
      return capability;
    }
  };
}
