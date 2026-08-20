import { describe, expect, test } from "bun:test";
import {
  CONFIRMATION_CODE_LENGTH,
  CONTROL_CHALLENGE_TTL_MS,
  ConfirmationChallengeStore,
  parseControlCommand
} from "../src/control-command.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const OTHER_SESSION = "4fcbaf06-4378-4339-b026-8c2e026a65e7";

describe("exact control command parser", () => {
  test("parses the exact non-confirmation commands and bot suffixes", () => {
    expect(parseControlCommand("/sessions")).toEqual({ kind: "sessions" });
    expect(parseControlCommand("/sessions@my_bot")).toEqual({ kind: "sessions" });
    expect(parseControlCommand("/usage")).toEqual({ kind: "usage" });
    expect(parseControlCommand("/usage@my_bot")).toEqual({ kind: "usage" });
    expect(parseControlCommand("/model")).toEqual({ kind: "model-status" });
    expect(parseControlCommand("/model@my_bot")).toEqual({ kind: "model-status" });
    for (const model of ["opus", "sonnet", "haiku", "inherit"] as const) {
      expect(parseControlCommand(`/model ${model}`)).toEqual({ kind: "model-switch", model });
    }
    expect(parseControlCommand("/reset@my_bot")).toEqual({ kind: "reset" });
    expect(parseControlCommand("/resume 1")).toEqual({ kind: "resume", index: 1 });
    expect(parseControlCommand("/resume@my_bot 10")).toEqual({ kind: "resume", index: 10 });
  });

  test("parses action-bound confirmation commands", () => {
    expect(parseControlCommand("/reset confirm ABCDEF")).toEqual({
      kind: "reset-confirm",
      code: "ABCDEF"
    });
    expect(parseControlCommand("/resume@my_bot confirm Z9X8C7")).toEqual({
      kind: "resume-confirm",
      code: "Z9X8C7"
    });
  });

  test("recognizes malformed control namespace without accepting it", () => {
    for (const input of [
      "/sessions now",
      "/usage now",
      "/model fable",
      "/model claude-opus-5",
      "/model OPUS",
      "/model opus extra",
      "/reset extra",
      "/resume",
      "/resume 0",
      "/resume 11",
      "/resume 01",
      "/resume 1.0",
      "/resume confirm ABCDE",
      "/reset confirm abcdef",
      "/reset confirm ABCDEFG",
      "/resume@my_bot@other 1",
      `/reset ${"x".repeat(300)}`
    ]) {
      expect(parseControlCommand(input)).toMatchObject({ kind: "malformed" });
    }
  });

  test("does not treat prose or unrelated slash commands as control commands", () => {
    expect(parseControlCommand("please run /sessions")).toEqual({ kind: "other" });
    expect(parseControlCommand("/sessionsx")).toEqual({ kind: "other" });
    expect(parseControlCommand("/modeling")).toEqual({ kind: "other" });
    expect(parseControlCommand("/help")).toEqual({ kind: "other" });
    expect(parseControlCommand("" )).toEqual({ kind: "other" });
  });
});

describe("confirmation challenge store", () => {
  test("generates an uppercase six-character code from injected randomness", () => {
    const store = new ConfirmationChallengeStore({
      now: () => 100,
      randomBytes: () => Uint8Array.from([0, 1, 2, 3, 4, 5])
    });

    const challenge = store.issue("123", { action: "resume", index: 4, sessionId: SESSION });
    expect(challenge).toEqual({
      action: "resume",
      index: 4,
      sessionId: SESSION,
      code: "234567",
      expiresAt: 100 + CONTROL_CHALLENGE_TTL_MS
    });
    expect(challenge.code).toHaveLength(CONFIRMATION_CODE_LENGTH);
    expect(challenge.code).toMatch(/^[A-Z2-9]+$/);
    expect(challenge.code).not.toMatch(/[OI01]/);
  });

  test("keeps only the latest challenge for each chat", () => {
    const bytes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const store = new ConfirmationChallengeStore({
      now: () => 100,
      randomBytes: () => Uint8Array.from(bytes.splice(0, 6))
    });

    store.issue("123", { action: "reset", sessionId: SESSION });
    const latest = store.issue("123", { action: "resume", index: 2, sessionId: SESSION });
    expect(store.consume("123", "reset", "234567", SESSION)).toBeNull();
    expect(store.consume("123", "resume", latest.code, SESSION)).toEqual({
      action: "resume", index: 2, sessionId: SESSION
    });
  });

  test("accepts a correct action-bound code once and rejects replay", () => {
    const store = new ConfirmationChallengeStore({
      now: () => 100,
      randomBytes: () => Uint8Array.from([0, 1, 2, 3, 4, 5])
    });
    store.issue("123", { action: "reset", sessionId: SESSION });

    expect(store.consume("123", "reset", "234567", OTHER_SESSION)).toBeNull();
    expect(store.consume("123", "reset", "234567", SESSION)).toEqual({ action: "reset", sessionId: SESSION });
    expect(store.consume("123", "reset", "234567", SESSION)).toBeNull();
    expect(store.consume("123", "resume", "234567", SESSION)).toBeNull();
  });

  test("does not consume a challenge on a wrong code, but expires at the TTL boundary", () => {
    const now = { value: 100 };
    const store = new ConfirmationChallengeStore({
      now: () => now.value,
      randomBytes: () => Uint8Array.from([0, 1, 2, 3, 4, 5])
    });
    store.issue("123", { action: "resume", index: 3, sessionId: SESSION });

    expect(store.consume("123", "resume", "ZZZZZZ", SESSION)).toBeNull();
    expect(store.consume("123", "resume", "234567", SESSION)).toEqual({
      action: "resume", index: 3, sessionId: SESSION
    });

    store.issue("123", { action: "reset", sessionId: SESSION });
    now.value += CONTROL_CHALLENGE_TTL_MS;
    expect(store.consume("123", "reset", "234567", SESSION)).toBeNull();
    expect(store.consume("123", "reset", "234567", SESSION)).toBeNull();
  });
});
