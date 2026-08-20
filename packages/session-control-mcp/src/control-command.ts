import { randomBytes as cryptoRandomBytes } from "node:crypto";

export const CONFIRMATION_CODE_LENGTH = 6;
export const CONTROL_CHALLENGE_TTL_MS = 60_000;
export const CONTROL_COMMAND_MAX_LENGTH = 256;
export const CONTROL_CHAT_ID_MAX_LENGTH = 128;

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CONFIRMATION_CODE_LENGTH}}$`);
const BOT_SUFFIX_PATTERN = "(?:@[A-Za-z0-9_]{1,32})?";
const COMMAND_PATTERN = new RegExp(`^/(sessions|usage|reset|resume)${BOT_SUFFIX_PATTERN}$`);
const MODEL_PATTERN = new RegExp(`^/model${BOT_SUFFIX_PATTERN}(?: (opus|sonnet|haiku|inherit))?$`);
const RESUME_PATTERN = new RegExp(`^/(resume)${BOT_SUFFIX_PATTERN} ([1-9]|10)$`);
const CONFIRM_PATTERN = new RegExp(
  `^/(reset|resume)${BOT_SUFFIX_PATTERN} confirm ([${CODE_ALPHABET}]{${CONFIRMATION_CODE_LENGTH}})$`
);
const CONTROL_NAMESPACE_PATTERN = /^\/(sessions|usage|model|reset|resume)(?=@|\s|$)/;
const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ControlAction = "reset" | "resume";
export const MODEL_ALIASES = ["opus", "sonnet", "haiku", "inherit"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export type ParsedControlCommand =
  | { kind: "sessions" }
  | { kind: "usage" }
  | { kind: "model-status" }
  | { kind: "model-switch"; model: ModelAlias }
  | { kind: "reset" }
  | { kind: "resume"; index: number }
  | { kind: "reset-confirm"; code: string }
  | { kind: "resume-confirm"; code: string }
  | { kind: "malformed"; namespace: ControlAction | "sessions" | "usage" | "model" }
  | { kind: "other" };

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** Parse only complete, exact control messages. Never trims or searches within prose. */
export function parseControlCommand(input: string): ParsedControlCommand {
  if (typeof input !== "string" || input.length === 0) return { kind: "other" };
  if (input.length > CONTROL_COMMAND_MAX_LENGTH) {
    const oversized = CONTROL_NAMESPACE_PATTERN.exec(input);
    return oversized === null
      ? { kind: "other" }
      : { kind: "malformed", namespace: oversized[1] as ControlAction | "sessions" | "usage" | "model" };
  }

  const confirmation = CONFIRM_PATTERN.exec(input);
  if (confirmation) {
    return {
      kind: confirmation[1] === "reset" ? "reset-confirm" : "resume-confirm",
      code: confirmation[2]!
    };
  }

  const resume = RESUME_PATTERN.exec(input);
  if (resume) return { kind: "resume", index: Number(input.slice(input.lastIndexOf(" ") + 1)) };

  const model = MODEL_PATTERN.exec(input);
  if (model) return model[1] === undefined
    ? { kind: "model-status" }
    : { kind: "model-switch", model: model[1] as ModelAlias };

  const command = COMMAND_PATTERN.exec(input);
  if (command) {
    switch (command[1]) {
      case "sessions": return { kind: "sessions" };
      case "usage": return { kind: "usage" };
      case "reset": return { kind: "reset" };
      default: return { kind: "malformed", namespace: "resume" };
    }
  }

  if (CONTROL_NAMESPACE_PATTERN.test(input)) {
    const namespace = CONTROL_NAMESPACE_PATTERN.exec(input)![1] as "sessions" | "usage" | "model" | "reset" | "resume";
    return { kind: "malformed", namespace };
  }

  return { kind: "other" };
}

export interface ConfirmationAction {
  action: ControlAction;
  index?: number;
  sessionId: string;
}

export interface ConfirmationChallenge {
  action: ControlAction;
  index?: number;
  sessionId: string;
  code: string;
  expiresAt: number;
}

export interface ConfirmationChallengeStoreOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

function validateChatId(chatId: string): void {
  if (!isBoundedString(chatId, CONTROL_CHAT_ID_MAX_LENGTH)) throw new TypeError("invalid chat id");
}

function validateAction(action: ConfirmationAction): void {
  if (typeof action !== "object" || action === null || (action.action !== "reset" && action.action !== "resume")) {
    throw new TypeError("invalid action");
  }
  if (action.action === "reset" && action.index !== undefined) throw new TypeError("reset cannot have an index");
  if (action.action === "resume" && (!Number.isSafeInteger(action.index) || action.index! < 1 || action.index! > 10)) {
    throw new TypeError("resume index must be between 1 and 10");
  }
  if (!SESSION_UUID_PATTERN.test(action.sessionId)) throw new TypeError("invalid session id");
}

function defaultRandomBytes(size: number): Uint8Array {
  return new Uint8Array(cryptoRandomBytes(size));
}

export class ConfirmationChallengeStore {
  private readonly challenges = new Map<string, ConfirmationChallenge>();
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(options: ConfirmationChallengeStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
  }

  issue(chatId: string, action: ConfirmationAction): ConfirmationChallenge {
    validateChatId(chatId);
    validateAction(action);
    const bytes = this.randomBytes(CONFIRMATION_CODE_LENGTH);
    if (!(bytes instanceof Uint8Array) || bytes.length < CONFIRMATION_CODE_LENGTH) {
      throw new TypeError("randomBytes returned too few bytes");
    }

    let code = "";
    for (let i = 0; i < CONFIRMATION_CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    const challenge: ConfirmationChallenge = {
      action: action.action,
      ...(action.index === undefined ? {} : { index: action.index }),
      sessionId: action.sessionId,
      code,
      expiresAt: this.now() + CONTROL_CHALLENGE_TTL_MS
    };
    this.challenges.set(chatId, challenge);
    return { ...challenge };
  }

  consume(chatId: string, action: ControlAction, code: string, sessionId: string, index?: number): ConfirmationAction | null {
    validateChatId(chatId);
    if (!isBoundedString(code, CONFIRMATION_CODE_LENGTH) || !CODE_PATTERN.test(code)) return null;
    const challenge = this.challenges.get(chatId);
    if (!challenge) return null;
    if (this.now() >= challenge.expiresAt) {
      this.challenges.delete(chatId);
      return null;
    }
    if (challenge.action !== action || challenge.code !== code || challenge.sessionId !== sessionId) return null;
    if (action === "reset" && index !== undefined) return null;

    this.challenges.delete(chatId);
    return challenge.index === undefined
      ? { action: challenge.action, sessionId: challenge.sessionId }
      : { action: challenge.action, index: challenge.index, sessionId: challenge.sessionId };
  }
}

export function createConfirmationChallengeStore(options?: ConfirmationChallengeStoreOptions): ConfirmationChallengeStore {
  return new ConfirmationChallengeStore(options);
}
