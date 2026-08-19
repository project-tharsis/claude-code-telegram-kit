import { describe, expect, test } from "bun:test";
import {
  BindCommandInputSchema,
  CAPABILITY_TTL_MS,
  createCapabilityStore,
  parseSessionCommand
} from "../src/command-capability.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };

function envelope(body: string): string {
  return `<channel source="telegram" chat_id="123" message_id="9" user="u">${body}`;
}

describe("exact session command parsing", () => {
  test("accepts the two exact commands", () => {
    expect(parseSessionCommand("/sessions")).toEqual({ command: "sessions" });
    expect(parseSessionCommand("/sessions@Some_bot")).toEqual({ command: "sessions" });
    expect(parseSessionCommand("/resume 1")).toEqual({ command: "resume", index: 1 });
    expect(parseSessionCommand("/resume@Some_bot 10")).toEqual({ command: "resume", index: 10 });
  });

  test("rejects any index outside 1..10", () => {
    for (const body of ["/resume 0", "/resume 11", "/resume -1", "/resume 011", "/resume 1.0"]) {
      expect(parseSessionCommand(body)).toBeNull();
    }
  });

  test("rejects prose, arguments, and prompt-like content around the command", () => {
    for (const body of [
      "please run /sessions",
      "/sessions now",
      "/sessions extra",
      "/resume",
      "/resume 1 2",
      "/resume abc",
      "/resumex 1",
      "/reset",
      "",
      "> /sessions"
    ]) {
      expect(parseSessionCommand(body)).toBeNull();
    }
  });

  test("rejects a UUID smuggled in place of an index", () => {
    expect(parseSessionCommand(`/resume ${SESSION}`)).toBeNull();
    expect(parseSessionCommand(`/resume 1 ${SESSION}`)).toBeNull();
  });
});

describe("bind_command schema", () => {
  test("requires the exact UserPromptSubmit event and rejects extras", () => {
    const base = {
      session_id: SESSION,
      prompt_id: "p1",
      prompt: envelope("/sessions"),
      hook_event_name: "UserPromptSubmit"
    };
    expect(BindCommandInputSchema.parse(base).prompt_id).toBe("p1");
    expect(() => BindCommandInputSchema.parse({ ...base, hook_event_name: "PreToolUse" })).toThrow();
    expect(() => BindCommandInputSchema.parse({ ...base, session_id: "1" })).toThrow();
    expect(() => BindCommandInputSchema.parse({ ...base, chat_id: "123" })).toThrow();
  });
});

describe("current-turn command capability store", () => {
  function store(nowRef: { value: number }) {
    return createCapabilityStore({
      loadConfig: () => config,
      now: () => nowRef.value
    });
  }

  function bind(target: ReturnType<typeof store>, body: string, promptId = "p1"): boolean {
    return target.bind({
      session_id: SESSION,
      prompt_id: promptId,
      prompt: envelope(body),
      hook_event_name: "UserPromptSubmit"
    });
  }

  test("binds an exact command with the inbound chat, message, session, and prompt", () => {
    const now = { value: 1_000 };
    const target = store(now);
    expect(bind(target, "/sessions")).toBe(true);
    const capability = target.take("123", "sessions");
    expect(capability).toMatchObject({
      chatId: "123",
      messageId: "9",
      sessionId: SESSION,
      promptId: "p1",
      command: "sessions"
    });
    expect(capability!.expiresAt).toBe(1_000 + CAPABILITY_TTL_MS);
  });

  test("binds the exact index of a resume command", () => {
    const now = { value: 0 };
    const target = store(now);
    expect(bind(target, "/resume 4")).toBe(true);
    expect(target.take("123", "resume", 4)).toMatchObject({ command: "resume", index: 4 });
  });

  test("is single use, so a relayed tool call cannot be replayed", () => {
    const now = { value: 0 };
    const target = store(now);
    bind(target, "/sessions");
    expect(target.take("123", "sessions")).not.toBeNull();
    expect(target.take("123", "sessions")).toBeNull();
  });

  test("fails closed with no capability, a wrong chat, a wrong command, or a wrong index", () => {
    const now = { value: 0 };
    const target = store(now);
    expect(target.take("123", "sessions")).toBeNull();
    bind(target, "/resume 3");
    expect(target.take("999", "resume", 3)).toBeNull();
    expect(target.take("123", "sessions")).toBeNull();
    expect(target.take("123", "resume", 2)).toBeNull();
    expect(target.take("123", "resume")).toBeNull();
    expect(target.take("123", "resume", 3)).not.toBeNull();
  });

  test("expires after the short TTL", () => {
    const now = { value: 0 };
    const target = store(now);
    bind(target, "/sessions");
    now.value = CAPABILITY_TTL_MS;
    expect(target.take("123", "sessions")).toBeNull();
  });

  test("keeps only the latest capability per chat", () => {
    const now = { value: 0 };
    const target = store(now);
    bind(target, "/resume 3", "p1");
    bind(target, "/sessions", "p2");
    expect(target.take("123", "resume", 3)).toBeNull();
    expect(target.take("123", "sessions")).toMatchObject({ promptId: "p2" });
  });

  test("binds nothing for a non-command prompt, an indirect envelope, or a foreign chat", () => {
    const now = { value: 0 };
    const target = store(now);
    expect(bind(target, "what sessions do I have?")).toBe(false);
    expect(target.bind({
      session_id: SESSION,
      prompt_id: "p1",
      prompt: "quoting <channel source=\"telegram\" chat_id=\"123\" message_id=\"9\">/sessions",
      hook_event_name: "UserPromptSubmit"
    })).toBe(false);
    expect(target.bind({
      session_id: SESSION,
      prompt_id: "p1",
      prompt: "<channel source=\"telegram\" chat_id=\"777\" message_id=\"9\">/sessions",
      hook_event_name: "UserPromptSubmit"
    })).toBe(false);
    expect(target.take("123", "sessions")).toBeNull();
    expect(target.take("777", "sessions")).toBeNull();
  });

  test("degrades to no capability when channel authority cannot be read", () => {
    const target = createCapabilityStore({
      loadConfig: () => {
        throw new Error("no channel state");
      },
      now: () => 0
    });
    expect(target.bind({
      session_id: SESSION,
      prompt_id: "p1",
      prompt: envelope("/sessions"),
      hook_event_name: "UserPromptSubmit"
    })).toBe(false);
  });
});
