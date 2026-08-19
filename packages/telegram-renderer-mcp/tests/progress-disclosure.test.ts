import { describe, expect, test } from "bun:test";
import {
  createTurnDisclosure,
  FINAL_DRAIN_TIMEOUT_MS,
  PROGRESS_DEBOUNCE_MS
} from "../src/progress-disclosure.js";
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
  typingStarts: string[];
  typingStops: { count: number };
  delays: number[];
  tick: () => Promise<void>;
  pending: () => boolean;
}

function harness(options: {
  send?: (text: string, index: number) => ProgressSendOutcome | Promise<ProgressSendOutcome>;
  edit?: (text: string, index: number) => ProgressEditOutcome | Promise<ProgressEditOutcome>;
  config?: RuntimeConfig;
} = {}): Harness {
  const sends: Harness["sends"] = [];
  const edits: Harness["edits"] = [];
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

async function finish(h: Harness, event: "Stop" | "StopFailure" = "Stop"): Promise<void> {
  await h.disclosure.finishTurn({
    session_id: SESSION,
    prompt_id: PROMPT,
    hook_event_name: event
  });
}

describe("turn disclosure lifecycle", () => {
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
    await expect(finish(h)).resolves.toBeUndefined();
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
    })).resolves.toBeUndefined();
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
