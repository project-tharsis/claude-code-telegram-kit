import {
  assertAuthorizedChat,
  parseDirectTelegramEnvelope,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import {
  type BindTurnInput,
  type FinishTurnInput,
  type RecordToolFailureInput,
  type RecordToolInput,
  type RecordToolSuccessInput
} from "./hook-contract.js";
import { buildProgressStep, type ToolDisclosureMode } from "./progress-preview.js";
import { TurnProgress } from "./progress-state.js";
import type {
  ProgressEditOutcome,
  ProgressSendOutcome
} from "./progress-transport.js";

/** Long enough to coalesce a parallel tool burst, short enough to still read as progress. */
export const PROGRESS_DEBOUNCE_MS = 1_500;
/**
 * The Stop/StopFailure hook must never hold Claude's turn end open for a full Telegram
 * timeout. The final drain is bounded; if the transport is slow, the hook returns and the
 * drain continues in the background.
 */
export const FINAL_DRAIN_TIMEOUT_MS = 2_000;
/** Ephemeral state only. A long session must not accumulate turns without bound. */
export const MAX_RETAINED_TURNS = 32;

const CONTROL_COMMAND = /^(?:\/(?:usage|sessions)(?:@[A-Za-z0-9_]{1,32})?|\/resume(?:@[A-Za-z0-9_]{1,32})? (?:[1-9]|10)|\/(?:reset|resume)(?:@[A-Za-z0-9_]{1,32})? confirm [23456789A-HJ-NP-Z]{6}|\/reset(?:@[A-Za-z0-9_]{1,32})?)$/;

export type CancelScheduled = () => void;

export interface TurnDisclosureDeps {
  loadConfig: () => RuntimeConfig;
  mode: ToolDisclosureMode;
  startTyping: (chatId: string) => CancelScheduled;
  send: (
    config: RuntimeConfig,
    chatId: string,
    replyToMessageId: string,
    text: string
  ) => Promise<ProgressSendOutcome>;
  edit: (
    config: RuntimeConfig,
    chatId: string,
    messageId: number,
    text: string
  ) => Promise<ProgressEditOutcome>;
  schedule: (run: () => Promise<void>, delayMs: number) => CancelScheduled;
}

/**
 * `unknown` is terminal: Telegram may already have created the bubble, so sending again is
 * the one action that can duplicate it. `abandoned` is terminal for a definitive refusal.
 */
type BubbleState = "none" | "have" | "unknown" | "abandoned";

interface Turn {
  chatId: string;
  quoteMessageId: string;
  progress: TurnProgress;
  bubbleMessageId: number | null;
  state: BubbleState;
  replacementUsed: boolean;
  lastSentText: string | null;
  cancel: CancelScheduled | null;
  cancelTyping: CancelScheduled | null;
  chain: Promise<void>;
}

function turnKey(sessionId: string, promptId: string): string {
  return `${sessionId}/${promptId}`;
}

/**
 * Presentation-only turn disclosure. Every entry point swallows its own failures: a hook must
 * never block, slow, or fail the agent because a progress bubble could not be drawn.
 */
export function createTurnDisclosure(deps: TurnDisclosureDeps) {
  const turns = new Map<string, Turn>();

  function drop(turn: Turn): void {
    turn.cancel?.();
    turn.cancel = null;
    turn.cancelTyping?.();
    turn.cancelTyping = null;
    turn.state = "abandoned";
  }

  function evict(): void {
    while (turns.size > MAX_RETAINED_TURNS) {
      const oldest = turns.keys().next();
      if (oldest.done === true) return;
      const stale = turns.get(oldest.value);
      if (stale !== undefined) drop(stale);
      turns.delete(oldest.value);
    }
  }

  async function flush(turn: Turn): Promise<void> {
    if (turn.state === "unknown" || turn.state === "abandoned") return;
    if (!turn.progress.hasSteps) return;

    let config: RuntimeConfig;
    try {
      config = deps.loadConfig();
      assertAuthorizedChat(config, turn.chatId);
    } catch {
      turn.state = "abandoned";
      return;
    }

    const text = turn.progress.render();
    if (text === turn.lastSentText) return;

    // At most two transport calls: one edit, plus one replacement send if the bubble is gone.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (turn.state === "have" && turn.bubbleMessageId !== null) {
        let outcome: ProgressEditOutcome;
        try {
          outcome = await deps.edit(config, turn.chatId, turn.bubbleMessageId, text);
        } catch {
          outcome = { kind: "transient" };
        }
        if (outcome.kind === "edited" || outcome.kind === "unchanged") {
          turn.lastSentText = text;
          return;
        }
        if (outcome.kind === "transient") return;
        if (outcome.kind === "throttled") {
          turn.state = "abandoned";
          return;
        }
        if (outcome.kind === "gone") {
          if (turn.replacementUsed) {
            turn.state = "abandoned";
            return;
          }
          turn.replacementUsed = true;
          turn.state = "none";
          turn.bubbleMessageId = null;
          continue;
        }
        turn.state = "abandoned";
        return;
      }

      let outcome: ProgressSendOutcome;
      try {
        outcome = await deps.send(config, turn.chatId, turn.quoteMessageId, text);
      } catch {
        outcome = { kind: "uncertain" };
      }
      if (outcome.kind === "sent") {
        turn.bubbleMessageId = outcome.messageId;
        turn.state = "have";
        turn.lastSentText = text;
        return;
      }
      turn.state = outcome.kind === "uncertain" ? "unknown" : "abandoned";
      return;
    }
  }

  function enqueue(turn: Turn): Promise<void> {
    turn.chain = turn.chain.then(() => flush(turn)).catch(() => undefined);
    return turn.chain;
  }

  function touch(turn: Turn): void {
    if (
      turn.progress.closed
      || turn.cancel !== null
      || turn.state === "unknown"
      || turn.state === "abandoned"
    ) return;
    try {
      turn.cancel = deps.schedule(async () => {
        turn.cancel = null;
        await enqueue(turn);
      }, PROGRESS_DEBOUNCE_MS);
    } catch {
      turn.cancel = null;
    }
  }

  function lookup(sessionId: string, promptId: string): Turn | undefined {
    return turns.get(turnKey(sessionId, promptId));
  }

  async function finalize(turn: Turn, outcome: "Stop" | "StopFailure"): Promise<void> {
    turn.cancelTyping?.();
    turn.cancelTyping = null;
    turn.cancel?.();
    turn.cancel = null;
    turn.progress.close(outcome);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        enqueue(turn),
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, FINAL_DRAIN_TIMEOUT_MS);
          timeout.unref?.();
        })
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  return {
    get size(): number {
      return turns.size;
    },

    bindTurn(input: BindTurnInput): void {
      try {
        const envelope = parseDirectTelegramEnvelope(input.prompt);
        if (envelope === null) return;
        // Session-control commands already have their own ACK/list/permission/completion UX.
        // A progress bubble is redundant, and resume/reset kill the current process before
        // Stop can close it, leaving a permanent stale "Working…" bubble.
        if (CONTROL_COMMAND.test(envelope.body)) return;
        assertAuthorizedChat(deps.loadConfig(), envelope.chatId);

        // A newer prompt in the same chat retires the previous bubble; a stale turn must
        // never reopen and edit a message that no longer describes what is happening.
        for (const existing of turns.values()) {
          if (existing.chatId === envelope.chatId) drop(existing);
        }

        const key = turnKey(input.session_id, input.prompt_id);
        turns.delete(key);
        turns.set(key, {
          chatId: envelope.chatId,
          quoteMessageId: envelope.messageId,
          progress: new TurnProgress({
            chatId: envelope.chatId,
            messageId: envelope.messageId,
            sessionId: input.session_id,
            promptId: input.prompt_id
          }),
          bubbleMessageId: null,
          state: "none",
          replacementUsed: false,
          lastSentText: null,
          cancel: null,
          cancelTyping: deps.startTyping(envelope.chatId),
          chain: Promise.resolve()
        });
        evict();
      } catch {
        // Presentation only: an unreadable channel state simply produces no bubble.
        return;
      }
    },

    recordTool(input: RecordToolInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        const display = buildProgressStep(input.tool_name, input, deps.mode, input.agent_id);
        if (display === null) return;
        if (turn.progress.recordTool(input.tool_use_id, display)) touch(turn);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    recordSuccess(input: RecordToolSuccessInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        if (turn.progress.recordSuccess(input.tool_use_id)) touch(turn);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    recordFailure(input: RecordToolFailureInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        if (turn.progress.recordFailure(input.tool_use_id)) touch(turn);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    async finishTurn(input: FinishTurnInput): Promise<void> {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        await finalize(turn, input.hook_event_name);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    async finalizeChat(chatId: string): Promise<void> {
      const pending: Promise<void>[] = [];
      for (const turn of turns.values()) {
        if (turn.chatId !== chatId) continue;
        pending.push(finalize(turn, "Stop"));
      }
      await Promise.allSettled(pending);
    }
  };
}
