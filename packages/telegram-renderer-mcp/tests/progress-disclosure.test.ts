import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_TASK_ROUTE_TTL_MS,
  createTurnDisclosure,
  FINAL_DRAIN_TIMEOUT_MS,
  MAX_ACTIVE_BACKGROUND_TURNS,
  MAX_RETAINED_TURNS,
  PROGRESS_DEBOUNCE_MS
} from "../src/progress-disclosure.js";
import type { FinalDeliveryOutcome } from "../src/progress-disclosure.js";
import type { ArtifactCandidate } from "../src/progress-disclosure.js";
import type {
  ProgressEditOutcome,
  ProgressSendOutcome
} from "../src/progress-transport.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import type { RuntimeFailure } from "../src/runtime-failure-watcher.js";


const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const PROMPT = "p1";
const ENVELOPE = '<channel source="telegram" chat_id="123" message_id="9" user="u">do a thing';
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };
const AUTH_FAILURE: RuntimeFailure = { error: "authentication_failed" };

interface Harness {
  disclosure: ReturnType<typeof createTurnDisclosure>;
  sends: Array<{ chatId: string; replyTo: string; text: string }>;
  edits: Array<{ messageId: number; text: string }>;
  finalDeliveries: Array<{
    chatId: string;
    messageId: string;
    content: string;
    artifacts: readonly ArtifactCandidate[];
    background?: true;
  }>;
  runtimeFailures: Array<{ chatId: string; messageId: string; error: string; resetsAt?: number }>;
  typingStarts: string[];
  typingStops: { count: number };
  delays: number[];
  tick: () => Promise<void>;
  pending: () => boolean;
}

function harness(options: {
  send?: (text: string, index: number) => ProgressSendOutcome | Promise<ProgressSendOutcome>;
  edit?: (text: string, index: number) => ProgressEditOutcome | Promise<ProgressEditOutcome>;
  finalOutcome?: FinalDeliveryOutcome | ((
    content: string,
    index: number
  ) => FinalDeliveryOutcome | Promise<FinalDeliveryOutcome>);
  config?: RuntimeConfig;
  artifacts?: readonly ArtifactCandidate[];
  now?: () => number;
  mode?: "safe" | "all" | "verbose";
} = {}): Harness {
  const sends: Harness["sends"] = [];
  const edits: Harness["edits"] = [];
  const finalDeliveries: Harness["finalDeliveries"] = [];
  const runtimeFailures: Harness["runtimeFailures"] = [];
  const typingStarts: string[] = [];
  const typingStops = { count: 0 };
  const delays: number[] = [];
  let queued: (() => Promise<void>) | null = null;

  const disclosure = createTurnDisclosure({
    loadConfig: () => options.config ?? config,
    mode: options.mode ?? "safe",
    startTyping: chatId => {
      typingStarts.push(chatId);
      return () => { typingStops.count += 1; };
    },
    startArtifactTracking: () => ({
      collect: () => [...(options.artifacts ?? [])],
      close: () => undefined
    }),
    sendRuntimeFailure: async (_config, chatId, messageId, failure) => {
      runtimeFailures.push({ chatId, messageId, ...failure });
    },
    deliverFinal: async (_config, chatId, messageId, content, artifacts, background) => {
      finalDeliveries.push({
        chatId,
        messageId,
        content,
        artifacts,
        ...(background ? { background: true as const } : {})
      });
      return typeof options.finalOutcome === "function"
        ? options.finalOutcome(content, finalDeliveries.length - 1)
        : options.finalOutcome ?? "delivered";
    },
    send: async (_config, chatId, replyTo, text) => {
      sends.push({ chatId, replyTo, text });
      return options.send?.(text, sends.length - 1) ?? { kind: "sent", messageId: 100 + sends.length };
    },
    edit: async (_config, _chatId, messageId, text) => {
      edits.push({ messageId, text });
      return options.edit?.(text, edits.length - 1) ?? { kind: "edited" };
    },
    schedule: (run, delayMs) => {
      delays.push(delayMs);
      queued = run;
      return () => {
        queued = null;
      };
    },
    ...(options.now === undefined ? {} : { now: options.now })
  });

  return {
    disclosure,
    sends,
    edits,
    finalDeliveries,
    runtimeFailures,
    typingStarts,
    typingStops,
    delays,
    pending: () => queued !== null,
    tick: async () => {
      const run = queued;
      queued = null;
      if (run) await run();
    }
  };
}

function bind(h: Harness, prompt = ENVELOPE, promptId = PROMPT): void {
  h.disclosure.bindTurn({
    session_id: SESSION,
    prompt_id: promptId,
    prompt,
    transcript_path: "/tmp/test-transcript.jsonl",
    hook_event_name: "UserPromptSubmit"
  });
}

function tool(h: Harness, toolUseId: string, toolName: string, agentId?: string): void {
  h.disclosure.recordTool({
    session_id: SESSION,
    prompt_id: PROMPT,
    tool_use_id: toolUseId,
    tool_name: toolName,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    hook_event_name: "PreToolUse"
  });
}

function agentStart(h: Harness, agentId = "agent-1", agentType = "code-review", promptId = PROMPT): void {
  h.disclosure.recordSubagentStart({
    session_id: SESSION,
    prompt_id: promptId,
    agent_id: agentId,
    agent_type: agentType,
    hook_event_name: "SubagentStart"
  });
}

async function agentStop(
  h: Harness,
  agentId = "agent-1",
  agentType = "code-review",
  promptId = PROMPT
): Promise<void> {
  const result = h.disclosure.recordSubagentStop({
    session_id: SESSION,
    prompt_id: promptId,
    agent_id: agentId,
    agent_type: agentType,
    hook_event_name: "SubagentStop"
  });
  expect(result).toBeUndefined();
  await Promise.resolve();
}

async function finish(
  h: Harness,
  event: "Stop" | "StopFailure" = "Stop",
  finalMessage = ""
): Promise<"finished" | "retry"> {
  if (event === "StopFailure") {
    return h.disclosure.finishTurn({
      session_id: SESSION,
      prompt_id: PROMPT,
      last_assistant_message: finalMessage,
      error: "unknown",
      hook_event_name: "StopFailure"
    });
  }
  return h.disclosure.finishTurn({
    session_id: SESSION,
    prompt_id: PROMPT,
    last_assistant_message: finalMessage,
    hook_event_name: "Stop"
  });
}

describe("turn disclosure lifecycle", () => {
  test("Stop auto-delivers the final assistant Markdown exactly once", async () => {
    const h = harness();
    bind(h);
    expect(await finish(h, "Stop", "**hello**")).toBe("finished");
    expect(h.finalDeliveries).toEqual([{
      chatId: "123",
      messageId: "9",
      content: "**hello**",
      artifacts: []
    }]);
    expect(await finish(h, "Stop", "**hello**")).toBe("finished");
    expect(h.finalDeliveries).toHaveLength(1);
  });

  test("opens a separate background bubble after the parent final and updates it from agent events", async () => {
    const h = harness({ mode: "verbose" });
    bind(h);
    tool(h, "toolu_background_1", "Skill");
    h.disclosure.recordSuccess({
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "toolu_background_1",
      task_status: "forked",
      task_id: "a45f9e515aa99f8c5",
      hook_event_name: "PostToolUse"
    });
    agentStart(h);
    await h.tick();

    await finish(h, "Stop", "Code review kicked off.");
    expect(h.finalDeliveries[0]?.content).toBe("Code review kicked off.");
    expect(h.pending()).toBe(false);
    expect(h.sends.at(-1)?.text).toBe([
      "Background work · 1 running…",
      "👥 code-review · Running"
    ].join("\n"));

    h.disclosure.recordTool({
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "agent-tool-1",
      tool_name: "Edit",
      agent_id: "agent-1",
      file_path: "/repo/broker.test.ts",
      hook_event_name: "PreToolUse"
    });
    await h.tick();
    expect(h.edits.at(-1)?.text).toBe([
      "Background work · 1 running…",
      "👥 code-review · Running",
      "└ 🔧 Editing broker.test.ts"
    ].join("\n"));

    await agentStop(h);
    expect(h.edits.at(-1)?.text).toBe([
      "Background work · Finalizing…",
      "✅ code-review · Done",
      "└ 🔧 Editing broker.test.ts"
    ].join("\n"));

    const notification = "<task-notification><task-id>a45f9e515aa99f8c5</task-id><status>completed</status><summary>done</summary></task-notification>";
    bind(h, notification, "p-background");
    await h.tick();
    expect(h.edits.at(-1)?.text).toBe([
      "Background work · Done",
      "✅ code-review · Done",
      "└ 🔧 Editing broker.test.ts"
    ].join("\n"));
  });

  test("does not open background disclosure when the subagent stopped before the parent", async () => {
    const h = harness();
    bind(h);
    tool(h, "toolu_foreground_agent", "Agent");
    agentStart(h);
    await agentStop(h);
    h.disclosure.recordSuccess({
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "toolu_foreground_agent",
      task_status: "completed",
      hook_event_name: "PostToolUse"
    });
    await h.tick();
    await finish(h, "Stop", "Done.");
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.text).toContain("Delegating");
  });

  test("a newer direct turn does not retire a pending parent before lifecycle start", async () => {
    const h = harness();
    bind(h);
    tool(h, "toolu_pending_parent", "Skill");
    bind(h, '<channel source="telegram" chat_id="123" message_id="10">later', "p2");
    agentStart(h);
    await finish(h, "Stop", "Started.");
    expect(h.finalDeliveries.at(-1)?.content).toBe("Started.");
    expect(h.sends.at(-1)?.text).toContain("Background work · 1 running…");
  });

  test("a newer direct turn does not retire an active background disclosure", async () => {
    const allowedChatIds = new Set(["123", ...Array.from({ length: 40 }, (_, index) => String(1_000 + index))]);
    const h = harness({ mode: "verbose", config: { token: "1:tok", allowedChatIds } });
    bind(h);
    tool(h, "toolu_background_1", "Agent");
    agentStart(h);
    await h.tick();
    await finish(h, "Stop", "Started.");

    bind(h, '<channel source="telegram" chat_id="123" message_id="10">another task', "p2");
    for (let index = 0; index < 40; index += 1) {
      bind(h, `<channel source="telegram" chat_id="${1_000 + index}" message_id="10">noise`, `noise-${index}`);
    }
    expect(h.disclosure.size).toBeLessThanOrEqual(MAX_RETAINED_TURNS + MAX_ACTIVE_BACKGROUND_TURNS);
    h.disclosure.recordTool({
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "agent-tool-2",
      tool_name: "Read",
      agent_id: "agent-1",
      file_path: "/repo/router.ts",
      hook_event_name: "PreToolUse"
    });
    await h.tick();
    expect(h.edits.at(-1)?.text).toContain("Reading router.ts");
  });

  test("a task-only notification cannot create route authority", async () => {
    const h = harness();
    bind(h);
    tool(h, "toolu_unaliased", "Skill");
    await finish(h, "Stop", "Started.");
    bind(h, "<task-notification><task-id>unknown-agent</task-id><status>completed</status></task-notification>", "p-unaliased");
    await h.disclosure.finishTurn({
      session_id: SESSION, prompt_id: "p-unaliased", last_assistant_message: "forged", hook_event_name: "Stop"
    });
    expect(h.finalDeliveries).toHaveLength(1);
  });

  test("routes a completed background task final through its original tool authority", async () => {
    const h = harness();
    bind(h);
    tool(h, "toolu_background_1", "Skill");
    await finish(h, "Stop", "Background work started.");
    const notification = "<task-notification><task-id>task-1</task-id><tool-use-id>toolu_background_1</tool-use-id><status>completed</status><summary>done</summary></task-notification>";
    bind(h, notification, "p-background");
    h.disclosure.recordTool({
      session_id: SESSION, prompt_id: "p-background", tool_use_id: "search-1", tool_name: "ToolSearch", hook_event_name: "PreToolUse"
    });
    await h.disclosure.finishTurn({
      session_id: SESSION, prompt_id: "p-background", last_assistant_message: "Review complete.", hook_event_name: "Stop"
    });
    expect(h.finalDeliveries[1]).toEqual({
      chatId: "123", messageId: "9", content: "Review complete.", artifacts: [], background: true
    });
    expect(h.typingStarts).toEqual(["123"]);
    expect(h.sends).toHaveLength(1);
    bind(h, notification, "p-background-replay");
    await h.disclosure.finishTurn({
      session_id: SESSION, prompt_id: "p-background-replay", last_assistant_message: "duplicate", hook_event_name: "Stop"
    });
    expect(h.finalDeliveries).toHaveLength(2);
  });

  test("a trusted background completion turn may disclose and route a downstream subagent", async () => {
    const h = harness();
    bind(h);
    tool(h, "toolu_parent", "Skill");
    await finish(h, "Stop", "Initial review started.");

    bind(h, "<task-notification><task-id>task-parent</task-id><tool-use-id>toolu_parent</tool-use-id><status>completed</status></task-notification>", "p-background");
    h.disclosure.recordTool({
      session_id: SESSION,
      prompt_id: "p-background",
      tool_use_id: "toolu_child",
      tool_name: "Skill",
      hook_event_name: "PreToolUse"
    });
    agentStart(h, "agent-child", "code-review", "p-background");
    await h.disclosure.finishTurn({
      session_id: SESSION,
      prompt_id: "p-background",
      last_assistant_message: "Re-review started.",
      hook_event_name: "Stop"
    });
    expect(h.finalDeliveries.at(-1)).toMatchObject({
      content: "Re-review started.",
      background: true
    });
    expect(h.sends.at(-1)?.text).toContain("code-review · Running");

    bind(h, "<task-notification><task-id>task-child</task-id><tool-use-id>toolu_child</tool-use-id><status>completed</status></task-notification>", "p-child-complete");
    h.disclosure.recordTool({ session_id: SESSION, prompt_id: "p-child-complete", tool_use_id: "toolu_overflow", tool_name: "Agent", hook_event_name: "PreToolUse" });
    agentStart(h, "agent-overflow", "reviewer", "p-child-complete");
    await h.disclosure.finishTurn({
      session_id: SESSION,
      prompt_id: "p-child-complete",
      last_assistant_message: "Re-review clean.",
      hook_event_name: "Stop"
    });
    expect(h.finalDeliveries.at(-1)).toMatchObject({
      content: "Re-review clean.",
      background: true
    });
    const deliveriesAtLimit = h.finalDeliveries.length;
    bind(h, "<task-notification><task-id>overflow</task-id><tool-use-id>toolu_overflow</tool-use-id><status>completed</status></task-notification>", "p-overflow");
    await h.disclosure.finishTurn({ session_id: SESSION, prompt_id: "p-overflow", last_assistant_message: "must not route", hook_event_name: "Stop" });
    expect(h.finalDeliveries).toHaveLength(deliveriesAtLimit);
  });

  test("expires background task routes instead of retaining authority forever", async () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    bind(h);
    tool(h, "toolu_expiring", "Skill");
    await finish(h, "Stop", "started");
    clock = BACKGROUND_TASK_ROUTE_TTL_MS + 1;
    bind(h, "<task-notification><task-id>task-2</task-id><tool-use-id>toolu_expiring</tool-use-id><status>completed</status></task-notification>", "p-expired");
    await h.disclosure.finishTurn({
      session_id: SESSION, prompt_id: "p-expired", last_assistant_message: "must not send", hook_event_name: "Stop"
    });
    expect(h.finalDeliveries).toHaveLength(1);
  });

  test("delivers Artifact candidates collected from the bound transcript at Stop", async () => {
    const artifact: ArtifactCandidate = {
      sessionId: SESSION,
      path: `/tmp/claude-1000/project/${SESSION}/scratchpad/report.html`,
      description: "Report"
    };
    const h = harness({ artifacts: [artifact] });
    bind(h);

    expect(await finish(h, "Stop", "Report attached.")).toBe("finished");
    expect(h.finalDeliveries[0]!.artifacts).toEqual([artifact]);
  });

  test("concurrent replayed Stop hooks reserve one final delivery before network I/O", async () => {
    let release!: (outcome: FinalDeliveryOutcome) => void;
    let markStarted!: () => void;
    const pending = new Promise<FinalDeliveryOutcome>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const h = harness({
      finalOutcome: () => {
        markStarted();
        return pending;
      }
    });
    bind(h);
    const first = finish(h, "Stop", "hello");
    await started;
    const replay = finish(h, "Stop", "hello");
    expect(h.finalDeliveries).toHaveLength(1);
    release("delivered");
    await expect(first).resolves.toBe("finished");
    await expect(replay).resolves.toBe("finished");
    expect(h.finalDeliveries).toHaveLength(1);
  });

  test("only the final-delivery owner may open the background phase", async () => {
    let release!: (outcome: FinalDeliveryOutcome) => void;
    let markStarted!: () => void;
    const pending = new Promise<FinalDeliveryOutcome>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const h = harness({
      finalOutcome: () => {
        markStarted();
        return pending;
      }
    });
    bind(h);
    tool(h, "toolu_background_race", "Agent");
    agentStart(h);
    await h.tick();
    const first = finish(h, "Stop", "Started.");
    await started;
    await finish(h, "Stop", "Started.");
    expect(h.sends).toHaveLength(1);
    release("delivered");
    await first;
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]?.text).toContain("Background work");
  });

  test("a Stop awaiting progress drain cannot deliver after a newer turn supersedes it", async () => {
    let releaseSend!: (outcome: ProgressSendOutcome) => void;
    const pendingSend = new Promise<ProgressSendOutcome>(resolve => { releaseSend = resolve; });
    const h = harness({ send: () => pendingSend });
    bind(h, ENVELOPE, "p-old");
    h.disclosure.recordTool({
      session_id: SESSION,
      prompt_id: "p-old",
      tool_use_id: "t-old",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    });
    const firstFlush = h.tick();
    await Promise.resolve();
    const stopping = h.disclosure.finishTurn({
      session_id: SESSION,
      prompt_id: "p-old",
      last_assistant_message: "stale final",
      hook_event_name: "Stop"
    });
    bind(h, '<channel source="telegram" chat_id="123" message_id="10">new turn', "p-new");
    releaseSend({ kind: "sent", messageId: 101 });
    await Promise.all([firstFlush, stopping]);
    expect(h.finalDeliveries).toEqual([]);
  });


  test("typed StopFailure sends one operational notice and never delivers assistant text", async () => {
    const h = harness();
    bind(h);
    expect(await finish(h, "StopFailure", "must not send")).toBe("finished");
    expect(h.finalDeliveries).toEqual([]);
    expect(h.runtimeFailures).toEqual([{ chatId: "123", messageId: "9", error: "unknown" }]);
    expect(await finish(h, "StopFailure", "duplicate")).toBe("finished");
    expect(h.runtimeFailures).toHaveLength(1);
  });

  test("maps a semantic oversized final to retry before transport", async () => {
    const h = harness();
    bind(h);
    expect(await finish(h, "Stop", "x".repeat(100_001))).toBe("retry");
    expect(h.finalDeliveries).toEqual([]);
    expect(h.typingStarts).toEqual(["123", "123"]);
  });

  test("a second semantic oversized final sends the fixed fallback once", async () => {
    const h = harness();
    bind(h);
    expect(await finish(h, "Stop", "x".repeat(100_001))).toBe("retry");
    expect(await finish(h, "Stop", "y".repeat(100_001))).toBe("finished");
    expect(h.finalDeliveries.map(item => item.content)).toEqual([
      "The response was too long to deliver. Ask for a shorter answer."
    ]);
  });

  test("a local oversized final asks Claude to shorten once, then delivers the replacement", async () => {
    const h = harness({
      finalOutcome: (_content, index) => index === 0 ? "too_large" : "delivered"
    });
    bind(h);
    expect(await finish(h, "Stop", "x".repeat(5_000))).toBe("retry");
    expect(h.typingStarts).toEqual(["123", "123"]);
    expect(await finish(h, "Stop", "shorter")).toBe("finished");
    expect(h.finalDeliveries.map(item => item.content)).toEqual(["x".repeat(5_000), "shorter"]);
  });

  test("a second oversized final ends the retry loop with one fixed short fallback", async () => {
    const outcomes: FinalDeliveryOutcome[] = ["too_large", "too_large", "delivered"];
    const h = harness({ finalOutcome: (_content, index) => outcomes[index]! });
    bind(h);
    expect(await finish(h, "Stop", "x".repeat(5_000))).toBe("retry");
    expect(await finish(h, "Stop", "y".repeat(5_000))).toBe("finished");
    expect(h.finalDeliveries).toHaveLength(3);
    expect(h.finalDeliveries[2]!.content).toBe(
      "The response was too long to deliver. Ask for a shorter answer."
    );
  });

  test("an uncertain final delivery is never replayed", async () => {
    const h = harness({ finalOutcome: "uncertain" });
    bind(h);
    expect(await finish(h, "Stop", "hello")).toBe("finished");
    expect(await finish(h, "Stop", "hello")).toBe("finished");
    expect(h.finalDeliveries).toHaveLength(1);
  });

  test("failed task notification uses its exact route to send one runtime notice", async () => {
    let fireRuntimeFailure: ((failure: RuntimeFailure) => Promise<void>) | null = null;
    let watchStarts = 0;
    let watchCancels = 0;
    const typingStops = { count: 0 };
    const alerts: Array<{ chatId: string; messageId: string; failure: RuntimeFailure }> = [];
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => { typingStops.count += 1; },
      startRuntimeFailureWatch: (_input, onFailure) => {
        watchStarts += 1;
        fireRuntimeFailure = onFailure;
        return () => { watchCancels += 1; };
      },
      sendRuntimeFailure: async (_config, chatId, messageId, failure) => {
        alerts.push({ chatId, messageId, failure });
      },
      send: async () => ({ kind: "sent", messageId: 1 }),
      edit: async () => ({ kind: "edited" }),
      schedule: () => () => undefined
    });
    disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: "p-auth-failure",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">hello</channel>',
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    });
    disclosure.recordTool({
      session_id: SESSION, prompt_id: "p-auth-failure", tool_use_id: "toolu_failed", tool_name: "Skill", hook_event_name: "PreToolUse"
    });
    disclosure.recordTool({
      session_id: SESSION, prompt_id: "p-auth-failure", tool_use_id: "toolu_complete", tool_name: "Skill", hook_event_name: "PreToolUse"
    });
    await disclosure.finishTurn({
      session_id: SESSION, prompt_id: "p-auth-failure", last_assistant_message: "Started.", hook_event_name: "Stop"
    });
    disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: "p-runtime-complete",
      prompt: "<task-notification><task-id>task-complete</task-id><tool-use-id>toolu_complete</tool-use-id><status>completed</status></task-notification>",
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    });
    expect(watchStarts).toBe(1);
    await disclosure.finishTurn({
      session_id: SESSION, prompt_id: "p-runtime-complete", last_assistant_message: "Done.", hook_event_name: "Stop"
    });
    disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: "p-runtime-failure",
      prompt: "<task-notification><task-id>task-failed</task-id><tool-use-id>toolu_failed</tool-use-id><status>failed</status><summary>secret</summary></task-notification>",
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    });
    expect(watchStarts).toBe(2);
    expect(fireRuntimeFailure).not.toBeNull();
    await fireRuntimeFailure!({ error: "rate_limit", resetsAt: 1_787_555_400 });
    expect(alerts).toEqual([{
      chatId: "123", messageId: "9", failure: { error: "rate_limit", resetsAt: 1_787_555_400 }
    }]);
    expect(typingStops.count).toBe(1);
    expect(watchCancels).toBe(2);
    expect(disclosure.size).toBe(0);
  });

  test("runtime auth failure closes an existing progress bubble before the explanation", async () => {
    let fireRuntimeFailure: ((failure: RuntimeFailure) => Promise<void>) | null = null;
    const events: string[] = [];
    let queued: (() => Promise<void>) | null = null;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startRuntimeFailureWatch: (_input, onFailure) => {
        fireRuntimeFailure = onFailure;
        return () => undefined;
      },
      sendRuntimeFailure: async () => { events.push("runtime-explanation"); },
      send: async () => ({ kind: "sent", messageId: 101 }),
      edit: async (_config, _chatId, _messageId, text) => {
        events.push(text.startsWith("Failed") ? "bubble-failed" : "bubble-other");
        return { kind: "edited" };
      },
      schedule: (run) => {
        queued = run;
        return () => { queued = null; };
      }
    });
    disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: "p-auth-bubble",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">hello</channel>',
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    });
    disclosure.recordTool({
      session_id: SESSION,
      prompt_id: "p-auth-bubble",
      tool_use_id: "t1",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    });
    await queued!();
    await fireRuntimeFailure!(AUTH_FAILURE);
    expect(events).toEqual(["bubble-failed", "runtime-explanation"]);
  });

  test("runtime auth failure serializes a Failed edit behind an in-flight first send", async () => {
    let fireRuntimeFailure: ((failure: RuntimeFailure) => Promise<void>) | null = null;
    let releaseSend!: (outcome: ProgressSendOutcome) => void;
    const pendingSend = new Promise<ProgressSendOutcome>(resolve => { releaseSend = resolve; });
    const events: string[] = [];
    let queued: (() => Promise<void>) | null = null;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startRuntimeFailureWatch: (_input, onFailure) => {
        fireRuntimeFailure = onFailure;
        return () => undefined;
      },
      sendRuntimeFailure: async () => { events.push("runtime-explanation"); },
      send: async () => {
        events.push("send-start");
        return pendingSend;
      },
      edit: async (_config, _chatId, _messageId, text) => {
        events.push(text.startsWith("Failed") ? "bubble-failed" : "bubble-other");
        return { kind: "edited" };
      },
      schedule: (run) => {
        queued = run;
        return () => { queued = null; };
      }
    });
    disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: "p-auth-race",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">hello</channel>',
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    });
    disclosure.recordTool({
      session_id: SESSION,
      prompt_id: "p-auth-race",
      tool_use_id: "t1",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    });
    const firstFlush = queued!();
    await Promise.resolve();
    expect(events).toEqual(["send-start"]);
    const recovery = fireRuntimeFailure!(AUTH_FAILURE);
    await Promise.resolve();
    expect(events).toEqual(["send-start"]);
    releaseSend({ kind: "sent", messageId: 101 });
    await Promise.all([firstFlush, recovery]);
    expect(events).toEqual(["send-start", "bubble-failed", "runtime-explanation"]);
  });

  test("normal Stop cancels the bounded auth watcher without sending an auth explanation", async () => {
    let watchCancels = 0;
    let alerts = 0;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startRuntimeFailureWatch: () => () => { watchCancels += 1; },
      sendRuntimeFailure: async () => { alerts += 1; },
      send: async () => ({ kind: "sent", messageId: 1 }),
      edit: async () => ({ kind: "edited" }),
      schedule: () => () => undefined
    });
    disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: "p-normal",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">hello</channel>',
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    });
    await disclosure.finishTurn({
      session_id: SESSION,
      prompt_id: "p-normal",
      hook_event_name: "Stop"
    });
    expect(watchCancels).toBe(1);
    expect(alerts).toBe(0);
  });

  test("typed StopFailure cancels the fallback watcher and suppresses a late duplicate", async () => {
    let fireRuntimeFailure: ((failure: RuntimeFailure) => Promise<void>) | null = null;
    let watchCancels = 0;
    let alerts = 0;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startRuntimeFailureWatch: (_input, onFailure) => {
        fireRuntimeFailure = onFailure;
        return () => { watchCancels += 1; };
      },
      sendRuntimeFailure: async () => { alerts += 1; },
      send: async () => ({ kind: "sent", messageId: 1 }),
      edit: async () => ({ kind: "edited" }),
      schedule: () => () => undefined
    });
    disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: "p-stop-failure",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">hello</channel>',
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    });
    await disclosure.finishTurn({
      session_id: SESSION,
      prompt_id: "p-stop-failure",
      last_assistant_message: "",
      error: "authentication_failed",
      hook_event_name: "StopFailure"
    });
    expect(watchCancels).toBe(1);
    expect(alerts).toBe(1);
    await fireRuntimeFailure!(AUTH_FAILURE);
    expect(alerts).toBe(1);
  });

  test("a superseded watch cannot send a late auth error for the replacement turn", async () => {
    const callbacks: Array<(failure: RuntimeFailure) => Promise<void>> = [];
    let cancels = 0;
    let alerts = 0;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startRuntimeFailureWatch: (_input, onFailure) => {
        callbacks.push(onFailure);
        return () => { cancels += 1; };
      },
      sendRuntimeFailure: async () => { alerts += 1; },
      send: async () => ({ kind: "sent", messageId: 1 }),
      edit: async () => ({ kind: "edited" }),
      schedule: () => () => undefined
    });
    const bindInput = {
      session_id: SESSION,
      prompt_id: "p-replayed",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">hello</channel>',
      transcript_path: `/tmp/${SESSION}.jsonl`,
      hook_event_name: "UserPromptSubmit"
    } as const;
    disclosure.bindTurn(bindInput);
    disclosure.bindTurn(bindInput);
    expect(callbacks).toHaveLength(2);
    expect(cancels).toBe(1);
    await callbacks[0]!(AUTH_FAILURE);
    expect(alerts).toBe(0);
    await callbacks[1]!(AUTH_FAILURE);
    expect(alerts).toBe(1);
    disclosure.bindTurn({ ...bindInput, prompt_id: "p-next" });
    expect(callbacks).toHaveLength(3);
    await callbacks[2]!(AUTH_FAILURE);
    expect(alerts).toBe(1);
  });

  test("incident cap never evicts a live dedupe entry", async () => {
    const callbacks: Array<(failure: RuntimeFailure) => Promise<void>> = [];
    const allowedChatIds = new Set(Array.from({ length: 33 }, (_, index) => String(1_000 + index)));
    let alerts = 0;
    const disclosure = createTurnDisclosure({
      loadConfig: () => ({ token: "1:tok", allowedChatIds }),
      mode: "safe",
      startTyping: () => () => undefined,
      startRuntimeFailureWatch: (_input, onFailure) => { callbacks.push(onFailure); return () => undefined; },
      sendRuntimeFailure: async () => { alerts += 1; },
      send: async () => ({ kind: "sent", messageId: 1 }),
      edit: async () => ({ kind: "edited" }),
      schedule: () => () => undefined,
      now: () => 0
    });
    for (let index = 0; index < 33; index += 1) {
      disclosure.bindTurn({
        session_id: SESSION, prompt_id: `incident-${index}`,
        prompt: `<channel source="plugin:telegram:telegram" chat_id="${1_000 + index}" message_id="9">x</channel>`,
        transcript_path: `/tmp/${SESSION}.jsonl`, hook_event_name: "UserPromptSubmit"
      });
      await callbacks[index]!(AUTH_FAILURE);
    }
    expect(alerts).toBe(32);
    disclosure.bindTurn({
      session_id: SESSION, prompt_id: "incident-retry",
      prompt: '<channel source="plugin:telegram:telegram" chat_id="1000" message_id="10">x</channel>',
      transcript_path: `/tmp/${SESSION}.jsonl`, hook_event_name: "UserPromptSubmit"
    });
    await callbacks[33]!(AUTH_FAILURE);
    expect(alerts).toBe(32);
  });

  test("starts sustained typing on bind and stops it on final cleanup", async () => {
    const h = harness();
    bind(h);
    expect(h.typingStarts).toEqual(["123"]);
    await finish(h);
    expect(h.typingStops.count).toBe(1);
  });

  test("a no-tool turn never creates a bubble", async () => {
    const h = harness();
    bind(h);
    await finish(h);
    expect(h.sends).toEqual([]);
    expect(h.edits).toEqual([]);
  });

  test("an unbound turn ignores tool events entirely", async () => {
    const h = harness();
    tool(h, "t1", "Read");
    await h.tick();
    await finish(h);
    expect(h.sends).toEqual([]);
  });

  test("a prompt without a direct Telegram envelope binds nothing", async () => {
    const h = harness();
    bind(h, "please read the file");
    tool(h, "t1", "Read");
    await h.tick();
    expect(h.sends).toEqual([]);
  });

  test("control slash commands never create tool-progress bubbles", async () => {
    for (const body of [
      "/sessions",
      "/usage",
      "/model",
      "/model opus",
      "/model@ExampleAssistant sonnet",
      "/model fable",
      "/rename Auth flow",
      "/rename",
      "1 · Opus",
      "2 · Sonnet",
      "3 · Haiku",
      "4 · Inherit",
      "5 · Cancel",
      "/reset extra",
      "/resume 1",
      "/resume@ExampleAssistant 10",
      "/resume confirm ABC234",
      "/resume@ExampleAssistant confirm ABC234",
      "/reset",
      "/reset@ExampleAssistant",
      "/reset confirm ABC234",
      "/reset@ExampleAssistant confirm ABC234"
    ]) {
      const h = harness();
      bind(h, `<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">${body}`);
      tool(h, "t1", "ToolSearch");
      await h.tick();
      await finish(h);
      expect(h.sends).toEqual([]);
    }
  });

  test("conversational session requests still disclose real tool work", async () => {
    const h = harness();
    bind(h, '<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">please list sessions');
    tool(h, "t1", "Bash");
    await h.tick();
    expect(h.sends.length).toBe(1);
  });

  test("an unauthorized chat binds nothing", async () => {
    const h = harness({ config: { token: "1:tok", allowedChatIds: new Set(["777"]) } });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    expect(h.sends).toEqual([]);
  });

  test("sends one silent bubble quoting the inbound message after the debounce", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    expect(h.sends).toEqual([]);
    expect(h.delays).toEqual([PROGRESS_DEBOUNCE_MS]);
    await h.tick();
    expect(h.sends).toEqual([{ chatId: "123", replyTo: "9", text: "Cogitating…\n📖 Reading" }]);
  });

  test("coalesces a burst into one debounced flush and one bubble", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    tool(h, "t2", "Grep");
    tool(h, "t3", "Bash");
    expect(h.delays).toEqual([PROGRESS_DEBOUNCE_MS]);
    await h.tick();
    expect(h.sends.length).toBe(1);
    expect(h.sends[0]!.text).toBe("Cogitating…\n📖 Reading\n🔎 Searching code\n💻 terminal");
  });

  test("serializes Stop behind an in-flight debounced send without a duplicate bubble", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const h = harness({
      send: async () => {
        await gate;
        return { kind: "sent", messageId: 101 };
      }
    });
    bind(h);
    tool(h, "t1", "Read");

    const firstFlush = h.tick();
    await Promise.resolve();
    const finalFlush = finish(h);
    release();
    await Promise.all([firstFlush, finalFlush]);

    expect(h.sends.length).toBe(1);
    expect(h.edits).toEqual([{ messageId: 101, text: "Cogitated\n📖 Reading" }]);
  });

  test("later steps edit the same bubble instead of sending another", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    expect(h.sends.length).toBe(1);
    expect(h.edits).toEqual([{ messageId: 101, text: "Cogitating…\n📖 Reading\n💻 terminal" }]);
  });

  test("filters internal sidecar tools and discloses subagent internals", async () => {
    const h = harness();
    bind(h);
    tool(h, "t0", "mcp__telegram-renderer__finish_turn");
    tool(h, "t1", "Task");
    tool(h, "t2", "Read", "agent-1");
    tool(h, "t3", "Bash", "agent-1");
    tool(h, "t4", "mcp__session-control__dispatch_command", "agent-1");
    await h.tick();
    expect(h.sends[0]!.text).toBe(
      "Cogitating…\n👥 Delegating\n📖 Reading\n💻 terminal"
    );
  });

  test("dedupes a repeated tool_use_id across flushes", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t1", "Read");
    expect(h.pending()).toBe(false);
    await h.tick();
    expect(h.edits).toEqual([]);
  });

  test("marks a failure by tool_use_id and drains it on finish", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Bash");
    await h.tick();
    h.disclosure.recordFailure({
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "t1",
      hook_event_name: "PostToolUseFailure"
    });
    await finish(h);
    expect(h.edits.at(-1)!.text).toBe("Cogitated\n❌ 💻 terminal");
  });

  test("finish drains without waiting for the debounce timer", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await finish(h);
    expect(h.sends.length).toBe(1);
    expect(h.sends[0]!.text).toBe("Cogitated\n📖 Reading");
    expect(h.pending()).toBe(false);
  });

  test("a failed stop uses its own header", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await finish(h, "StopFailure");
    expect(h.sends[0]!.text).toBe("Failed\n❌ 📖 Reading");
  });

  test("late events after close change nothing", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await finish(h);
    const sent = h.sends.length;
    const edited = h.edits.length;
    tool(h, "t9", "Bash");
    await h.tick();
    await finish(h);
    expect(h.sends.length).toBe(sent);
    expect(h.edits.length).toBe(edited);
  });

  test("a new turn supersedes the previous one and never edits its bubble", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    bind(h, ENVELOPE, "p2");
    h.disclosure.recordTool({
      session_id: SESSION,
      prompt_id: "p2",
      tool_use_id: "u1",
      tool_name: "Bash",
      hook_event_name: "PreToolUse"
    });
    await h.tick();
    expect(h.edits).toEqual([]);
    expect(h.sends.length).toBe(2);
    expect(h.sends[1]!.text).toBe("Sautéing…\n💻 terminal");
  });

  test("a second message in the same session still binds progress", async () => {
    const h = harness();
    bind(h, ENVELOPE, "p1");
    bind(h, ENVELOPE, "p2");
    h.disclosure.recordTool({
      session_id: SESSION,
      prompt_id: "p2",
      tool_use_id: "u1",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    });
    await h.tick();
    expect(h.sends).toEqual([{ chatId: "123", replyTo: "9", text: "Sautéing…\n📖 Reading" }]);
  });
});

describe("turn disclosure failure handling", () => {
  test("an uncertain send never produces a duplicate for the rest of the turn", async () => {
    const h = harness({ send: () => ({ kind: "uncertain" }) });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    await finish(h);
    expect(h.sends.length).toBe(1);
    expect(h.edits).toEqual([]);
  });

  test("a rejected send is not retried", async () => {
    const h = harness({ send: () => ({ kind: "rejected" }) });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await finish(h);
    expect(h.sends.length).toBe(1);
  });

  test("a transient edit failure keeps identity and catches up later", async () => {
    let first = true;
    const h = harness({
      edit: () => {
        if (first) {
          first = false;
          return { kind: "transient" };
        }
        return { kind: "edited" };
      }
    });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    expect(h.edits.length).toBe(1);
    await finish(h);
    expect(h.sends.length).toBe(1);
    expect(h.edits.length).toBe(2);
    expect(h.edits[1]!.messageId).toBe(101);
    expect(h.edits[1]!.text).toBe("Cogitated\n📖 Reading\n💻 terminal");
  });

  test("a flood-controlled edit abandons disclosure for the rest of the turn", async () => {
    const h = harness({ edit: () => ({ kind: "throttled" }) });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    expect(h.edits.length).toBe(1);
    tool(h, "t3", "Write");
    expect(h.pending()).toBe(false);
    await expect(finish(h)).resolves.toBe("finished");
    expect(h.edits.length).toBe(1);
  });

  test("a gone bubble is replaced at most once per turn", async () => {
    const h = harness({ edit: () => ({ kind: "gone" }) });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    expect(h.sends.length).toBe(2);
    tool(h, "t3", "Write");
    await h.tick();
    await finish(h);
    expect(h.sends.length).toBe(2);
  });

  test("a permanently rejected edit stops editing without a replacement send", async () => {
    const h = harness({ edit: () => ({ kind: "rejected" }) });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    await finish(h);
    expect(h.sends.length).toBe(1);
    expect(h.edits.length).toBe(1);
  });

  test("an unchanged edit is treated as current and not repeated", async () => {
    const h = harness({ edit: () => ({ kind: "unchanged" }) });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    await finish(h);
    expect(h.edits.length).toBe(2);
  });

  test("a transport that throws never propagates out of a hook", async () => {
    const h = harness();
    const throwing = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      send: async () => {
        throw new Error("boom");
      },
      edit: async () => {
        throw new Error("boom");
      },
      schedule: () => () => undefined
    });
    throwing.bindTurn({
      session_id: SESSION,
      prompt_id: PROMPT,
      prompt: ENVELOPE,
      hook_event_name: "UserPromptSubmit"
    });
    throwing.recordTool({
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "t1",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    });
    await expect(throwing.finishTurn({
      session_id: SESSION,
      prompt_id: PROMPT,
      hook_event_name: "Stop"
    })).resolves.toBe("finished");
    expect(h.sends).toEqual([]);
  });

  test("finish bounds its final drain so a slow transport cannot block Stop", async () => {
    let finishedEdits = 0;
    const h = harness({
      edit: async () => {
        await new Promise(resolve => setTimeout(resolve, FINAL_DRAIN_TIMEOUT_MS + 500));
        finishedEdits += 1;
        return { kind: "edited" };
      }
    });
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();

    const started = Date.now();
    await finish(h);
    expect(Date.now() - started).toBeLessThan(FINAL_DRAIN_TIMEOUT_MS + 300);
    expect(finishedEdits).toBe(0);
  });

  test("a config that cannot be loaded degrades to silence", async () => {
    const disclosure = createTurnDisclosure({
      loadConfig: () => {
        throw new Error("bad state");
      },
      mode: "safe",
      startTyping: () => () => undefined,
      send: async () => ({ kind: "sent", messageId: 1 }),
      edit: async () => ({ kind: "edited" }),
      schedule: () => () => undefined
    });
    expect(() => disclosure.bindTurn({
      session_id: SESSION,
      prompt_id: PROMPT,
      prompt: ENVELOPE,
      hook_event_name: "UserPromptSubmit"
    })).not.toThrow();
  });

  test("bounds retained turns so a long session cannot grow without limit", async () => {
    const h = harness();
    for (let index = 0; index < 200; index += 1) {
      h.disclosure.bindTurn({
        session_id: SESSION,
        prompt_id: `p${index}`,
        prompt: ENVELOPE,
        hook_event_name: "UserPromptSubmit"
      });
    }
    expect(h.disclosure.size).toBeLessThanOrEqual(32);
  });
});
