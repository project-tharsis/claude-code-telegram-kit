import {
  assertAuthorizedChat,
  parseDirectTelegramEnvelope,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import { CONFIRMATION, type ResetReceipt, type ResetRequest } from "./control.js";
import {
  parseControlCommand,
  type ModelAlias,
  type ConfirmationChallengeStore
} from "./control-command.js";
import type {
  ListSessionsReceipt,
  ResumeSessionReceipt,
  TrustedListSessionsRequest,
  TrustedResumeSessionRequest
} from "./sessions-control.js";
import type { ControlHookInput } from "./control-input.js";
import {
  MODEL_REPLY_KEYBOARD,
  REMOVE_MODEL_REPLY_KEYBOARD
} from "./model-reply-keyboard.js";
import type { TelegramReplyMarkup } from "./runtime.js";
import { escapeTelegramHtml } from "./telegram-html.js";

export const RESET_CHALLENGE_PREFIX =
  "<b>Start a fresh session?</b>\n<i>Confirm within 60 seconds.</i>";
export const RESUME_CHALLENGE_PREFIX =
  "<b>Resume session {index}?</b>\n<i>Confirm within 60 seconds.</i>";
export const CONTROL_CONFIRMATION_INVALID_TEXT =
  "<b>Confirmation expired</b>\n<i>Send the original command again.</i>";
export const CONTROL_COMMAND_USAGE_TEXT =
  "<b>Command not recognized</b>\nUse <code>/usage</code>, <code>/sessions</code>, <code>/model</code>, <code>/rename NAME</code>, <code>/reset</code>, or <code>/resume N</code>.";
export const PRIVATE_CONTROL_ONLY_TEXT =
  "<b>Private chat only</b>\n<i>Rename, model switch, reset, and resume are disabled in groups.</i>";
export const SUBSCRIPTION_USAGE_UNAVAILABLE_TEXT =
  "<b>Usage unavailable</b>\n<i>Try again shortly.</i>";
export const CONTROL_OPERATION_FAILED_TEXT =
  "<b>Command failed</b>\n<i>Try again.</i>";

export interface ControlCommandDispatcherDeps {
  loadConfig: () => RuntimeConfig;
  challenges: ConfirmationChallengeStore;
  sendMessage: (
    config: RuntimeConfig,
    chatId: string,
    text: string,
    replyTo?: string,
    parseMode?: "HTML",
    replyMarkup?: TelegramReplyMarkup
  ) => Promise<number>;
  react: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    state: "success" | "failure"
  ) => Promise<boolean>;
  listSessionsTrusted: (request: TrustedListSessionsRequest) => Promise<ListSessionsReceipt>;
  getUsage: () => Promise<string>;
  getModelStatus: (sessionId: string) => Promise<string>;
  switchModel: (request: {
    chatId: string;
    messageId: string;
    model: ModelAlias;
  }) => Promise<{ status: "scheduled"; unit: string }>;
  renameSessionTitle: (request: { sessionId: string; title: string }) => Promise<void>;
  resumeSessionTrusted: (request: TrustedResumeSessionRequest) => Promise<ResumeSessionReceipt>;
  resetSession: (request: ResetRequest) => Promise<ResetReceipt>;
}

export interface ControlDispatchResult {
  handled: boolean;
}

function botSuffix(body: string): string {
  return /^\/(?:sessions|usage|model|rename|reset|resume)(@[A-Za-z0-9_]{1,32})?/.exec(body)?.[1] ?? "";
}

async function bestEffortReact(
  deps: ControlCommandDispatcherDeps,
  config: RuntimeConfig,
  chatId: string,
  messageId: string,
  state: "success" | "failure"
): Promise<void> {
  try {
    await deps.react(config, chatId, messageId, state);
  } catch {
    // Reaction UX is never the authority for a control action.
  }
}


async function bestEffortFailure(
  deps: ControlCommandDispatcherDeps,
  config: RuntimeConfig,
  chatId: string,
  messageId: string,
  text = CONTROL_OPERATION_FAILED_TEXT
): Promise<void> {
  try {
    await deps.sendMessage(config, chatId, text, messageId, "HTML");
  } catch {
    // A failed failure-notification must not route the command into the LLM.
  }
  await bestEffortReact(deps, config, chatId, messageId, "failure");
}

function alreadyNotified(error: unknown): boolean {
  return error instanceof Error
    && (error.message === "reset scheduler failed" || error.message === "resume scheduler failed");
}

/**
 * Deterministic control router for the UserPromptSubmit hook.
 *
 * A direct Telegram control command is always consumed here and never reaches the LLM. Ordinary
 * messages return handled=false. Authority comes from the exact Channel envelope and live
 * allowlist, while destructive actions additionally require a short-lived one-shot challenge.
 */
export function createControlCommandDispatcher(deps: ControlCommandDispatcherDeps) {
  return async (input: ControlHookInput): Promise<ControlDispatchResult> => {
    const envelope = parseDirectTelegramEnvelope(input.prompt);
    if (envelope === null) return { handled: false };

    const command = parseControlCommand(envelope.body);
    if (command.kind === "other") return { handled: false };

    let config: RuntimeConfig;
    try {
      config = deps.loadConfig();
      assertAuthorizedChat(config, envelope.chatId);
    } catch {
      // It is still a control command, so block it instead of allowing the LLM to reinterpret it.
      return { handled: true };
    }

    const readOnlyNamespace = command.kind === "sessions"
      || command.kind === "usage"
      || command.kind === "model-status"
      || command.kind === "model-cancel"
      || (command.kind === "malformed" && ["sessions", "usage", "model"].includes(command.namespace));
    const destructiveNamespace = !readOnlyNamespace;
    if (destructiveNamespace && envelope.chatId.startsWith("-")) {
      await bestEffortFailure(
        deps,
        config,
        envelope.chatId,
        envelope.messageId,
        PRIVATE_CONTROL_ONLY_TEXT
      );
      return { handled: true };
    }

    if (command.kind === "malformed") {
      await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId, CONTROL_COMMAND_USAGE_TEXT);
      return { handled: true };
    }

    if (command.kind === "sessions") {
      try {
        await deps.listSessionsTrusted({
          chatId: envelope.chatId,
          messageId: envelope.messageId,
          currentSessionId: input.session_id
        });

      } catch {
        await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId);
      }
      return { handled: true };
    }

    if (command.kind === "usage") {
      try {
        const text = await deps.getUsage();
        await deps.sendMessage(config, envelope.chatId, text, envelope.messageId, "HTML");
        await bestEffortReact(deps, config, envelope.chatId, envelope.messageId, "success");
      } catch {
        await bestEffortFailure(
          deps,
          config,
          envelope.chatId,
          envelope.messageId,
          SUBSCRIPTION_USAGE_UNAVAILABLE_TEXT
        );
      }
      return { handled: true };
    }

    if (command.kind === "model-status") {
      try {
        await deps.sendMessage(
          config,
          envelope.chatId,
          await deps.getModelStatus(input.session_id),
          envelope.messageId,
          "HTML",
          MODEL_REPLY_KEYBOARD
        );
        await bestEffortReact(deps, config, envelope.chatId, envelope.messageId, "success");
      } catch {
        await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId);
      }
      return { handled: true };
    }

    if (command.kind === "model-cancel") {
      try {
        await deps.sendMessage(
          config,
          envelope.chatId,
          "<i>Model selection closed.</i>",
          envelope.messageId,
          "HTML",
          REMOVE_MODEL_REPLY_KEYBOARD
        );
        await bestEffortReact(deps, config, envelope.chatId, envelope.messageId, "success");
      } catch {
        await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId);
      }
      return { handled: true };
    }

    if (command.kind === "model-switch") {
      try {
        await deps.sendMessage(
          config,
          envelope.chatId,
          `<b>Model switch requested</b>\n<code>${escapeTelegramHtml(command.model)}</code>\n`
            + "<i>Waiting for host restart…</i>",
          envelope.messageId,
          "HTML",
          REMOVE_MODEL_REPLY_KEYBOARD
        );
        await deps.switchModel({
          chatId: envelope.chatId,
          messageId: envelope.messageId,
          model: command.model
        });
        await bestEffortReact(deps, config, envelope.chatId, envelope.messageId, "success");
      } catch {
        await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId);
      }
      return { handled: true };
    }

    if (command.kind === "rename") {
      try {
        await deps.renameSessionTitle({ sessionId: input.session_id, title: command.title });
        await deps.sendMessage(
          config,
          envelope.chatId,
          `<b>Session renamed</b>\n<code>${escapeTelegramHtml(command.title)}</code>`,
          envelope.messageId,
          "HTML"
        );
        await bestEffortReact(deps, config, envelope.chatId, envelope.messageId, "success");
      } catch {
        await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId);
      }
      return { handled: true };
    }

    if (command.kind === "reset" || command.kind === "resume") {
      const action = command.kind;
      const challenge = deps.challenges.issue(
        envelope.chatId,
        action === "reset"
          ? { action, sessionId: input.session_id }
          : { action, index: command.index, sessionId: input.session_id }
      );
      const suffix = botSuffix(envelope.body);
      const confirmation = `/${action}${suffix} confirm ${challenge.code}`;
      const prefix = action === "reset"
        ? RESET_CHALLENGE_PREFIX
        : RESUME_CHALLENGE_PREFIX.replace("{index}", String(command.index));
      try {
        await deps.sendMessage(
          config,
          envelope.chatId,
          `${prefix}\n\n<code>${escapeTelegramHtml(confirmation)}</code>`,
          envelope.messageId,
          "HTML"
        );
      } catch {
        // Revoke a code the user never received.
        deps.challenges.consume(envelope.chatId, action, challenge.code, input.session_id);
        await bestEffortReact(deps, config, envelope.chatId, envelope.messageId, "failure");
        return { handled: true };
      }
      await bestEffortReact(deps, config, envelope.chatId, envelope.messageId, "success");

      return { handled: true };
    }

    const action = command.kind === "reset-confirm" ? "reset" : "resume";
    const confirmed = deps.challenges.consume(envelope.chatId, action, command.code, input.session_id);
    if (confirmed === null) {
      await bestEffortFailure(
        deps,
        config,
        envelope.chatId,
        envelope.messageId,
        CONTROL_CONFIRMATION_INVALID_TEXT
      );
      return { handled: true };
    }

    if (confirmed.action === "reset") {
      try {
        await deps.resetSession({
          chat_id: envelope.chatId,
          message_id: envelope.messageId,
          current_session_id: confirmed.sessionId,
          confirmation: CONFIRMATION
        });
      } catch (error) {
        if (!alreadyNotified(error)) {
          await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId);
        }
      }
      return { handled: true };
    }

    try {
      await deps.resumeSessionTrusted({
        chatId: envelope.chatId,
        messageId: envelope.messageId,
        currentSessionId: confirmed.sessionId,
        index: confirmed.index!
      });
    } catch (error) {
      if (!alreadyNotified(error)) {
        await bestEffortFailure(deps, config, envelope.chatId, envelope.messageId);
      }
    }
    return { handled: true };
  };
}
