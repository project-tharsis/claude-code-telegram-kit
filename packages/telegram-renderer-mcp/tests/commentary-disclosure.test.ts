import { describe, expect, test } from "bun:test";
import {
  createTurnDisclosure,
  type FinalDeliveryOutcome
} from "../src/progress-disclosure.js";
import { createCommentaryDisplayBuffer, type CommentaryBlock } from "../src/commentary-display.js";
import type {
  CommentarySendOutcome,
  ProgressEditOutcome,
  ProgressSendOutcome
} from "../src/progress-transport.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const PROMPT = "p1";
const ENVELOPE = '<channel source="telegram" chat_id="123" message_id="9">do work';
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123", "124"]) };

interface Harness {
  disclosure: ReturnType<typeof createTurnDisclosure>;
  events: string[];
  edits: string[];
  commentaryAttempts: number;
  tick(): Promise<void>;
}

function harness(options: {
  displayBuffer?: boolean;
  commentaryByTool?: Record<string, CommentaryBlock[]>;
  commentaryOutcomes?: CommentarySendOutcome[];
  finalOutcome?: FinalDeliveryOutcome;
} = {}): Harness {
  const events: string[] = [];
  const edits: string[] = [];
  const reserved = new Set<string>();
  let nextBubbleId = 100;
  let commentaryAttempts = 0;
  let queued: (() => Promise<void>) | null = null;
  const disclosure = createTurnDisclosure({
    loadConfig: () => config,
    mode: "safe",
    startTyping: () => () => undefined,
    startArtifactTracking: () => ({ collect: () => [], close: () => undefined }),
    startCommentaryBuffer: () => options.displayBuffer
      ? createCommentaryDisplayBuffer(SESSION)
      : ({
          add: () => undefined,
          collectBeforeTool: toolUseId => (options.commentaryByTool?.[toolUseId] ?? [])
            .filter(block => !reserved.has(block.key)),
          reserve: key => { reserved.add(key); },
          close: () => undefined
        }),
    deliverCommentary: async (_config, _chatId, _messageId, content) => {
      events.push(`commentary:${content}`);
      const outcome = options.commentaryOutcomes?.[commentaryAttempts] ?? "delivered";
      commentaryAttempts += 1;
      return outcome;
    },
    deliverFinal: async (_config, _chatId, _messageId, content) => {
      events.push(`final:${content}`);
      return options.finalOutcome ?? "delivered";
    },
    send: async (_config, _chatId, _replyTo, text): Promise<ProgressSendOutcome> => {
      nextBubbleId += 1;
      events.push(`bubble-send:${nextBubbleId}:${text.split("\n", 1)[0]}`);
      return { kind: "sent", messageId: nextBubbleId };
    },
    edit: async (_config, _chatId, messageId, text): Promise<ProgressEditOutcome> => {
      edits.push(text);
      events.push(`bubble-edit:${messageId}:${text.split("\n", 1)[0]}`);
      return { kind: "edited" };
    },
    schedule: run => {
      queued = run;
      return () => { queued = null; };
    }
  });
  disclosure.bindTurn({
    session_id: SESSION,
    prompt_id: PROMPT,
    prompt: ENVELOPE,
    transcript_path: "/tmp/test-transcript.jsonl",
    hook_event_name: "UserPromptSubmit"
  });
  return {
    disclosure,
    events,
    edits,
    get commentaryAttempts() { return commentaryAttempts; },
    tick: async () => {
      const run = queued;
      queued = null;
      if (run !== null) await run();
    }
  };
}

async function tool(h: Harness, id: string, name = "Read"): Promise<void> {
  await h.disclosure.recordTool({
    session_id: SESSION,
    prompt_id: PROMPT,
    tool_use_id: id,
    tool_name: name,
    hook_event_name: "PreToolUse"
  });
}

function success(h: Harness, id: string): void {
  h.disclosure.recordSuccess({
    session_id: SESSION,
    prompt_id: PROMPT,
    tool_use_id: id,
    hook_event_name: "PostToolUse"
  });
}

function failure(h: Harness, id: string): void {
  h.disclosure.recordFailure({
    session_id: SESSION,
    prompt_id: PROMPT,
    tool_use_id: id,
    hook_event_name: "PostToolUseFailure"
  });
}

async function finish(h: Harness, text = "done"): Promise<void> {
  await h.disclosure.finishTurn({
    session_id: SESSION,
    prompt_id: PROMPT,
    last_assistant_message: text,
    hook_event_name: "Stop"
  });
}

function display(h: Harness, prompt_id: string, delta: string, agent_id?: string): void {
  h.disclosure.recordMessageDisplay({
    session_id: SESSION,
    prompt_id,
    agent_id,
    turn_id: `turn-${prompt_id}`,
    message_id: `message-${prompt_id}-${agent_id ?? "main"}`,
    index: 0,
    final: true,
    delta,
    hook_event_name: "MessageDisplay"
  });
}

describe("semantic commentary rail", () => {
  test("MessageDisplay completion is committed by the later PreToolUse boundary", async () => {
    const h = harness({ displayBuffer: true });
    h.disclosure.recordMessageDisplay({
      session_id: SESSION,
      prompt_id: PROMPT,
      turn_id: "turn-1",
      message_id: "message-1",
      index: 0,
      final: true,
      delta: "Displayed commentary.",
      hook_event_name: "MessageDisplay"
    });
    await tool(h, "t1");
    expect(h.events[0]).toBe("commentary:Displayed commentary.");
    await finish(h);
    expect(h.events.at(-1)).toBe("final:done");
  });

  test("routes display by exact prompt and drops subagent text", async () => {
    const h = harness({ displayBuffer: true });
    h.disclosure.bindTurn({ session_id: SESSION, prompt_id: "p2", prompt: '<channel source="telegram" chat_id="124" message_id="10">other', hook_event_name: "UserPromptSubmit" });
    display(h, "p2", "wrong prompt");
    display(h, PROMPT, "subagent", "agent-1");
    display(h, PROMPT, "right prompt");
    await tool(h, "t1");
    expect(h.events).toEqual(["commentary:right prompt"]);
  });

  test("MessageDisplay text with no later tool is discarded at Stop", async () => {
    const h = harness({ displayBuffer: true });
    h.disclosure.recordMessageDisplay({
      session_id: SESSION,
      prompt_id: PROMPT,
      turn_id: "turn-1",
      message_id: "message-final",
      index: 0,
      final: true,
      delta: "Canonical final.",
      hook_event_name: "MessageDisplay"
    });
    await finish(h, "Canonical final.");
    expect(h.events).toEqual(["final:Canonical final."]);
  });

  test("commentary before the first tool is delivered before the first progress bubble", async () => {
    const h = harness({ commentaryByTool: { t1: [{ key: "k1", text: "Planning first." }] } });
    await tool(h, "t1");
    expect(h.events).toEqual(["commentary:Planning first."]);
    await h.tick();
    expect(h.events[1]).toMatch(/^bubble-send:101:/);
    await finish(h);
    expect(h.events.at(-1)).toBe("final:done");
  });

  test("seals segment A before commentary and opens a distinct segment B bubble", async () => {
    const h = harness({ commentaryByTool: { t2: [{ key: "k1", text: "Found the seam." }] } });
    await tool(h, "t1");
    await h.tick();
    success(h, "t1");
    await tool(h, "t2", "Bash");
    const commentaryIndex = h.events.indexOf("commentary:Found the seam.");
    expect(commentaryIndex).toBeGreaterThan(0);
    expect(h.events.slice(0, commentaryIndex)).toContain("bubble-edit:101:Cogitated");
    await h.tick();
    expect(h.events.some(event => event.startsWith("bubble-send:102:"))).toBe(true);
    success(h, "t2");
    await finish(h);
    const afterCommentary = h.events.slice(commentaryIndex + 1);
    expect(afterCommentary.some(event => event.startsWith("bubble-edit:101:"))).toBe(false);
    expect(h.events.at(-1)).toBe("final:done");
  });

  test("parallel tool hooks reserve one boundary and dedupe replay turn-wide", async () => {
    const boundary = [{ key: "same-boundary", text: "One update." }];
    const h = harness({ commentaryByTool: { t1: boundary, t2: boundary } });
    await Promise.all([tool(h, "t1"), tool(h, "t2", "Bash")]);
    await tool(h, "t1");
    expect(h.commentaryAttempts).toBe(1);
    await h.tick();
    expect(h.events.filter(event => event.startsWith("bubble-send:"))).toHaveLength(1);
    await finish(h);
    expect(h.events.filter(event => event.startsWith("final:"))).toHaveLength(1);
  });

  test("mixed concurrent hooks keep the no-commentary tool in the newly opened segment", async () => {
    const h = harness({ commentaryByTool: {
      t1: [{ key: "boundary", text: "Boundary." }]
    } });
    await Promise.all([tool(h, "t1"), tool(h, "t2", "Bash")]);
    await h.tick();
    const editsBeforeFailure = h.edits.length;
    failure(h, "t2");
    await h.tick();
    expect(h.edits).toHaveLength(editsBeforeFailure + 1);
    expect(h.edits.at(-1)).toContain("❌");
    await finish(h);
  });

  test("multiple commentary boundaries preserve ordered commentary and bubble segments", async () => {
    const h = harness({ commentaryByTool: {
      t1: [{ key: "k1", text: "First update." }],
      t2: [{ key: "k2", text: "Second update." }]
    } });
    await tool(h, "t1");
    await h.tick();
    success(h, "t1");
    await tool(h, "t2", "Bash");
    await h.tick();
    await finish(h);
    expect(h.events.filter(event => event.startsWith("commentary:"))).toEqual([
      "commentary:First update.",
      "commentary:Second update."
    ]);
    expect(h.events.filter(event => event.startsWith("bubble-send:"))).toHaveLength(2);
    expect(h.events.indexOf("commentary:First update.")).toBeLessThan(
      h.events.findIndex(event => event.startsWith("bubble-send:101:"))
    );
    expect(h.events.indexOf("commentary:Second update.")).toBeLessThan(
      h.events.findIndex(event => event.startsWith("bubble-send:102:"))
    );
    expect(h.events.at(-1)).toBe("final:done");
  });

  test("uncertain and rejected commentary are each attempted once and never block final", async () => {
    for (const outcome of ["uncertain", "rejected"] as const) {
      const boundary = [{ key: "k1", text: "Interim." }];
      const h = harness({ commentaryByTool: { t1: boundary, t2: boundary }, commentaryOutcomes: [outcome] });
      await tool(h, "t1");
      await tool(h, "t2");
      expect(h.commentaryAttempts).toBe(1);
      await finish(h);
      expect(h.events.filter(event => event.startsWith("final:"))).toEqual(["final:done"]);
    }
  });

  test("assistant text with no later tool remains canonical final only", async () => {
    const h = harness();
    await finish(h, "only final");
    expect(h.commentaryAttempts).toBe(0);
    expect(h.events).toEqual(["final:only final"]);
  });
});
