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
import { selectTurnVerbPair, TurnProgress, type TurnVerbPair } from "./progress-state.js";
import { MAX_UNIFIED_CONTENT_CHARACTERS } from "./unified-contract.js";
import type {
  ProgressEditOutcome,
  ProgressSendOutcome,
  CommentarySendOutcome
} from "./progress-transport.js";
import type { CommentaryBlock, CommentaryTracker } from "./commentary-transcript.js";
import { sanitizeCommentary } from "./commentary-sanitizer.js";

/** Long enough to coalesce a parallel tool burst, short enough to still read as progress. */
export const PROGRESS_DEBOUNCE_MS = 1_500;
/** One bounded transcript catch-up read, separate from progress scheduling. */
export const COMMENTARY_CATCHUP_WAIT_MS = 35;
/**
 * The Stop/StopFailure hook must never hold Claude's turn end open for a full Telegram
 * timeout. The final drain is bounded; if the transport is slow, the hook returns and the
 * drain continues in the background.
 */
export const FINAL_DRAIN_TIMEOUT_MS = 2_000;
/** Ephemeral state only. A long session must not accumulate turns without bound. */
export const MAX_RETAINED_TURNS = 32;

const CONTROL_NAMESPACE = /^\/(?:usage|sessions|model|rename|reset|resume)(?=@|\s|$)/;
const MODEL_REPLY_CHOICE = /^(?:[1-4] · (?:Opus|Sonnet|Haiku|Inherit)|5 · Cancel)$/;

export type CancelScheduled = () => void;
export type FinalDeliveryOutcome = "delivered" | "uncertain" | "too_large" | "rejected";
export type FinishTurnDisposition = "finished" | "retry";

export interface ArtifactCandidate {
  sessionId: string;
  path: string;
  description?: string;
}

export interface ArtifactTracker {
  collect: () => ArtifactCandidate[];
  close: () => void;
}

export interface TurnDisclosureDeps {
  loadConfig: () => RuntimeConfig;
  mode: ToolDisclosureMode;
  startTyping: (chatId: string) => CancelScheduled;
  startArtifactTracking?: (input: BindTurnInput) => ArtifactTracker | null;
  startAuthFailureWatch?: (
    input: BindTurnInput,
    onFailure: () => Promise<void>
  ) => CancelScheduled;
  startCommentaryTracking?: (input: BindTurnInput) => CommentaryTracker | null;
  /** Bounded transcript catch-up wait; production uses one setTimeout, tests inject a no-time wait. */
  waitForCommentaryCatchup?: (delayMs: number) => Promise<void>;
  deliverCommentary?: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    content: string
  ) => Promise<CommentarySendOutcome>;
  sendAuthFailure?: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string
  ) => Promise<void>;
  deliverFinal?: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    content: string,
    artifacts: readonly ArtifactCandidate[]
  ) => Promise<FinalDeliveryOutcome>;
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
  seenToolUseIds: Set<string>;
  toolSegments: Map<string, number>;
  segments: Map<number, TurnProgress>;
  segmentNumber: number;
  verbs: TurnVerbPair;
  bubbleMessageId: number | null;
  state: BubbleState;
  replacementUsed: boolean;
  lastSentText: string | null;
  cancel: CancelScheduled | null;
  cancelTyping: CancelScheduled | null;
  cancelAuthWatch: CancelScheduled | null;
  finalDeliveryAttempted: boolean;
  finalDeliveryRetries: number;
  artifactTracker: ArtifactTracker | null;
  commentaryTracker: CommentaryTracker | null;
  commentaryKeys: Set<string>;
  pendingCommentaryBoundaries: number;
  commentaryAbandoned: boolean;
  pendingStatuses: Map<string, "done" | "failed">;
  artifacts: ArtifactCandidate[] | null;
  chain: Promise<void>;
}

function turnKey(sessionId: string, promptId: string): string {
  return `${sessionId}/${promptId}`;
}

function collectArtifacts(turn: Turn): ArtifactCandidate[] {
  if (turn.artifacts !== null) return turn.artifacts;
  try {
    turn.artifacts = turn.artifactTracker?.collect() ?? [];
  } catch {
    turn.artifacts = [];
  } finally {
    turn.artifactTracker?.close();
    turn.artifactTracker = null;
  }
  return turn.artifacts;
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
    turn.cancelAuthWatch?.();
    turn.cancelAuthWatch = null;
    turn.artifactTracker?.close();
    turn.artifactTracker = null;
    turn.commentaryTracker?.close();
    turn.commentaryTracker = null;
    turn.commentaryAbandoned = true;
    turn.artifacts = [];
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


  async function emitCommentary(turn: Turn, blocks: CommentaryBlock[]): Promise<void> {
    if (turn.commentaryAbandoned || deps.deliverCommentary === undefined) return;
    const fresh = blocks.filter(block => {
      if (turn.commentaryKeys.has(block.key)) return false;
      // Reservation happens before any transport I/O, including rejected text.
      turn.commentaryKeys.add(block.key);
      turn.commentaryTracker?.reserve(block.key);
      return true;
    });
    for (const block of fresh) {
      if (turn.commentaryAbandoned) return;
      const content = sanitizeCommentary(block.text);
      if (!content) continue;
      let config: RuntimeConfig;
      try { config = deps.loadConfig(); assertAuthorizedChat(config, turn.chatId); } catch { continue; }
      try { await deps.deliverCommentary(config, turn.chatId, turn.quoteMessageId, content); } catch { /* display only */ }
    }
  }

  async function beginSegment(turn: Turn, blocks: CommentaryBlock[]): Promise<void> {
    turn.cancel?.();
    turn.cancel = null;
    const old = turn.progress;
    old.close("Stop");
    await flush(turn);
    if (turn.commentaryAbandoned) return;
    // The preceding bubble is sealed permanently at this boundary.
    turn.bubbleMessageId = null;
    turn.state = "none";
    turn.lastSentText = null;
    turn.replacementUsed = false;
    turn.segmentNumber += 1;
    turn.progress = new TurnProgress({
      chatId: turn.chatId,
      messageId: turn.quoteMessageId,
      sessionId: turn.progress.key.sessionId,
      promptId: turn.progress.key.promptId
    }, turn.verbs);
    turn.segments.set(turn.segmentNumber, turn.progress);
    await emitCommentary(turn, blocks);
  }

  async function finalize(turn: Turn, outcome: "Stop" | "StopFailure"): Promise<void> {
    turn.cancelTyping?.();
    turn.cancelTyping = null;
    turn.cancel?.();
    turn.cancel = null;
    if (outcome === "Stop") {
      turn.cancelAuthWatch?.();
      turn.cancelAuthWatch = null;
    }
    // A PreToolUse boundary may be sealing the previous segment asynchronously. Let that
    // ordering settle for one bounded drain before closing the current segment.
    let preTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        turn.chain,
        new Promise<void>(resolve => {
          preTimeout = setTimeout(resolve, FINAL_DRAIN_TIMEOUT_MS);
          preTimeout.unref?.();
        })
      ]);
    } finally {
      if (preTimeout !== null) clearTimeout(preTimeout);
    }
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
      turn.commentaryAbandoned = true;
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
        // Stop can close it, leaving a permanent stale progress bubble.
        if (CONTROL_NAMESPACE.test(envelope.body) || MODEL_REPLY_CHOICE.test(envelope.body)) return;
        assertAuthorizedChat(deps.loadConfig(), envelope.chatId);

        // A newer prompt in the same chat retires the previous bubble; a stale turn must
        // never reopen and edit a message that no longer describes what is happening.
        for (const [existingKey, existing] of turns) {
          if (existing.chatId === envelope.chatId) {
            drop(existing);
            turns.delete(existingKey);
          }
        }

        const key = turnKey(input.session_id, input.prompt_id);
        const duplicate = turns.get(key);
        if (duplicate !== undefined) drop(duplicate);
        turns.delete(key);
        const turn: Turn = {
          chatId: envelope.chatId,
          quoteMessageId: envelope.messageId,
          progress: new TurnProgress({
            chatId: envelope.chatId,
            messageId: envelope.messageId,
            sessionId: input.session_id,
            promptId: input.prompt_id
          }),
          seenToolUseIds: new Set(),
          toolSegments: new Map(),
          segments: new Map(),
          segmentNumber: 0,
          verbs: selectTurnVerbPair({ sessionId: input.session_id, promptId: input.prompt_id }),
          bubbleMessageId: null,
          state: "none",
          replacementUsed: false,
          lastSentText: null,
          cancel: null,
          cancelTyping: deps.startTyping(envelope.chatId),
          cancelAuthWatch: null,
          finalDeliveryAttempted: false,
          finalDeliveryRetries: 0,
          artifactTracker: null,
          commentaryTracker: null,
          commentaryKeys: new Set(),
          pendingCommentaryBoundaries: 0,
          commentaryAbandoned: false,
          pendingStatuses: new Map(),
          artifacts: null,
          chain: Promise.resolve()
        };
        turn.segments.set(0, turn.progress);
        turns.set(key, turn);
        if (input.transcript_path !== undefined && deps.startArtifactTracking !== undefined) {
          try {
            turn.artifactTracker = deps.startArtifactTracking(input);
          } catch {
            turn.artifactTracker = null;
          }
        }
        if (input.transcript_path !== undefined && deps.startCommentaryTracking !== undefined) {
          try { turn.commentaryTracker = deps.startCommentaryTracking(input); } catch { turn.commentaryTracker = null; }
        }
        if (
          input.transcript_path !== undefined
          && deps.startAuthFailureWatch !== undefined
          && deps.sendAuthFailure !== undefined
        ) {
          try {
            turn.cancelAuthWatch = deps.startAuthFailureWatch(input, async () => {
              if (turns.get(key) !== turn) return;
              await finalize(turn, "StopFailure");
              if (turns.get(key) !== turn) return;
              turn.cancelAuthWatch?.();
              turn.cancelAuthWatch = null;
              turns.delete(key);
              try {
                const config = deps.loadConfig();
                assertAuthorizedChat(config, turn.chatId);
                await deps.sendAuthFailure!(config, turn.chatId, turn.quoteMessageId);
              } catch {
                // Auth recovery is user-facing UX only; delivery failure cannot revive the turn.
              }
            });
          } catch {
            turn.cancelAuthWatch = null;
          }
        }
        evict();
      } catch {
        // Presentation only: an unreadable channel state simply produces no bubble.
        return;
      }
    },

    async recordTool(input: RecordToolInput): Promise<void> {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined || turn.seenToolUseIds.has(input.tool_use_id)) return;
        turn.seenToolUseIds.add(input.tool_use_id);
        const display = buildProgressStep(input.tool_name, input, deps.mode, input.agent_id);
        if (display === null) return;
        const record = () => {
          turn.toolSegments.set(input.tool_use_id, turn.segmentNumber);
          if (turn.progress.recordTool(input.tool_use_id, display)) touch(turn);
          const pending = turn.pendingStatuses.get(input.tool_use_id);
          if (pending !== undefined) {
            turn.pendingStatuses.delete(input.tool_use_id);
            if (pending === "done") turn.progress.recordSuccess(input.tool_use_id);
            else turn.progress.recordFailure(input.tool_use_id);
          }
        };
        const blocks = turn.commentaryTracker?.collectBeforeTool(input.tool_use_id) ?? [];
        let freshBlocks = blocks.filter(block => !turn.commentaryKeys.has(block.key));
        // Every empty read gets one bounded catch-up. Start its timer before queueing so
        // overlapping hooks wait in parallel, while turn.chain still preserves record order.
        const needsCatchup = freshBlocks.length === 0 && turn.commentaryTracker !== null;
        const catchupWait = needsCatchup
          ? Promise.resolve().then(() => (
              deps.waitForCommentaryCatchup ?? ((delayMs: number) => new Promise<void>(resolve => {
                // This timer is awaited by the hook; it must keep short-lived processes alive.
                setTimeout(resolve, delayMs);
              }))
            )(COMMENTARY_CATCHUP_WAIT_MS)).catch(() => undefined)
          : null;
        const ownsBoundary = freshBlocks.length > 0 || needsCatchup;
        if (ownsBoundary) turn.pendingCommentaryBoundaries += 1;
        const run = async (): Promise<void> => {
          try {
            if (turn.commentaryAbandoned || lookup(input.session_id, input.prompt_id) !== turn) return;
            if (catchupWait !== null) {
              await catchupWait;
              if (turn.commentaryAbandoned || lookup(input.session_id, input.prompt_id) !== turn) return;
              try {
                freshBlocks = (turn.commentaryTracker?.collectBeforeTool(input.tool_use_id) ?? [])
                  .filter(block => !turn.commentaryKeys.has(block.key));
              } catch {
                // Fail open: an unreadable catch-up leaves this hook with no commentary.
              }
              if (turn.commentaryAbandoned || lookup(input.session_id, input.prompt_id) !== turn) return;
            }
            const pending = freshBlocks.filter(block => !turn.commentaryKeys.has(block.key));
            if (pending.length > 0) await beginSegment(turn, pending);
            if (turn.commentaryAbandoned || lookup(input.session_id, input.prompt_id) !== turn) return;
            record();
          } finally {
            if (ownsBoundary) turn.pendingCommentaryBoundaries -= 1;
          }
        };
        turn.chain = turn.chain.then(run, run).catch(() => undefined);
        await turn.chain;
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },


    recordSuccess(input: RecordToolSuccessInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        const segment = turn.toolSegments.get(input.tool_use_id);
        if (segment === undefined) { turn.pendingStatuses.set(input.tool_use_id, "done"); return; }
        const progress = turn.segments.get(segment);
        if (progress?.recordSuccess(input.tool_use_id) && segment === turn.segmentNumber) touch(turn);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    recordFailure(input: RecordToolFailureInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        const segment = turn.toolSegments.get(input.tool_use_id);
        if (segment === undefined) { turn.pendingStatuses.set(input.tool_use_id, "failed"); return; }
        const progress = turn.segments.get(segment);
        if (progress?.recordFailure(input.tool_use_id) && segment === turn.segmentNumber) touch(turn);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    async finishTurn(input: FinishTurnInput): Promise<FinishTurnDisposition> {
      try {
        const key = turnKey(input.session_id, input.prompt_id);
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return "finished";
        await finalize(turn, input.hook_event_name);
        if (turns.get(key) !== turn) return "finished";
        if (input.hook_event_name === "StopFailure") return "finished";
        if (
          turn.finalDeliveryAttempted
          || deps.deliverFinal === undefined
          || input.last_assistant_message === undefined
          || input.last_assistant_message.trim() === ""
        ) {
          drop(turn);
          if (turns.get(key) === turn) turns.delete(key);
          return "finished";
        }
        turn.finalDeliveryAttempted = true;
        let outcome: FinalDeliveryOutcome = Array.from(input.last_assistant_message).length
          > MAX_UNIFIED_CONTENT_CHARACTERS ? "too_large" : "rejected";
        let config: RuntimeConfig | undefined;
        if (outcome !== "too_large") {
          try {
            config = deps.loadConfig();
            assertAuthorizedChat(config, turn.chatId);
            outcome = await deps.deliverFinal(
              config,
              turn.chatId,
              turn.quoteMessageId,
              input.last_assistant_message,
              collectArtifacts(turn)
            );
          } catch {
            outcome = "rejected";
          }
        }
        if (outcome === "too_large") {
          if (turn.finalDeliveryRetries < 1) {
            turn.finalDeliveryRetries += 1;
            turn.finalDeliveryAttempted = false;
            turn.cancelTyping = deps.startTyping(turn.chatId);
            return "retry";
          }
          if (config === undefined) {
            try {
              config = deps.loadConfig();
              assertAuthorizedChat(config, turn.chatId);
            } catch {
              config = undefined;
            }
          }
          if (config !== undefined) {
            try {
              await deps.deliverFinal(
                config,
                turn.chatId,
                turn.quoteMessageId,
                "The response was too long to deliver. Ask for a shorter answer.",
                []
              );
            } catch {
              // The fixed fallback is attempted once; unknown outcomes are never replayed.
            }
          }
        }
        drop(turn);
        if (turns.get(key) === turn) turns.delete(key);
        return "finished";
      } catch {
        // Never surface a disclosure failure to the agent.
        return "finished";
      }
    }
  };
}
