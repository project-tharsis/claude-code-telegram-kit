import {
  assertAuthorizedChat,
  parseDirectTelegramEnvelope,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import type { BindTurnInput } from "./hook-contract.js";
import type { ClaudeAuthAvailability } from "./claude-auth-status.js";

export const AUTH_UNAVAILABLE_MESSAGE =
  "Claude Code login expired.\n\nRun `claude auth login` on the host, then resend this message.";

const CONTROL_COMMAND = /^(?:\/(?:usage|sessions)(?:@[A-Za-z0-9_]{1,32})?|\/resume(?:@[A-Za-z0-9_]{1,32})? (?:[1-9]|10)|\/(?:reset|resume)(?:@[A-Za-z0-9_]{1,32})? confirm [23456789A-HJ-NP-Z]{6}|\/reset(?:@[A-Za-z0-9_]{1,32})?)$/;
const MAX_RETAINED_AUTH_ALERTS = 128;

export function isDeterministicControlCommand(body: string): boolean {
  return CONTROL_COMMAND.test(body);
}

export interface AuthExpiryGateDeps {
  loadConfig: () => RuntimeConfig;
  checkAuth: () => Promise<ClaudeAuthAvailability>;
  sendAuthUnavailable: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string
  ) => Promise<void>;
}

/**
 * Stops only a proven expired interactive login. Unknown probe outcomes fail open, and
 * deterministic control commands remain usable while model authentication is unavailable.
 */
export function createAuthExpiryGate(deps: AuthExpiryGateDeps) {
  const alertedMessages = new Set<string>();

  function reserveAlert(chatId: string, messageId: string): boolean {
    const key = `${chatId}/${messageId}`;
    if (alertedMessages.has(key)) return false;
    alertedMessages.add(key);
    while (alertedMessages.size > MAX_RETAINED_AUTH_ALERTS) {
      const oldest = alertedMessages.values().next();
      if (oldest.done) break;
      alertedMessages.delete(oldest.value);
    }
    return true;
  }

  return async (input: BindTurnInput): Promise<boolean> => {
    try {
      const envelope = parseDirectTelegramEnvelope(input.prompt);
      if (envelope === null || isDeterministicControlCommand(envelope.body)) return false;
      const config = deps.loadConfig();
      assertAuthorizedChat(config, envelope.chatId);
      if (await deps.checkAuth() !== "unavailable") return false;
      if (reserveAlert(envelope.chatId, envelope.messageId)) {
        try {
          await deps.sendAuthUnavailable(config, envelope.chatId, envelope.messageId);
        } catch {
          // The model request is known to fail. A Telegram transport failure must not turn the
          // original inbound into a second, equally silent model failure.
        }
      }
      return true;
    } catch {
      // Probe/config/parser failures are not proof that Claude auth is unavailable.
      return false;
    }
  };
}

export type AuthExpiryGate = ReturnType<typeof createAuthExpiryGate>;
