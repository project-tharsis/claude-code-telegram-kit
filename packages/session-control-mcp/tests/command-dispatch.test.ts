import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import { CONFIRMATION } from "../src/control.js";
import { createConfirmationChallengeStore } from "../src/control-command.js";
import {
  CONTROL_CONFIRMATION_INVALID_TEXT,
  createControlCommandDispatcher,
  RESET_CHALLENGE_PREFIX,
  RESUME_CHALLENGE_PREFIX
} from "../src/command-dispatch.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const OTHER_SESSION = "4fcbaf06-4378-4339-b026-8c2e026a65e7";
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };

function input(body: string, messageId = "9", sessionId = SESSION) {
  return {
    session_id: sessionId,
    prompt_id: `p${messageId}`,
    prompt: `<channel source="plugin:telegram:telegram" chat_id="123" message_id="${messageId}">${body}</channel>`,
    hook_event_name: "UserPromptSubmit" as const
  };
}

function harness(options: { now?: () => number; sendFails?: boolean; usageFails?: boolean; config?: RuntimeConfig } = {}) {
  const sent: Array<{ chatId: string; text: string; replyTo?: string; parseMode?: "HTML" }> = [];
  const reactions: Array<[string, string, string]> = [];
  const lists: unknown[] = [];
  const usageCalls: string[] = [];
  const resumes: unknown[] = [];
  const resets: unknown[] = [];
  const challenges = createConfirmationChallengeStore({
    ...(options.now === undefined ? {} : { now: options.now }),
    randomBytes: size => new Uint8Array(size)
  });
  const dispatch = createControlCommandDispatcher({
    loadConfig: () => options.config ?? config,
    challenges,
    sendMessage: async (_cfg, chatId, text, replyTo, parseMode) => {
      if (options.sendFails) throw new Error("send failed");
      sent.push({
        chatId,
        text,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(parseMode === undefined ? {} : { parseMode })
      });
      return 100 + sent.length;
    },
    react: async (_cfg, chatId, messageId, state) => {
      reactions.push([chatId, messageId, state]);
      return true;
    },
    listSessionsTrusted: async request => {
      lists.push(request);
      return { status: "listed", count: 1, ackMessageId: 101 };
    },
    getUsage: async () => {
      usageCalls.push("usage");
      if (options.usageFails) throw new Error("usage unavailable");
      return "<b>Claude Code subscription usage</b>";
    },
    resumeSessionTrusted: async request => {
      resumes.push(request);
      return { status: "scheduled", ackMessageId: 102, unit: "resume-unit" };
    },
    resetSession: async request => {
      resets.push(request);
      return { status: "scheduled", ackMessageId: 103, unit: "reset-unit" };
    }
  });
  return { dispatch, sent, reactions, lists, usageCalls, resumes, resets };
}

describe("deterministic UserPromptSubmit control dispatcher", () => {
  test("passes ordinary Telegram messages through without any side effect", async () => {
    const h = harness();
    expect(await h.dispatch(input("please explain this"))).toEqual({ handled: false });
    expect(h.sent).toEqual([]);
    expect(h.lists).toEqual([]);
  });

  test("handles /sessions directly with exact hook-bound identity", async () => {
    const h = harness();
    expect(await h.dispatch(input("/sessions"))).toEqual({ handled: true });
    expect(h.lists).toEqual([{ chatId: "123", messageId: "9", currentSessionId: SESSION }]);
  });

  test("handles read-only /usage directly without a confirmation or LLM", async () => {
    const h = harness();
    expect(await h.dispatch(input("/usage"))).toEqual({ handled: true });
    expect(h.usageCalls).toEqual(["usage"]);
    expect(h.sent).toEqual([{
      chatId: "123",
      replyTo: "9",
      text: "<b>Claude Code subscription usage</b>",
      parseMode: "HTML"
    }]);
    expect(h.reactions).toEqual([["123", "9", "success"]]);
  });

  test("issues and consumes a single-use reset challenge before scheduling", async () => {
    const h = harness();
    expect(await h.dispatch(input("/reset", "9"))).toEqual({ handled: true });
    expect(h.resets).toEqual([]);
    expect(h.sent).toEqual([{ chatId: "123", replyTo: "9", text: `${RESET_CHALLENGE_PREFIX}\n\n/reset confirm 222222` }]);
    expect(h.reactions).toEqual([["123", "9", "success"]]);

    expect(await h.dispatch(input("/reset confirm 222222", "10"))).toEqual({ handled: true });
    expect(h.resets).toEqual([{ chat_id: "123", message_id: "10", confirmation: CONFIRMATION }]);

    await h.dispatch(input("/reset confirm 222222", "11"));
    expect(h.resets).toHaveLength(1);
    expect(h.sent.at(-1)?.text).toBe(CONTROL_CONFIRMATION_INVALID_TEXT);
    expect(h.reactions.at(-1)).toEqual(["123", "11", "failure"]);
  });

  test("stores the resume index privately and never accepts it from confirmation", async () => {
    const h = harness();
    await h.dispatch(input("/resume@ExampleAssistant 7", "20"));
    expect(h.sent.at(-1)).toEqual({
      chatId: "123",
      replyTo: "20",
      text: `${RESUME_CHALLENGE_PREFIX.replace("{index}", "7")}\n\n/resume@ExampleAssistant confirm 222222`
    });

    await h.dispatch(input("/resume@ExampleAssistant confirm 222222", "21"));
    expect(h.resumes).toEqual([{
      chatId: "123",
      messageId: "21",
      currentSessionId: SESSION,
      index: 7
    }]);
  });

  test("wrong, expired, or action-mismatched confirmation never schedules", async () => {
    let now = 1_000;
    const h = harness({ now: () => now });
    await h.dispatch(input("/reset", "30"));
    await h.dispatch(input("/resume confirm 222222", "31"));
    await h.dispatch(input("/reset confirm ABCDEF", "32"));
    now += 60_000;
    await h.dispatch(input("/reset confirm 222222", "33"));
    expect(h.resets).toEqual([]);
    expect(h.resumes).toEqual([]);
  });

  test("confirmation is bound to the Claude session that issued the challenge", async () => {
    const h = harness();
    await h.dispatch(input("/reset"));
    await h.dispatch(input("/reset confirm 222222", "10", OTHER_SESSION));

    expect(h.resets).toEqual([]);
    expect(h.sent.at(-1)!.text).toBe(CONTROL_CONFIRMATION_INVALID_TEXT);
  });

  test("destructive controls fail closed in group chats", async () => {
    const groupConfig: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["-100123"]) };
    const h = harness({ config: groupConfig });
    const group = {
      ...input("/reset"),
      prompt: '<channel source="plugin:telegram:telegram" chat_id="-100123" message_id="9">/reset</channel>'
    };

    expect(await h.dispatch(group)).toEqual({ handled: true });
    expect(h.resets).toEqual([]);
    expect(h.sent.at(-1)!.text).toContain("private Telegram chat");
  });

  test("malformed control namespace is handled with usage instead of reaching the LLM", async () => {
    const h = harness();
    for (const body of ["/reset now", "/resume 11", "/sessions please"]) {
      expect(await h.dispatch(input(body))).toEqual({ handled: true });
    }
    expect(h.lists).toEqual([]);
    expect(h.resets).toEqual([]);
    expect(h.resumes).toEqual([]);
    expect(h.reactions.every(([, , state]) => state === "failure")).toBe(true);
  });

  test("an unauthorized exact command is blocked and never dispatched", async () => {
    const h = harness();
    const foreign = { ...input("/reset"), prompt: '<channel source="plugin:telegram:telegram" chat_id="999" message_id="9">/reset</channel>' };
    expect(await h.dispatch(foreign)).toEqual({ handled: true });
    expect(h.sent).toEqual([]);
    expect(h.resets).toEqual([]);
  });

  test("a failed challenge delivery revokes the unseen code", async () => {
    const h = harness({ sendFails: true });
    expect(await h.dispatch(input("/reset", "40"))).toEqual({ handled: true });
    expect(await h.dispatch(input("/reset confirm 222222", "41"))).toEqual({ handled: true });
    expect(h.resets).toEqual([]);
  });
});
