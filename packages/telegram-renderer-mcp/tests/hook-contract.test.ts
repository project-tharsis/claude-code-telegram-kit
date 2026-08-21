import { describe, expect, test } from "bun:test";
import {
  BindTurnInputSchema,
  FinishTurnInputSchema,
  parseDirectTelegramEnvelope,
  RecordToolFailureInputSchema,
  RecordToolInputSchema
} from "../src/hook-contract.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const PROMPT = "9a1f2b3c-0000-4000-8000-0123456789ab";

describe("direct Telegram envelope parsing", () => {
  test("accepts an exact leading channel envelope", () => {
    const parsed = parseDirectTelegramEnvelope(
      '<channel source="telegram" chat_id="123456" message_id="42" user="x" ts="1">hello</channel>'
    );
    expect(parsed).toEqual({ chatId: "123456", messageId: "42", body: "hello" });
  });

  test("accepts the official plugin-scoped Telegram source emitted by Claude Code", () => {
    const parsed = parseDirectTelegramEnvelope(
      '<channel source="plugin:telegram:telegram" chat_id="123456" message_id="42">/sessions</channel>'
    );
    expect(parsed).toEqual({ chatId: "123456", messageId: "42", body: "/sessions" });
  });

  test("accepts a negative group chat_id and leading whitespace", () => {
    const parsed = parseDirectTelegramEnvelope(
      '\n  <channel source="telegram" chat_id="-100123" message_id="7">  /sessions  '
    );
    expect(parsed?.chatId).toBe("-100123");
    expect(parsed?.body).toBe("/sessions");
  });

  test("rejects an envelope that is not at the start of the prompt", () => {
    expect(parseDirectTelegramEnvelope(
      'quoted text <channel source="telegram" chat_id="1" message_id="2">hi'
    )).toBeNull();
  });

  test("rejects a second embedded channel tag", () => {
    expect(parseDirectTelegramEnvelope(
      '<channel source="telegram" chat_id="1" message_id="2">see <channel source="telegram" chat_id="9" message_id="9">'
    )).toBeNull();
  });

  test("rejects a non-telegram source", () => {
    expect(parseDirectTelegramEnvelope(
      '<channel source="slack" chat_id="1" message_id="2">hi'
    )).toBeNull();
    expect(parseDirectTelegramEnvelope(
      '<channel source="plugin:telegram:telegram-evil" chat_id="1" message_id="2">hi'
    )).toBeNull();
  });

  test("rejects a lossy or non-positive message_id", () => {
    expect(parseDirectTelegramEnvelope(
      '<channel source="telegram" chat_id="1" message_id="0">hi'
    )).toBeNull();
    expect(parseDirectTelegramEnvelope(
      `<channel source="telegram" chat_id="1" message_id="${"9".repeat(20)}">hi`
    )).toBeNull();
  });

  test("rejects an unterminated or oversized tag", () => {
    expect(parseDirectTelegramEnvelope('<channel source="telegram" chat_id="1" ')).toBeNull();
    expect(parseDirectTelegramEnvelope(
      `<channel source="telegram" chat_id="1" message_id="2" pad="${"x".repeat(2000)}">hi`
    )).toBeNull();
  });

  test("rejects empty input", () => {
    expect(parseDirectTelegramEnvelope("")).toBeNull();
  });
});

describe("internal hook tool schemas", () => {
  test("bind_turn requires the exact UserPromptSubmit event and bounds the transcript path", () => {
    const base = {
      session_id: SESSION,
      prompt_id: PROMPT,
      prompt: "hi",
      transcript_path: "/home/user/.claude/projects/project/session.jsonl",
      hook_event_name: "UserPromptSubmit"
    };
    expect(BindTurnInputSchema.parse(base).transcript_path).toBe(base.transcript_path);
    expect(() => BindTurnInputSchema.parse({ ...base, transcript_path: "x".repeat(8_193) })).toThrow();
    expect(() => BindTurnInputSchema.parse({ ...base, hook_event_name: "PreToolUse" })).toThrow();
    expect(() => BindTurnInputSchema.parse({ ...base, hook_event_name: "" })).toThrow();
  });

  test("bind_turn rejects unknown properties and empty template substitutions", () => {
    const base = { session_id: SESSION, prompt_id: PROMPT, prompt: "hi", hook_event_name: "UserPromptSubmit" };
    expect(() => BindTurnInputSchema.parse({ ...base, tool_input: { a: 1 } })).toThrow();
    expect(BindTurnInputSchema.parse({ ...base, transcript_path: "" }).transcript_path).toBeUndefined();
    expect(() => BindTurnInputSchema.parse({ ...base, session_id: "" })).toThrow();
    expect(() => BindTurnInputSchema.parse({ ...base, prompt_id: "" })).toThrow();
  });

  test("record_tool accepts an optional agent_id and rejects raw tool_input", () => {
    const base = {
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "toolu_01ABC",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    };
    expect(RecordToolInputSchema.parse(base).agent_id).toBeUndefined();
    expect(RecordToolInputSchema.parse({ ...base, agent_id: "" }).agent_id).toBeUndefined();
    expect(RecordToolInputSchema.parse({ ...base, agent_id: "agent-1" }).agent_id).toBe("agent-1");
    expect(RecordToolInputSchema.parse({ ...base, skill: "requesting-code-review" }).skill)
      .toBe("requesting-code-review");
    expect(() => RecordToolInputSchema.parse({ ...base, tool_input: { file_path: "/etc/passwd" } })).toThrow();
    expect(() => RecordToolInputSchema.parse({ ...base, hook_event_name: "PostToolUse" })).toThrow();
  });

  test("record_tool_failure keys on tool_use_id and its own event", () => {
    const base = {
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "toolu_01ABC",
      hook_event_name: "PostToolUseFailure"
    };
    expect(RecordToolFailureInputSchema.parse(base).tool_use_id).toBe("toolu_01ABC");
    expect(() => RecordToolFailureInputSchema.parse({ ...base, hook_event_name: "PreToolUse" })).toThrow();
    expect(() => RecordToolFailureInputSchema.parse({ ...base, error: "ENOENT /srv/secret" })).toThrow();
  });

  test("finish_turn accepts bounded final text only for Stop lifecycle payloads", () => {
    const base = {
      session_id: SESSION,
      prompt_id: PROMPT,
      last_assistant_message: "**done**",
      hook_event_name: "Stop"
    };
    expect(FinishTurnInputSchema.parse(base).last_assistant_message).toBe("**done**");
    expect(FinishTurnInputSchema.parse({
      ...base,
      last_assistant_message: "",
      hook_event_name: "StopFailure"
    }).hook_event_name).toBe("StopFailure");
    expect(() => FinishTurnInputSchema.parse({ ...base, hook_event_name: "SubagentStop" })).toThrow();
    expect(() => FinishTurnInputSchema.parse({ ...base, last_assistant_message: "x".repeat(100_001) })).toThrow();
  });

  test("identifier fields are bounded and character-restricted", () => {
    const base = {
      session_id: SESSION,
      prompt_id: PROMPT,
      tool_use_id: "toolu_01",
      tool_name: "Read",
      hook_event_name: "PreToolUse"
    };
    expect(() => RecordToolInputSchema.parse({ ...base, tool_name: "x".repeat(200) })).toThrow();
    expect(() => RecordToolInputSchema.parse({ ...base, tool_name: "Read\nWrite" })).toThrow();
    expect(() => RecordToolInputSchema.parse({ ...base, tool_use_id: "a b" })).toThrow();
    expect(() => RecordToolInputSchema.parse({ ...base, session_id: "not-a-uuid" })).toThrow();
  });
});
