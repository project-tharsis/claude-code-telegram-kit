import { describe, expect, test } from "bun:test";
import {
  createTurnDisclosure,
  FINAL_DRAIN_TIMEOUT_MS,
  PROGRESS_DEBOUNCE_MS
} from "../src/progress-disclosure.js";
import type { FinalDeliveryOutcome } from "../src/progress-disclosure.js";
import type {
  ProgressEditOutcome,
  ProgressSendOutcome
} from "../src/progress-transport.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";


const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const PROMPT = "p1";
const ENVELOPE = '<channel source="telegram" chat_id="123" message_id="9" user="u">do a thing';
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };

interface Harness {
  disclosure: ReturnType<typeof createTurnDisclosure>;
  sends: Array<{ chatId: string; replyTo: string; text: string }>;
  edits: Array<{ messageId: number; text: string }>;
  finalDeliveries: Array<{ chatId: string; messageId: string; content: string }>;
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
} = {}): Harness {
  const sends: Harness["sends"] = [];
  const edits: Harness["edits"] = [];
  const finalDeliveries: Harness["finalDeliveries"] = [];
  const typingStarts: string[] = [];
  const typingStops = { count: 0 };
  const delays: number[] = [];
  let queued: (() => Promise<void>) | null = null;

  const disclosure = createTurnDisclosure({
    loadConfig: () => options.config ?? config,
    mode: "safe",
    startTyping: chatId => {
      typingStarts.push(chatId);
      return () => { typingStops.count += 1; };
    },
    deliverFinal: async (_config, chatId, messageId, content) => {
      finalDeliveries.push({ chatId, messageId, content });
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
    }
  });

  return {
    disclosure,
    sends,
    edits,
    finalDeliveries,
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

async function finish(
  h: Harness,
  event: "Stop" | "StopFailure" = "Stop",
  finalMessage = ""
): Promise<"finished" | "retry"> {
  return h.disclosure.finishTurn({
    session_id: SESSION,
    prompt_id: PROMPT,
    last_assistant_message: finalMessage,
    hook_event_name: event
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
      content: "**hello**"
    }]);
    expect(await finish(h, "Stop", "**hello**")).toBe("finished");
    expect(h.finalDeliveries).toHaveLength(1);
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

  test("a legacy send_reply reservation suppresses Stop auto-delivery", async () => {
    const h = harness();
    bind(h);
    await h.disclosure.finalizeChat("123");
    expect(await finish(h, "Stop", "must not duplicate")).toBe("finished");
    expect(h.finalDeliveries).toEqual([]);
  });

  test("StopFailure never delivers assistant text", async () => {
    const h = harness();
    bind(h);
    expect(await finish(h, "StopFailure", "must not send")).toBe("finished");
    expect(h.finalDeliveries).toEqual([]);
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

  test("runtime auth failure retires the turn, stops typing, and sends one quoted explanation", async () => {
    let fireAuthFailure: (() => Promise<void>) | null = null;
    let watchCancels = 0;
    const typingStops = { count: 0 };
    const alerts: Array<{ chatId: string; messageId: string }> = [];
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => { typingStops.count += 1; },
      startAuthFailureWatch: (_input, onFailure) => {
        fireAuthFailure = onFailure;
        return () => { watchCancels += 1; };
      },
      sendAuthFailure: async (_config, chatId, messageId) => {
        alerts.push({ chatId, messageId });
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
    expect(fireAuthFailure).not.toBeNull();
    await fireAuthFailure!();
    expect(alerts).toEqual([{ chatId: "123", messageId: "9" }]);
    expect(typingStops.count).toBe(1);
    expect(watchCancels).toBe(1);
    expect(disclosure.size).toBe(0);
  });

  test("runtime auth failure closes an existing progress bubble before the explanation", async () => {
    let fireAuthFailure: (() => Promise<void>) | null = null;
    const events: string[] = [];
    let queued: (() => Promise<void>) | null = null;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startAuthFailureWatch: (_input, onFailure) => {
        fireAuthFailure = onFailure;
        return () => undefined;
      },
      sendAuthFailure: async () => { events.push("auth-explanation"); },
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
    await fireAuthFailure!();
    expect(events).toEqual(["bubble-failed", "auth-explanation"]);
  });

  test("runtime auth failure serializes a Failed edit behind an in-flight first send", async () => {
    let fireAuthFailure: (() => Promise<void>) | null = null;
    let releaseSend!: (outcome: ProgressSendOutcome) => void;
    const pendingSend = new Promise<ProgressSendOutcome>(resolve => { releaseSend = resolve; });
    const events: string[] = [];
    let queued: (() => Promise<void>) | null = null;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startAuthFailureWatch: (_input, onFailure) => {
        fireAuthFailure = onFailure;
        return () => undefined;
      },
      sendAuthFailure: async () => { events.push("auth-explanation"); },
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
    const recovery = fireAuthFailure!();
    await Promise.resolve();
    expect(events).toEqual(["send-start"]);
    releaseSend({ kind: "sent", messageId: 101 });
    await Promise.all([firstFlush, recovery]);
    expect(events).toEqual(["send-start", "bubble-failed", "auth-explanation"]);
  });

  test("normal Stop cancels the bounded auth watcher without sending an auth explanation", async () => {
    let watchCancels = 0;
    let alerts = 0;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startAuthFailureWatch: () => () => { watchCancels += 1; },
      sendAuthFailure: async () => { alerts += 1; },
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

  test("StopFailure leaves the bounded watcher alive for a late exact auth row", async () => {
    let fireAuthFailure: (() => Promise<void>) | null = null;
    let watchCancels = 0;
    let alerts = 0;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startAuthFailureWatch: (_input, onFailure) => {
        fireAuthFailure = onFailure;
        return () => { watchCancels += 1; };
      },
      sendAuthFailure: async () => { alerts += 1; },
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
      hook_event_name: "StopFailure"
    });
    expect(watchCancels).toBe(0);
    await fireAuthFailure!();
    expect(alerts).toBe(1);
    expect(watchCancels).toBe(1);
  });

  test("a superseded watch cannot send a late auth error for the replacement turn", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    let cancels = 0;
    let alerts = 0;
    const disclosure = createTurnDisclosure({
      loadConfig: () => config,
      mode: "safe",
      startTyping: () => () => undefined,
      startAuthFailureWatch: (_input, onFailure) => {
        callbacks.push(onFailure);
        return () => { cancels += 1; };
      },
      sendAuthFailure: async () => { alerts += 1; },
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
    await callbacks[0]!();
    expect(alerts).toBe(0);
    await callbacks[1]!();
    expect(alerts).toBe(1);
  });

  test("starts sustained typing on bind and stops it on final/send cleanup", async () => {
    const h = harness();
    bind(h);
    expect(h.typingStarts).toEqual(["123"]);
    await h.disclosure.finalizeChat("123");
    expect(h.typingStops.count).toBe(1);
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
    expect(h.sends).toEqual([{ chatId: "123", replyTo: "9", text: "Working…\n• … Read file" }]);
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
    expect(h.sends[0]!.text).toBe("Working…\n• … Read file\n• … Search code\n• … Run command");
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
    expect(h.edits).toEqual([{ messageId: 101, text: "Done\n• ✓ Read file" }]);
  });

  test("later steps edit the same bubble instead of sending another", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await h.tick();
    tool(h, "t2", "Bash");
    await h.tick();
    expect(h.sends.length).toBe(1);
    expect(h.edits).toEqual([{ messageId: 101, text: "Working…\n• … Read file\n• … Run command" }]);
  });

  test("filters internal sidecar tools and collapses subagent internals", async () => {
    const h = harness();
    bind(h);
    tool(h, "t0", "mcp__telegram-renderer__send_reply");
    tool(h, "t1", "Task");
    tool(h, "t2", "Read", "agent-1");
    tool(h, "t3", "Bash", "agent-1");
    tool(h, "t4", "mcp__session-control__list_sessions", "agent-1");
    await h.tick();
    expect(h.sends[0]!.text).toBe("Working…\n• … Delegate work ×3");
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
    expect(h.edits.at(-1)!.text).toBe("Done\n• ✕ Run command");
  });

  test("finish drains without waiting for the debounce timer", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await finish(h);
    expect(h.sends.length).toBe(1);
    expect(h.sends[0]!.text).toBe("Done\n• ✓ Read file");
    expect(h.pending()).toBe(false);
  });

  test("a failed stop uses its own header", async () => {
    const h = harness();
    bind(h);
    tool(h, "t1", "Read");
    await finish(h, "StopFailure");
    expect(h.sends[0]!.text).toBe("Failed\n• ✕ Read file");
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
    expect(h.sends[1]!.text).toBe("Working…\n• … Run command");
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
    expect(h.sends).toEqual([{ chatId: "123", replyTo: "9", text: "Working…\n• … Read file" }]);
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
    expect(h.edits[1]!.text).toBe("Done\n• ✓ Read file\n• ✓ Run command");
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
