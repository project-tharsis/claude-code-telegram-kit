import {
  assertAuthorizedChat,
  parseTerminalTaskNotification,
  parseDirectTelegramEnvelope,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import {
  type BindTurnInput,
  type FinishTurnInput,
  type RecordSubagentStartInput,
  type RecordSubagentStopInput,
  type RecordToolFailureInput,
  type RecordToolInput,
  type RecordToolSuccessInput
} from "./hook-contract.js";
import { BackgroundProgress } from "./background-progress.js";
import { buildProgressStep, type ToolDisclosureMode } from "./progress-preview.js";
import { TurnProgress } from "./progress-state.js";
import { MAX_UNIFIED_CONTENT_CHARACTERS } from "./unified-contract.js";
import type { RuntimeFailure } from "./runtime-failure-watcher.js";
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
/** Ordinary ephemeral turn state. Active background turns have their own bounded allowance. */
export const MAX_RETAINED_TURNS = 32;
export const MAX_ACTIVE_BACKGROUND_TURNS = 16;
export const MAX_BACKGROUND_CHAIN_DEPTH = 2;
/** Routes survive the foreground Stop so a later internal completion can recover its Telegram authority. */
export const BACKGROUND_TASK_ROUTE_TTL_MS = 6 * 60 * 60 * 1_000;
export const MAX_BACKGROUND_TASK_ROUTES = 128;
export const RUNTIME_INCIDENT_TTL_MS = 5 * 60 * 1_000;
export const MAX_RUNTIME_INCIDENTS = 32;
export const MAX_RESET_FUTURE_MS = 7 * 24 * 60 * 60 * 1_000;

const CONTROL_NAMESPACE = /^\/(?:usage|sessions|model|rename|reset|resume)(?=@|\s|$)/;
const MODEL_REPLY_CHOICE = /^(?:[1-4] · (?:Opus|Sonnet|Haiku|Inherit)|5 · Cancel)$/;
const BACKGROUND_ROUTE_TOOLS = new Set(["Skill", "Task", "Agent"]);

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
  startRuntimeFailureWatch?: (
    input: BindTurnInput,
    onFailure: (failure: RuntimeFailure) => Promise<void>
  ) => CancelScheduled;
  sendRuntimeFailure?: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    failure: RuntimeFailure
  ) => Promise<void>;
  deliverFinal?: (
    config: RuntimeConfig,
    chatId: string,
    messageId: string,
    content: string,
    artifacts: readonly ArtifactCandidate[],
    background?: boolean
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
  now?: () => number;
}

/**
 * `unknown` is terminal: Telegram may already have created the bubble, so sending again is
 * the one action that can duplicate it. `abandoned` is terminal for a definitive refusal.
 */
type BubbleState = "none" | "have" | "unknown" | "abandoned";
type ProgressPhase = "foreground" | "background-agents";

interface Turn {
  chatId: string;
  quoteMessageId: string;
  background: boolean;
  backgroundDepth: number;
  progress: TurnProgress;
  backgroundProgress: BackgroundProgress;
  progressPhase: ProgressPhase;
  bubbleMessageId: number | null;
  state: BubbleState;
  replacementUsed: boolean;
  lastSentText: string | null;
  cancel: CancelScheduled | null;
  cancelTyping: CancelScheduled | null;
  cancelRuntimeFailureWatch: CancelScheduled | null;
  runtimeFailureAttempted: boolean;
  finalDeliveryAttempted: boolean;
  finalDeliveryRetries: number;
  artifactTracker: ArtifactTracker | null;
  artifacts: ArtifactCandidate[] | null;
  chain: Promise<void>;
}

interface BackgroundTaskRoute {
  chatId: string;
  quoteMessageId: string;
  ownerKey: string;
  toolUseId: string;
  taskAliases: Set<string>;
  depth: number;
  expiresAt: number;
}

function backgroundRouteKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}/${toolUseId}`;
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
  const backgroundTaskRoutes = new Map<string, BackgroundTaskRoute>();
  const backgroundTaskAliases = new Map<string, string>();
  const runtimeIncidents = new Map<string, number>();
  const now = deps.now ?? Date.now;

  function deleteBackgroundTaskRoute(key: string): BackgroundTaskRoute | undefined {
    const route = backgroundTaskRoutes.get(key);
    if (route === undefined) return undefined;
    backgroundTaskRoutes.delete(key);
    for (const alias of route.taskAliases) {
      if (backgroundTaskAliases.get(alias) === key) backgroundTaskAliases.delete(alias);
    }
    return route;
  }

  function pruneBackgroundTaskRoutes(): void {
    const current = now();
    for (const [key, route] of backgroundTaskRoutes) {
      if (route.expiresAt <= current) deleteBackgroundTaskRoute(key);
    }
    while (backgroundTaskRoutes.size > MAX_BACKGROUND_TASK_ROUTES) {
      const oldest = backgroundTaskRoutes.keys().next();
      if (oldest.done === true) return;
      deleteBackgroundTaskRoute(oldest.value);
    }
  }

  function reserveRuntimeIncident(turn: Turn, failure: RuntimeFailure): boolean {
    const current = now();
    for (const [key, expiresAt] of runtimeIncidents) if (expiresAt <= current) runtimeIncidents.delete(key);
    const key = `${turn.chatId}/${failure.error}`;
    if ((runtimeIncidents.get(key) ?? 0) > current) return false;
    if (runtimeIncidents.size >= MAX_RUNTIME_INCIDENTS) return false;
    const reset = failure.resetsAt === undefined ? 0 : failure.resetsAt * 1_000;
    const resetExpiry = reset > current && reset <= current + MAX_RESET_FUTURE_MS ? reset : 0;
    runtimeIncidents.set(key, Math.max(current + RUNTIME_INCIDENT_TTL_MS, resetExpiry));
    return true;
  }

  function rememberBackgroundTaskRoute(
    sessionId: string,
    toolUseId: string,
    ownerKey: string,
    turn: Turn
  ): void {
    if (turn.backgroundDepth >= MAX_BACKGROUND_CHAIN_DEPTH) return;
    const key = backgroundRouteKey(sessionId, toolUseId);
    if (backgroundTaskRoutes.has(key)) return;
    if (!turn.backgroundProgress.recordTaskStart(toolUseId)) return;
    backgroundTaskRoutes.set(key, {
      chatId: turn.chatId,
      quoteMessageId: turn.quoteMessageId,
      ownerKey,
      toolUseId,
      taskAliases: new Set(),
      depth: turn.backgroundDepth + 1,
      expiresAt: now() + BACKGROUND_TASK_ROUTE_TTL_MS
    });
    pruneBackgroundTaskRoutes();
  }

  function rememberBackgroundTaskAlias(sessionId: string, toolUseId: string, taskId: string): void {
    const canonical = backgroundRouteKey(sessionId, toolUseId);
    const route = backgroundTaskRoutes.get(canonical);
    if (route === undefined) return;
    const alias = backgroundRouteKey(sessionId, taskId);
    const existing = backgroundTaskAliases.get(alias);
    if (existing !== undefined && existing !== canonical) return;
    backgroundTaskAliases.set(alias, canonical);
    route.taskAliases.add(alias);
  }

  function terminalizeBackgroundTaskRoute(sessionId: string, toolUseId: string): Turn | undefined {
    const route = deleteBackgroundTaskRoute(backgroundRouteKey(sessionId, toolUseId));
    if (route === undefined) return undefined;
    const owner = turns.get(route.ownerKey);
    return owner !== undefined && owner.backgroundProgress.recordTaskTerminal(route.toolUseId)
      ? owner : undefined;
  }

  function drop(turn: Turn): void {
    turn.cancel?.();
    turn.cancel = null;
    turn.cancelTyping?.();
    turn.cancelTyping = null;
    turn.cancelRuntimeFailureWatch?.();
    turn.cancelRuntimeFailureWatch = null;
    turn.artifactTracker?.close();
    turn.artifactTracker = null;
    turn.artifacts = [];
    turn.state = "abandoned";
  }

  function isActiveBackground(turn: Turn): boolean {
    if (turn.backgroundProgress.hasPendingTasks) return true;
    return turn.progressPhase === "background-agents" && turn.backgroundProgress.hasActive;
  }

  function evictOldest(predicate: (turn: Turn) => boolean): boolean {
    for (const [key, candidate] of turns) {
      if (!predicate(candidate)) continue;
      drop(candidate);
      turns.delete(key);
      return true;
    }
    return false;
  }

  function evict(): void {
    const inactive = (turn: Turn) => !isActiveBackground(turn);
    while (Array.from(turns.values()).filter(isActiveBackground).length > MAX_ACTIVE_BACKGROUND_TURNS) {
      if (!evictOldest(isActiveBackground)) break;
    }
    while (Array.from(turns.values()).filter(inactive).length > MAX_RETAINED_TURNS) {
      if (!evictOldest(inactive)) break;
    }
  }

  function visibleProgress(turn: Turn): { hasSteps: boolean; closed: boolean; text: string } {
    if (turn.progressPhase === "background-agents") {
      return {
        hasSteps: turn.backgroundProgress.hasAgents,
        closed: false,
        text: turn.backgroundProgress.render()
      };
    }
    return {
      hasSteps: turn.progress.hasSteps,
      closed: turn.progress.closed,
      text: turn.progress.render()
    };
  }

  async function flush(turn: Turn): Promise<void> {
    if (turn.state === "unknown" || turn.state === "abandoned") return;
    const visible = visibleProgress(turn);
    if (!visible.hasSteps) return;

    let config: RuntimeConfig;
    try {
      config = deps.loadConfig();
      assertAuthorizedChat(config, turn.chatId);
    } catch {
      turn.state = "abandoned";
      return;
    }

    const text = visible.text;
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
    const visible = visibleProgress(turn);
    if (
      visible.closed
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
    if (outcome === "Stop") {
      turn.cancelRuntimeFailureWatch?.();
      turn.cancelRuntimeFailureWatch = null;
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
    }
  }

  async function deliverRuntimeFailure(
    turn: Turn,
    key: string,
    failure: RuntimeFailure,
    finalized = false
  ): Promise<void> {
    if (turn.runtimeFailureAttempted) return;
    turn.runtimeFailureAttempted = true;
    if (!finalized) await finalize(turn, "StopFailure");
    if (turns.get(key) !== turn) return;
    turn.cancelRuntimeFailureWatch?.();
    turn.cancelRuntimeFailureWatch = null;
    turns.delete(key);
    const shouldSend = reserveRuntimeIncident(turn, failure);
    drop(turn);
    if (!shouldSend || deps.sendRuntimeFailure === undefined) return;
    try {
      const config = deps.loadConfig();
      assertAuthorizedChat(config, turn.chatId);
      await deps.sendRuntimeFailure(config, turn.chatId, turn.quoteMessageId, failure);
    } catch {
      // The incident is reserved before transport; unknown outcomes are never replayed.
    }
  }

  async function beginBackgroundAgentDisclosure(turn: Turn): Promise<boolean> {
    if (!turn.backgroundProgress.hasActive) return false;
    if (turn.progressPhase === "background-agents") return true;
    turn.progressPhase = "background-agents";
    turn.cancel?.();
    turn.cancel = null;
    turn.bubbleMessageId = null;
    turn.state = "none";
    turn.replacementUsed = false;
    turn.lastSentText = null;
    turn.artifactTracker?.close();
    turn.artifactTracker = null;
    turn.artifacts = [];
    await enqueue(turn);
    return true;
  }

  return {
    get size(): number {
      return turns.size;
    },

    bindTurn(input: BindTurnInput): void {
      try {
        pruneBackgroundTaskRoutes();
        const envelope = parseDirectTelegramEnvelope(input.prompt);
        const notification = envelope === null ? parseTerminalTaskNotification(input.prompt) : null;
        let chatId: string;
        let quoteMessageId: string;
        let background = false;
        let backgroundDepth = 0;
        let routeToConsume: string | null = null;
        if (envelope !== null) {
          // Session-control commands already have their own ACK/list/permission/completion UX.
          if (CONTROL_NAMESPACE.test(envelope.body) || MODEL_REPLY_CHOICE.test(envelope.body)) return;
          chatId = envelope.chatId;
          quoteMessageId = envelope.messageId;
        } else {
          if (notification === null) return;
          const directRoute = notification.toolUseId === undefined
            ? undefined : backgroundRouteKey(input.session_id, notification.toolUseId);
          const aliasRoute = notification.taskId === undefined
            ? undefined : backgroundTaskAliases.get(backgroundRouteKey(input.session_id, notification.taskId));
          routeToConsume = directRoute !== undefined && backgroundTaskRoutes.has(directRoute)
            ? directRoute : aliasRoute ?? null;
          if (routeToConsume === null) return;
          const route = backgroundTaskRoutes.get(routeToConsume);
          if (route === undefined || route.expiresAt <= now()) return;
          chatId = route.chatId;
          quoteMessageId = route.quoteMessageId;
          background = true;
          backgroundDepth = route.depth;
        }
        assertAuthorizedChat(deps.loadConfig(), chatId);
        if (routeToConsume !== null) {
          const consumed = deleteBackgroundTaskRoute(routeToConsume);
          const owner = consumed === undefined ? undefined : turns.get(consumed.ownerKey);
          const ownerChanged = owner !== undefined && consumed !== undefined
            && owner.backgroundProgress.recordTaskTerminal(consumed.toolUseId);
          if (ownerChanged && owner?.progressPhase === "background-agents") touch(owner);
        }

        // A newer direct prompt retires only older direct turns. Background completion turns
        // retain their own route and must not clobber or be clobbered by foreground work.
        if (!background) {
          for (const [existingKey, existing] of turns) {
            const activeBackground = isActiveBackground(existing);
            if (existing.chatId === chatId && !existing.background && !activeBackground) {
              drop(existing);
              turns.delete(existingKey);
            }
          }
        }

        const key = turnKey(input.session_id, input.prompt_id);
        const duplicate = turns.get(key);
        if (duplicate !== undefined) drop(duplicate);
        turns.delete(key);
        const turn: Turn = {
          chatId,
          quoteMessageId,
          background,
          backgroundDepth,
          progress: new TurnProgress({
            chatId,
            messageId: quoteMessageId,
            sessionId: input.session_id,
            promptId: input.prompt_id
          }),
          backgroundProgress: new BackgroundProgress(),
          progressPhase: "foreground",
          bubbleMessageId: null,
          state: "none",
          replacementUsed: false,
          lastSentText: null,
          cancel: null,
          cancelTyping: background ? null : deps.startTyping(chatId),
          cancelRuntimeFailureWatch: null,
          runtimeFailureAttempted: false,
          finalDeliveryAttempted: false,
          finalDeliveryRetries: 0,
          artifactTracker: null,
          artifacts: null,
          chain: Promise.resolve()
        };
        turns.set(key, turn);
        if (!background && input.transcript_path !== undefined && deps.startArtifactTracking !== undefined) {
          try {
            turn.artifactTracker = deps.startArtifactTracking(input);
          } catch {
            turn.artifactTracker = null;
          }
        }
        if (
          (envelope !== null || notification?.status === "failed")
          && input.transcript_path !== undefined
          && deps.startRuntimeFailureWatch !== undefined
          && deps.sendRuntimeFailure !== undefined
        ) {
          try {
            turn.cancelRuntimeFailureWatch = deps.startRuntimeFailureWatch(input, async failure => {
              await deliverRuntimeFailure(turn, key, failure);
            });
          } catch {
            turn.cancelRuntimeFailureWatch = null;
          }
        }
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
        if (BACKGROUND_ROUTE_TOOLS.has(input.tool_name)) {
          rememberBackgroundTaskRoute(
            input.session_id,
            input.tool_use_id,
            turnKey(input.session_id, input.prompt_id),
            turn
          );
        }
        const display = buildProgressStep(input.tool_name, input, deps.mode, input.agent_id);
        if (display === null) return;
        const backgroundChanged = input.agent_id === undefined
          ? false
          : turn.backgroundProgress.recordTool(input.agent_id, input.tool_use_id, display);
        if (turn.progressPhase === "background-agents") {
          if (backgroundChanged) touch(turn);
          return;
        }
        if (turn.background) return;
        if (turn.progress.recordTool(input.tool_use_id, display)) touch(turn);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    recordSubagentStart(input: RecordSubagentStartInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined || turn.backgroundDepth >= MAX_BACKGROUND_CHAIN_DEPTH) return;
        if (turn.backgroundProgress.recordStart(input.agent_id, input.agent_type)
          && turn.progressPhase === "background-agents") {
          touch(turn);
        }
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    recordSubagentStop(input: RecordSubagentStopInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        if (!turn.backgroundProgress.recordStop(input.agent_id)) return;
        if (turn.progressPhase !== "background-agents") return;
        turn.cancel?.();
        turn.cancel = null;
        void enqueue(turn).catch(() => undefined);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    recordSuccess(input: RecordToolSuccessInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        const launched = input.task_status === "async_launched" || input.task_status === "forked";
        let routeOwner: Turn | undefined;
        if (launched) {
          if (input.task_id !== undefined) rememberBackgroundTaskAlias(input.session_id, input.tool_use_id, input.task_id);
        } else {
          routeOwner = terminalizeBackgroundTaskRoute(input.session_id, input.tool_use_id);
        }
        const backgroundChanged = turn.backgroundProgress.recordSuccess(input.tool_use_id);
        if (turn.progressPhase === "background-agents") {
          if (backgroundChanged || routeOwner === turn) touch(turn);
          return;
        }
        if (turn.progress.recordSuccess(input.tool_use_id)) touch(turn);
        if (routeOwner !== undefined && routeOwner !== turn && routeOwner.progressPhase === "background-agents") touch(routeOwner);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    recordFailure(input: RecordToolFailureInput): void {
      try {
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return;
        const routeOwner = terminalizeBackgroundTaskRoute(input.session_id, input.tool_use_id);
        const backgroundChanged = turn.backgroundProgress.recordFailure(input.tool_use_id);
        if (turn.progressPhase === "background-agents") {
          if (backgroundChanged || routeOwner === turn) touch(turn);
          return;
        }
        if (turn.progress.recordFailure(input.tool_use_id)) touch(turn);
        if (routeOwner !== undefined && routeOwner !== turn && routeOwner.progressPhase === "background-agents") touch(routeOwner);
      } catch {
        // Never surface a disclosure failure to the agent.
      }
    },

    async finishTurn(input: FinishTurnInput): Promise<FinishTurnDisposition> {
      try {
        const key = turnKey(input.session_id, input.prompt_id);
        const turn = lookup(input.session_id, input.prompt_id);
        if (turn === undefined) return "finished";
        if (turn.progressPhase === "background-agents") {
          if (input.hook_event_name === "StopFailure") {
            await deliverRuntimeFailure(turn, key, { error: input.error });
          }
          return "finished";
        }
        await finalize(turn, input.hook_event_name);
        if (turns.get(key) !== turn) return "finished";
        if (input.hook_event_name === "StopFailure") {
          await deliverRuntimeFailure(turn, key, { error: input.error }, true);
          return "finished";
        }
        if (turn.finalDeliveryAttempted) return "finished";
        if (
          deps.deliverFinal === undefined
          || input.last_assistant_message === undefined
          || input.last_assistant_message.trim() === ""
        ) {
          if (await beginBackgroundAgentDisclosure(turn)) return "finished";
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
              collectArtifacts(turn),
              turn.background
            );
          } catch {
            outcome = "rejected";
          }
        }
        if (outcome === "too_large") {
          if (turn.finalDeliveryRetries < 1) {
            turn.finalDeliveryRetries += 1;
            turn.finalDeliveryAttempted = false;
            turn.cancelTyping = turn.background ? null : deps.startTyping(turn.chatId);
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
                [],
                turn.background
              );
            } catch {
              // The fixed fallback is attempted once; unknown outcomes are never replayed.
            }
          }
        }
        if (await beginBackgroundAgentDisclosure(turn)) return "finished";
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
