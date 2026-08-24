import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import { CONFIRMATION } from "../src/control.js";
import { createControlMessageClaims } from "../src/usage-queue-watcher.js";
import { createConfirmationChallengeStore } from "../src/control-command.js";
import {
  CONTROL_CONFIRMATION_INVALID_TEXT,
  CONTROL_OPERATION_FAILED_TEXT,
  createControlCommandDispatcher,
  PRIVATE_CONTROL_ONLY_TEXT,
  RESET_CHALLENGE_PREFIX,
  RESUME_CHALLENGE_PREFIX
} from "../src/command-dispatch.js";
import {
  MODEL_REPLY_KEYBOARD,
  REMOVE_MODEL_REPLY_KEYBOARD
} from "../src/model-reply-keyboard.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const OTHER_SESSION = "4fcbaf06-4378-4339-b026-8c2e026a65e7";
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };

function input(body: string, messageId = "9", sessionId = SESSION, timestamp?: string) {
  const ts = timestamp === undefined ? "" : ` ts="${timestamp}"`;
  return {
    session_id: sessionId,
    prompt_id: `p${messageId}`,
    prompt: `<channel source="plugin:telegram:telegram" chat_id="123" message_id="${messageId}"${ts}>${body}</channel>`,
    hook_event_name: "UserPromptSubmit" as const
  };
}

function harness(options: {
  now?: () => number;
  sendFails?: boolean;
  usageFails?: boolean;
  modelFails?: boolean;
  usageQueueAttested?: boolean;
  config?: RuntimeConfig;
} = {}) {
  const sent: Array<{
    chatId: string;
    text: string;
    replyTo?: string;
    parseMode?: "HTML";
    replyMarkup?: Record<string, unknown>;
  }> = [];
  const reactions: Array<[string, string, string]> = [];
  const lists: unknown[] = [];
  const usageCalls: string[] = [];
  const modelStatusCalls: string[] = [];
  const modelSwitches: unknown[] = [];
  const renameCalls: unknown[] = [];
  const resumes: unknown[] = [];
  const resets: unknown[] = [];
  const challenges = createConfirmationChallengeStore({
    ...(options.now === undefined ? {} : { now: options.now }),
    randomBytes: size => new Uint8Array(size)
  });
  const claims = createControlMessageClaims();
  const dispatch = createControlCommandDispatcher({
    claimControlMessage: claims.claim,
    usageQueueAttested: options.usageQueueAttested ?? false,
    now: options.now ?? Date.now,
    loadConfig: () => options.config ?? config,
    challenges,
    sendMessage: async (_cfg, chatId, text, replyTo, parseMode, replyMarkup) => {
      if (options.sendFails) throw new Error("send failed");
      sent.push({
        chatId,
        text,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(parseMode === undefined ? {} : { parseMode }),
        ...(replyMarkup === undefined ? {} : { replyMarkup })
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
    getModelStatus: async sessionId => {
      modelStatusCalls.push(sessionId);
      return "<b>Claude model</b>\nCurrent · <code>claude-opus-5</code>";
    },
    switchModel: async request => {
      modelSwitches.push(request);
      if (options.modelFails) throw new Error("systemd rejected");
      return { status: "scheduled", unit: "model-unit" };
    },
    renameSessionTitle: async request => { renameCalls.push(request); },
    resumeSessionTrusted: async request => {
      resumes.push(request);
      return { status: "scheduled", ackMessageId: 102, unit: "resume-unit" };
    },
    resetSession: async request => {
      resets.push(request);
      return { status: "scheduled", ackMessageId: 103, unit: "reset-unit" };
    }
  });
  return {
    dispatch, sent, reactions, lists, usageCalls,
    modelStatusCalls, modelSwitches, renameCalls, resumes, resets
  };
}

describe("deterministic UserPromptSubmit control dispatcher", () => {
  test("passes ordinary Telegram messages through without any side effect", async () => {
    const h = harness();
    expect(await h.dispatch(input("please explain this"))).toEqual({ handled: false });
    expect(h.sent).toEqual([]);
    expect(h.lists).toEqual([]);
  });

  test("handles /resume and legacy /sessions directly with exact hook-bound identity", async () => {
    const h = harness();
    for (const command of ["/resume", "/sessions"]) {
      expect(await h.dispatch(input(command))).toEqual({ handled: true });
    }
    expect(h.lists).toEqual([
      { chatId: "123", messageId: "9", currentSessionId: SESSION },
      { chatId: "123", messageId: "9", currentSessionId: SESSION }
    ]);
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

  test("blocks a stale queued usage hook without sending a late snapshot", async () => {
    const now = Date.parse("2026-08-24T07:13:40.000Z");
    const h = harness({ now: () => now });
    expect(await h.dispatch(input(
      "/usage", "9", SESSION, "2026-08-24T06:00:00.000Z"
    ))).toEqual({ handled: true });
    expect(h.usageCalls).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("deduplicates the same usage message across watcher and hook dispatch", async () => {
    const h = harness({ usageQueueAttested: true });
    expect(await h.dispatch(input("/usage"), "queue")).toEqual({ handled: true });
    expect(await h.dispatch(input("/usage"), "hook")).toEqual({ handled: true });
    expect(h.usageCalls).toEqual(["usage"]);
    expect(h.sent).toHaveLength(1);
  });

  test("lists current model state and schedules an allowlisted switch without the LLM", async () => {
    const h = harness();
    expect(await h.dispatch(input("/model"))).toEqual({ handled: true });
    expect(h.modelStatusCalls).toEqual([SESSION]);
    expect(h.sent.at(-1)?.text).toContain("claude-opus-5");
    expect(h.sent.at(-1)?.parseMode).toBe("HTML");
    expect(h.sent.at(-1)?.replyMarkup).toEqual(MODEL_REPLY_KEYBOARD);
    expect(MODEL_REPLY_KEYBOARD.keyboard).toEqual([
      [{ text: "1 · Opus" }, { text: "2 · Sonnet" }],
      [{ text: "3 · Haiku" }, { text: "4 · Inherit" }],
      [{ text: "5 · Cancel" }]
    ]);

    expect(await h.dispatch(input("5 · Cancel", "10"))).toEqual({ handled: true });
    expect(h.modelSwitches).toEqual([]);
    expect(h.sent.at(-1)).toMatchObject({
      chatId: "123",
      replyTo: "10",
      text: "<i>Model selection closed.</i>",
      replyMarkup: REMOVE_MODEL_REPLY_KEYBOARD
    });
    expect(h.reactions.at(-1)).toEqual(["123", "10", "success"]);

    expect(await h.dispatch(input("2 · Sonnet", "11"))).toEqual({ handled: true });
    expect(h.modelSwitches).toEqual([{ chatId: "123", messageId: "11", model: "sonnet" }]);
    expect(h.sent.at(-1)).toMatchObject({ chatId: "123", replyTo: "11" });
    expect(h.sent.at(-1)?.replyMarkup).toEqual(REMOVE_MODEL_REPLY_KEYBOARD);
    expect(h.sent.at(-1)?.parseMode).toBe("HTML");
    expect(h.reactions.at(-1)).toEqual(["123", "11", "success"]);
  });

  test("renames the exact current session without the LLM", async () => {
    const h = harness();
    expect(await h.dispatch(input("/rename Model routing controls", "12"))).toEqual({ handled: true });
    expect(h.renameCalls).toEqual([{ sessionId: SESSION, title: "Model routing controls" }]);
    expect(h.sent.at(-1)).toEqual({
      chatId: "123",
      replyTo: "12",
      parseMode: "HTML",
      text: "<b>Session renamed</b>\n<code>Model routing controls</code>"
    });
    expect(h.reactions.at(-1)).toEqual(["123", "12", "success"]);
  });

  test("reports a rejected model scheduler after a truthful pending acknowledgement", async () => {
    const h = harness({ modelFails: true });
    expect(await h.dispatch(input("/model haiku", "11"))).toEqual({ handled: true });
    expect(h.modelSwitches).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]!.text).toContain("requested");
    expect(h.sent[1]!.text).toBe(CONTROL_OPERATION_FAILED_TEXT);
    expect(h.reactions.at(-1)).toEqual(["123", "11", "failure"]);
  });

  test("issues and consumes a single-use reset challenge before scheduling", async () => {
    const h = harness();
    expect(await h.dispatch(input("/reset", "9"))).toEqual({ handled: true });
    expect(h.resets).toEqual([]);
    expect(h.sent).toEqual([{
      chatId: "123",
      replyTo: "9",
      parseMode: "HTML",
      text: `${RESET_CHALLENGE_PREFIX}\n\n<code>/reset confirm 222222</code>`
    }]);
    expect(h.reactions).toEqual([["123", "9", "success"]]);

    expect(await h.dispatch(input("/reset confirm 222222", "10"))).toEqual({ handled: true });
    expect(h.resets).toEqual([{ chat_id: "123", message_id: "10", current_session_id: SESSION, confirmation: CONFIRMATION }]);

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
      parseMode: "HTML",
      text: `${RESUME_CHALLENGE_PREFIX.replace("{index}", "7")}\n\n`
        + "<code>/resume@ExampleAssistant confirm 222222</code>"
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
    expect(await h.dispatch({
      ...input("/model sonnet", "10"),
      prompt: '<channel source="plugin:telegram:telegram" chat_id="-100123" message_id="10">/model sonnet</channel>'
    })).toEqual({ handled: true });
    expect(h.modelSwitches).toEqual([]);
    expect(await h.dispatch({
      ...input("5 · Cancel", "11"),
      prompt: '<channel source="plugin:telegram:telegram" chat_id="-100123" message_id="11">5 · Cancel</channel>'
    })).toEqual({ handled: true });
    expect(h.sent.at(-1)).toMatchObject({
      chatId: "-100123",
      replyTo: "11",
      text: "<i>Model selection closed.</i>",
      replyMarkup: REMOVE_MODEL_REPLY_KEYBOARD
    });
    expect(h.modelSwitches).toEqual([]);
    expect(await h.dispatch({
      ...input("/rename Group title", "12"),
      prompt: '<channel source="plugin:telegram:telegram" chat_id="-100123" message_id="12">/rename Group title</channel>'
    })).toEqual({ handled: true });
    expect(h.renameCalls).toEqual([]);
    expect(h.sent.at(-1)!.text).toBe(PRIVATE_CONTROL_ONLY_TEXT);
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
