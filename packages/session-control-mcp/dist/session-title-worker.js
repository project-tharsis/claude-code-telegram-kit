#!/usr/bin/env bun
// @bun

// packages/session-control-mcp/src/session-title-worker.ts
import { homedir as homedir2 } from "os";

// packages/shared/src/credential-patterns.ts
var CREDENTIAL_PATTERN_SOURCES = [
  { source: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----", flags: "" },
  { source: "\\bbearer\\s+[A-Za-z0-9._~+/=-]{8,}", flags: "i" },
  {
    source: `(?:password|passwd|token|secret|api[_ -]?key|authorization|credential)["']?\\s*[:=]\\s*["']?[^\\s,;"']+`,
    flags: "i"
  },
  { source: "\\b(?:sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\\b", flags: "" },
  { source: "\\b[A-Fa-f0-9]{32,}\\b", flags: "" },
  { source: "\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b", flags: "" },
  { source: "\\bxox[baprs]-[A-Za-z0-9-]{16,}\\b", flags: "" },
  { source: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b", flags: "" },
  { source: "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b", flags: "" },
  { source: "https?://[^:\\s/@]+:[^@\\s/]+@", flags: "i" }
];
function redactCredentials(value, marker = "[redacted]") {
  let result = value;
  for (const pattern of CREDENTIAL_PATTERN_SOURCES) {
    result = result.replace(new RegExp(pattern.source, `${pattern.flags}g`), marker);
  }
  return result;
}
// packages/shared/src/fs-safety.ts
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "fs";
import { resolve } from "path";
function openDirectoryFd(path, expectedUid, directoryMode = 448, label = "directory") {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const child = `/proc/self/fd/${fd}/${part}`;
      let before;
      try {
        before = lstatSync(child);
      } catch (error) {
        if (error.code !== "ENOENT")
          throw error;
        mkdirSync(child, directoryMode);
        before = lstatSync(child);
      }
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error(`${label} is not a real directory`);
      }
      const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = fstatSync(next);
      if (!opened.isDirectory() || opened.ino !== before.ino || opened.dev !== before.dev) {
        closeSync(next);
        throw new Error(`${label} changed during open`);
      }
      closeSync(fd);
      fd = next;
    }
    const final = fstatSync(fd);
    if ((final.mode & 4095) !== directoryMode || expectedUid !== undefined && final.uid !== expectedUid) {
      throw new Error(`${label} validation failed`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
// packages/shared/src/isolated-cli-runner.ts
var ISOLATED_CLI_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
];
function isolatedCliEnvironment() {
  const env = {};
  for (const key of ISOLATED_CLI_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string")
      env[key] = value;
  }
  return env;
}
function concat(chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
async function readBoundedStream(stream, maxBytes) {
  if (!stream)
    return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      const part = await reader.read();
      if (part.done)
        break;
      const remaining = maxBytes + 1 - size;
      const chunk = part.value.slice(0, remaining);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (part.value.byteLength > remaining)
        break;
    }
  } finally {
    await reader.cancel().catch(() => {
      return;
    });
  }
  return new TextDecoder().decode(concat(chunks)).slice(0, maxBytes);
}

class IsolatedCliTimeoutError extends Error {
  constructor() {
    super("isolated CLI process timed out");
    this.name = "IsolatedCliTimeoutError";
  }
}
async function runIsolatedCli(argv, options) {
  const child = Bun.spawn(argv, { cwd: options.cwd ?? "/tmp", env: isolatedCliEnvironment(), stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedStream(child.stdout, options.maxOutputBytes),
      readBoundedStream(child.stderr, options.maxOutputBytes)
    ]);
    if (timedOut)
      throw new IsolatedCliTimeoutError;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
// packages/shared/src/memory-review-proposal.ts
var MEMORY_REVIEW_DECISIONS = ["create", "patch", "no_op"];
var MEMORY_REVIEW_TARGETS = ["managed_memory"];
var MEMORY_REVIEW_FRESHNESS = ["standing", "verify_before_use"];
var MAX_TOPIC_CHARS = 64;
var MAX_CONTENT_CHARS = 4000;
var MAX_REASON_CHARS = 400;
var MAX_EVIDENCE_ENTRIES = 8;
var MAX_EVIDENCE_CHARS = 160;
var MEMORY_REVIEW_PROPOSAL_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    decision: { type: "string", enum: [...MEMORY_REVIEW_DECISIONS] },
    target: { type: "string", enum: [...MEMORY_REVIEW_TARGETS] },
    topic: { type: "string", maxLength: MAX_TOPIC_CHARS },
    evidence: { type: "array", items: { type: "string", maxLength: MAX_EVIDENCE_CHARS }, maxItems: MAX_EVIDENCE_ENTRIES },
    content: { type: "string", maxLength: MAX_CONTENT_CHARS },
    reason: { type: "string", maxLength: MAX_REASON_CHARS },
    freshness: { type: "string", enum: [...MEMORY_REVIEW_FRESHNESS] }
  },
  required: ["decision", "target", "topic", "evidence", "content", "reason", "freshness"],
  additionalProperties: false
});
// packages/shared/src/memory-review-receipt.ts
var MAX_BYTES = 8 * 1024;
var MEMORY_REVIEW_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// packages/shared/src/runtime-failure.ts
var RUNTIME_FAILURE_TYPES = [
  "rate_limit",
  "overloaded",
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "unknown"
];
var RUNTIME_FAILURE_SET = new Set(RUNTIME_FAILURE_TYPES);
var QUOTA_LIMIT_KEYS = new Set([
  "remainingPercentage",
  "resetsAt",
  "rateLimitType",
  "isUsingOverage",
  "overageStatus",
  "surpassedThreshold",
  "isPerModel",
  "isShowingWeeklyRefresh",
  "isShowingFiveHourRefresh",
  "status",
  "unifiedRateLimitFallbackAvailable",
  "overageDisabledReason",
  "upgradePaths"
]);
// packages/shared/src/task-notification.ts
var TOOL_USE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
var TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
var COMPLETE_ENVELOPE = /^\s*<task-notification>\s*([\s\S]*?)\s*<\/task-notification>\s*$/;
function exactTag(body, tag) {
  const pattern = new RegExp(`<${tag}>\\s*([^<>]*?)\\s*</${tag}>`, "g");
  const matches = Array.from(body.matchAll(pattern));
  if (matches.length !== 1)
    return null;
  const value = matches[0]?.[1]?.trim();
  return value ? value : null;
}
function parseTerminalTaskNotification(prompt) {
  if (typeof prompt !== "string" || prompt.length > 1e6)
    return null;
  const body = COMPLETE_ENVELOPE.exec(prompt)?.[1];
  if (body === undefined)
    return null;
  const header = body.split(/<(?:summary|result)\b/i, 1)[0];
  const status = exactTag(header, "status");
  if (status !== "completed" && status !== "failed" && status !== "killed")
    return null;
  const toolUseId = exactTag(header, "tool-use-id");
  if (toolUseId !== null && !TOOL_USE_ID.test(toolUseId))
    return null;
  const taskId = exactTag(header, "task-id");
  if (taskId !== null && !TASK_ID.test(taskId))
    return null;
  if (toolUseId === null && taskId === null)
    return null;
  return {
    status,
    ...toolUseId === null ? {} : { toolUseId },
    ...taskId === null ? {} : { taskId }
  };
}
// packages/shared/src/telegram-authority.ts
import {
  closeSync as closeSync2,
  constants as constants2,
  fstatSync as fstatSync2,
  lstatSync as lstatSync2,
  openSync as openSync2,
  readFileSync,
  realpathSync
} from "fs";
import { resolve as resolve2 } from "path";
function assertAuthorizedChat(config, chatId) {
  if (!config.allowedChatIds.has(chatId))
    throw new Error("chat is not authorized");
}
function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function openPrivateDirectory(path) {
  const before = lstatSync2(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("channel state directory must be a real directory");
  }
  if (realpathSync(path) !== resolve2(path)) {
    throw new Error("channel state directory must not traverse symlinks");
  }
  const fd = openSync2(path, constants2.O_RDONLY | constants2.O_DIRECTORY | constants2.O_NOFOLLOW);
  const opened = fstatSync2(fd);
  if (opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync2(fd);
    throw new Error("channel state directory changed during validation");
  }
  if ((opened.mode & 511) !== 448) {
    closeSync2(fd);
    throw new Error("channel state directory must have mode 0700");
  }
  const uid = currentUid();
  if (uid !== undefined && opened.uid !== uid) {
    closeSync2(fd);
    throw new Error("channel state directory must be owned by the sidecar user");
  }
  return fd;
}
function readSecureFileAt(directoryFd, name) {
  const anchoredPath = `/proc/self/fd/${directoryFd}/${name}`;
  const fd = openSync2(anchoredPath, constants2.O_RDONLY | constants2.O_NOFOLLOW);
  try {
    const opened = fstatSync2(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("channel state must be a single regular file");
    }
    if ((opened.mode & 511) !== 384) {
      throw new Error("channel state must have mode 0600");
    }
    const uid = currentUid();
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error("channel state must be owned by the sidecar user");
    }
    if (opened.size > 64 * 1024) {
      throw new Error("channel state file is too large");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync2(fd);
  }
}
function loadRuntimeConfig(stateDir, options = {}) {
  const directoryFd = openPrivateDirectory(stateDir);
  let envText;
  let accessText;
  try {
    options.onDirectoryOpened?.();
    envText = readSecureFileAt(directoryFd, ".env");
    accessText = readSecureFileAt(directoryFd, "access.json");
  } finally {
    closeSync2(directoryFd);
  }
  const tokenLines = envText.split(/\r?\n/).filter((line) => line.startsWith("TELEGRAM_BOT_TOKEN="));
  if (tokenLines.length !== 1)
    throw new Error("expected exactly one Telegram bot token");
  const token = tokenLines[0].slice("TELEGRAM_BOT_TOKEN=".length).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))
    throw new Error("invalid Telegram bot token format");
  const access = JSON.parse(accessText);
  if (access.dmPolicy !== "allowlist")
    throw new Error("dmPolicy must be allowlist");
  if (!Array.isArray(access.allowFrom) || !access.allowFrom.every((value) => typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error("invalid Telegram allowlist");
  }
  const allowedChatIds = new Set(access.allowFrom);
  if (allowedChatIds.size !== access.allowFrom.length) {
    throw new Error("Telegram allowlist must not contain duplicates");
  }
  const allowMultipleChats = options.allowMultipleChats ?? process.env.TELEGRAM_ALLOW_MULTIPLE_CHATS === "true";
  if (!allowMultipleChats && allowedChatIds.size !== 1) {
    throw new Error("exactly one allowlisted chat is required by default");
  }
  return { token, allowedChatIds };
}
// packages/shared/src/telegram-envelope.ts
var MAX_ENVELOPE_TAG_CHARS = 1024;
var CHANNEL_TAG_OPEN = "<channel";
function isPositiveSafeTelegramId(value) {
  if (!/^\d{1,15}$/.test(value))
    return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1;
}
function parseChannelAttributes(tag) {
  const attributes = new Map;
  const pattern = /\s+([a-z_][a-z0-9_]{0,31})="([^"<>]{0,256})"/iy;
  let cursor = 0;
  while (cursor < tag.length) {
    if (/^\s+$/u.test(tag.slice(cursor)))
      break;
    pattern.lastIndex = cursor;
    const match = pattern.exec(tag);
    if (match === null || match.index !== cursor)
      return null;
    const key = match[1].toLowerCase();
    if (attributes.has(key))
      return null;
    attributes.set(key, match[2]);
    cursor = pattern.lastIndex;
  }
  return attributes;
}
function parseDirectTelegramEnvelope(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0)
    return null;
  const leading = prompt.length - prompt.trimStart().length;
  const trimmed = prompt.slice(leading);
  if (!trimmed.startsWith(CHANNEL_TAG_OPEN))
    return null;
  let occurrences = 0;
  for (let index = trimmed.indexOf(CHANNEL_TAG_OPEN);index !== -1; index = trimmed.indexOf(CHANNEL_TAG_OPEN, index + 1)) {
    occurrences += 1;
    if (occurrences > 1)
      return null;
  }
  const close = trimmed.indexOf(">");
  if (close === -1 || close > MAX_ENVELOPE_TAG_CHARS)
    return null;
  const tag = trimmed.slice(CHANNEL_TAG_OPEN.length, close);
  if (tag.length === 0 || !/^[\s]/.test(tag))
    return null;
  const attributes = parseChannelAttributes(tag);
  if (attributes === null)
    return null;
  const source = attributes.get("source");
  if (source !== "telegram" && source !== "plugin:telegram:telegram")
    return null;
  const chatId = attributes.get("chat_id");
  const messageId = attributes.get("message_id");
  if (chatId === undefined || messageId === undefined)
    return null;
  if (!/^-?\d{1,20}$/.test(chatId))
    return null;
  if (!isPositiveSafeTelegramId(messageId))
    return null;
  let body = trimmed.slice(close + 1);
  const closingTag = body.lastIndexOf("</channel>");
  if (closingTag !== -1)
    body = body.slice(0, closingTag);
  const timestamp = attributes.get("ts");
  const timestampMs = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  const validTimestamp = timestamp !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) && Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === timestamp;
  return {
    chatId,
    messageId,
    body: body.trim(),
    ...validTimestamp ? { timestampMs } : {}
  };
}
// packages/shared/src/telegram-response.ts
var MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;
// packages/session-control-mcp/src/session-catalog.ts
import {
  closeSync as closeSync3,
  constants as constants3,
  fstatSync as fstatSync3,
  lstatSync as lstatSync3,
  openSync as openSync3,
  readSync,
  readdirSync,
  realpathSync as realpathSync2
} from "fs";
import { join, resolve as resolve3 } from "path";

// packages/session-control-mcp/src/control-command.ts
import { randomBytes as cryptoRandomBytes } from "crypto";
var CONFIRMATION_CODE_LENGTH = 6;
var CONTROL_CHALLENGE_TTL_MS = 60000;
var CONTROL_COMMAND_MAX_LENGTH = 256;
var CONTROL_CHAT_ID_MAX_LENGTH = 128;
var CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
var CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CONFIRMATION_CODE_LENGTH}}$`);
var BOT_SUFFIX_PATTERN = "(?:@[A-Za-z0-9_]{1,32})?";
var COMMAND_PATTERN = new RegExp(`^/(sessions|usage|reset|resume)${BOT_SUFFIX_PATTERN}$`);
var MODEL_PATTERN = new RegExp(`^/model${BOT_SUFFIX_PATTERN}(?: (opus|sonnet|haiku|inherit))?$`);
var RENAME_PATTERN = new RegExp(`^/rename${BOT_SUFFIX_PATTERN}(?: +(.*))?$`);
var RESUME_PATTERN = new RegExp(`^/(resume)${BOT_SUFFIX_PATTERN} ([1-9]|10)$`);
var CONFIRM_PATTERN = new RegExp(`^/(reset|resume)${BOT_SUFFIX_PATTERN} confirm ([${CODE_ALPHABET}]{${CONFIRMATION_CODE_LENGTH}})$`);
var CONTROL_NAMESPACE_PATTERN = /^\/(sessions|usage|model|rename|reset|resume)(?=@|\s|$)/;
var SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var MODEL_CANCEL_LABEL = "5 \xB7 Cancel";
var MODEL_REPLY_CHOICES = [
  { label: "1 \xB7 Opus", model: "opus" },
  { label: "2 \xB7 Sonnet", model: "sonnet" },
  { label: "3 \xB7 Haiku", model: "haiku" },
  { label: "4 \xB7 Inherit", model: "inherit" }
];
function isBoundedString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function parseControlCommand(input) {
  if (typeof input !== "string" || input.length === 0)
    return { kind: "other" };
  if (input.length > CONTROL_COMMAND_MAX_LENGTH) {
    const oversized = CONTROL_NAMESPACE_PATTERN.exec(input);
    return oversized === null ? { kind: "other" } : { kind: "malformed", namespace: oversized[1] };
  }
  if (input === MODEL_CANCEL_LABEL)
    return { kind: "model-cancel" };
  const replyChoice = MODEL_REPLY_CHOICES.find((choice) => choice.label === input);
  if (replyChoice !== undefined)
    return { kind: "model-switch", model: replyChoice.model };
  const confirmation = CONFIRM_PATTERN.exec(input);
  if (confirmation) {
    return {
      kind: confirmation[1] === "reset" ? "reset-confirm" : "resume-confirm",
      code: confirmation[2]
    };
  }
  const resume = RESUME_PATTERN.exec(input);
  if (resume)
    return { kind: "resume", index: Number(input.slice(input.lastIndexOf(" ") + 1)) };
  const model = MODEL_PATTERN.exec(input);
  if (model)
    return model[1] === undefined ? { kind: "model-status" } : { kind: "model-switch", model: model[1] };
  const rename = RENAME_PATTERN.exec(input);
  if (rename) {
    const title = (rename[1] ?? "").replace(/\s+/gu, " ").trim();
    if (title && Array.from(title).length <= 60 && !/[\u0000-\u001f\u007f]/u.test(title)) {
      return { kind: "rename", title };
    }
    return { kind: "malformed", namespace: "rename" };
  }
  const command = COMMAND_PATTERN.exec(input);
  if (command) {
    switch (command[1]) {
      case "sessions":
      case "resume":
        return { kind: "sessions" };
      case "usage":
        return { kind: "usage" };
      case "reset":
        return { kind: "reset" };
      default:
        return { kind: "malformed", namespace: "resume" };
    }
  }
  if (CONTROL_NAMESPACE_PATTERN.test(input)) {
    const namespace = CONTROL_NAMESPACE_PATTERN.exec(input)[1];
    return { kind: "malformed", namespace };
  }
  return { kind: "other" };
}
function validateChatId(chatId) {
  if (!isBoundedString(chatId, CONTROL_CHAT_ID_MAX_LENGTH))
    throw new TypeError("invalid chat id");
}
function validateAction(action) {
  if (typeof action !== "object" || action === null || action.action !== "reset" && action.action !== "resume") {
    throw new TypeError("invalid action");
  }
  if (action.action === "reset" && action.index !== undefined)
    throw new TypeError("reset cannot have an index");
  if (action.action === "resume" && (!Number.isSafeInteger(action.index) || action.index < 1 || action.index > 10)) {
    throw new TypeError("resume index must be between 1 and 10");
  }
  if (!SESSION_UUID_PATTERN.test(action.sessionId))
    throw new TypeError("invalid session id");
}
function defaultRandomBytes(size) {
  return new Uint8Array(cryptoRandomBytes(size));
}

class ConfirmationChallengeStore {
  challenges = new Map;
  now;
  randomBytes;
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
  }
  issue(chatId, action) {
    validateChatId(chatId);
    validateAction(action);
    const bytes = this.randomBytes(CONFIRMATION_CODE_LENGTH);
    if (!(bytes instanceof Uint8Array) || bytes.length < CONFIRMATION_CODE_LENGTH) {
      throw new TypeError("randomBytes returned too few bytes");
    }
    let code = "";
    for (let i = 0;i < CONFIRMATION_CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    const challenge = {
      action: action.action,
      ...action.index === undefined ? {} : { index: action.index },
      sessionId: action.sessionId,
      code,
      expiresAt: this.now() + CONTROL_CHALLENGE_TTL_MS
    };
    this.challenges.set(chatId, challenge);
    return { ...challenge };
  }
  consume(chatId, action, code, sessionId, index) {
    validateChatId(chatId);
    if (!isBoundedString(code, CONFIRMATION_CODE_LENGTH) || !CODE_PATTERN.test(code))
      return null;
    const challenge = this.challenges.get(chatId);
    if (!challenge)
      return null;
    if (this.now() >= challenge.expiresAt) {
      this.challenges.delete(chatId);
      return null;
    }
    if (challenge.action !== action || challenge.code !== code || challenge.sessionId !== sessionId)
      return null;
    if (action === "reset" && index !== undefined)
      return null;
    this.challenges.delete(chatId);
    return challenge.index === undefined ? { action: challenge.action, sessionId: challenge.sessionId } : { action: challenge.action, index: challenge.index, sessionId: challenge.sessionId };
  }
}

// packages/session-control-mcp/src/session-catalog.ts
var DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
var DEFAULT_TAIL_BYTES = 256 * 1024;
var MAX_TITLE_CHARS = 60;
var TASK_SCAN_CHUNK_BYTES = 64 * 1024;
var MAX_TASK_SCAN_LINE_BYTES = 1024 * 1024;
var MAX_TRACKED_BACKGROUND_TASKS = 256;
var CONVERSATION_FALLBACK = "Conversation with Claudio";
var CONTROL_ONLY_FALLBACK = "Control-only session";
function currentUid2() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function sanitizeTitle(raw, fallback) {
  const collapsed = Array.from(raw).map((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127 ? " " : character).join("").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0)
    return fallback;
  const characters = Array.from(collapsed);
  if (characters.length <= MAX_TITLE_CHARS)
    return collapsed;
  return `${characters.slice(0, MAX_TITLE_CHARS).join("")}\u2026`;
}
function readTail(fd, size, tailBytes) {
  const length = Math.min(size, tailBytes);
  const offset = size - length;
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, offset + filled);
    if (read <= 0)
      break;
    filled += read;
  }
  const text = buffer.subarray(0, filled).toString("utf8");
  return offset > 0 ? text.slice(text.indexOf(`
`) + 1) : text;
}
function readHeadAndTail(fd, size, windowBytes) {
  const headLength = Math.min(size, windowBytes);
  const head = Buffer.allocUnsafe(headLength);
  let filled = 0;
  while (filled < headLength) {
    const read = readSync(fd, head, filled, headLength - filled, filled);
    if (read <= 0)
      break;
    filled += read;
  }
  const headText = head.subarray(0, filled).toString("utf8");
  if (size <= windowBytes)
    return headText;
  return `${headText}
${readTail(fd, size, windowBytes)}`;
}
function parseTranscript(text, sessionId) {
  let customTitle = null;
  let aiTitle = null;
  let belongsToSession = false;
  let hasConcreteAssistant = false;
  for (const line of text.split(`
`)) {
    if (line.length === 0)
      continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null)
      continue;
    const typed = record;
    if (typed.sessionId === sessionId)
      belongsToSession = true;
    if (typed.type === "assistant" && typeof typed.message?.model === "string" && !typed.message.model.startsWith("<"))
      hasConcreteAssistant = true;
    if (typed.type === "custom-title" && typeof typed.customTitle === "string") {
      customTitle = typed.customTitle;
    } else if (typed.type === "ai-title" && typeof typed.aiTitle === "string") {
      aiTitle = typed.aiTitle;
    }
  }
  const fallback = hasConcreteAssistant ? CONVERSATION_FALLBACK : CONTROL_ONLY_FALLBACK;
  const title = customTitle ?? aiTitle;
  return { title: title === null ? fallback : sanitizeTitle(title, fallback), belongsToSession };
}
function openValidatedTranscript(path, expectedUid, maxFileBytes) {
  let before;
  try {
    before = lstatSync3(path);
  } catch {
    return null;
  }
  if (!before.isFile() || before.isSymbolicLink())
    return null;
  if (before.nlink !== 1 || (before.mode & 18) !== 0)
    return null;
  if (before.size === 0 || before.size > maxFileBytes)
    return null;
  if (expectedUid !== undefined && before.uid !== expectedUid)
    return null;
  let fd;
  try {
    fd = openSync3(path, constants3.O_RDONLY | constants3.O_NOFOLLOW);
  } catch {
    return null;
  }
  const opened = fstatSync3(fd);
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size === 0 || opened.size > maxFileBytes || opened.nlink !== 1 || (opened.mode & 18) !== 0 || expectedUid !== undefined && opened.uid !== expectedUid) {
    closeSync3(fd);
    return null;
  }
  return { fd, size: opened.size };
}
var UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function readUsableSessionTranscript(options) {
  if (typeof options.sessionId !== "string" || !UUID_ONLY.test(options.sessionId)) {
    throw new Error("invalid session UUID");
  }
  const expectedUid = options.expectedUid ?? currentUid2();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const directory = resolve3(options.directory);
  const directoryInfo = lstatSync3(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("configured sessions directory is not a real directory");
  }
  if (realpathSync2(directory) !== directory) {
    throw new Error("configured sessions directory must not traverse symlinks");
  }
  const path = join(directory, `${options.sessionId}.jsonl`);
  const opened = openValidatedTranscript(path, expectedUid, maxFileBytes);
  if (opened === null)
    throw new Error("selected session transcript is not usable");
  try {
    const text = readHeadAndTail(opened.fd, opened.size, options.tailBytes ?? DEFAULT_TAIL_BYTES);
    if (!parseTranscript(text, options.sessionId).belongsToSession) {
      throw new Error("selected session transcript belongs to another session");
    }
    return text;
  } finally {
    closeSync3(opened.fd);
  }
}
function contentBlocks(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((item) => typeof item === "object" && item !== null);
}
function updateBackgroundTaskState(row, taskIds, taskAliases) {
  if (row.type !== "user")
    return false;
  const message = typeof row.message === "object" && row.message !== null ? row.message : null;
  if (message === null)
    return false;
  const result = typeof row.toolUseResult === "object" && row.toolUseResult !== null ? row.toolUseResult : null;
  if (result?.status === "forked" || result?.status === "async_launched") {
    const agentId = typeof result.agentId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(result.agentId) ? result.agentId : null;
    for (const block of contentBlocks(message.content)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string")
        continue;
      if (taskIds.size >= MAX_TRACKED_BACKGROUND_TASKS && !taskIds.has(block.tool_use_id))
        return true;
      taskIds.add(block.tool_use_id);
      if (agentId !== null && !taskAliases.has(agentId))
        taskAliases.set(agentId, block.tool_use_id);
    }
  }
  const values = typeof message.content === "string" ? [message.content] : contentBlocks(message.content).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text);
  for (const value of values) {
    const notification = parseTerminalTaskNotification(value);
    if (notification === null)
      continue;
    const direct = notification.toolUseId;
    const aliased = notification.taskId === undefined ? undefined : taskAliases.get(notification.taskId);
    if (direct !== undefined && notification.taskId !== undefined && aliased !== direct)
      continue;
    const toolUseId = direct ?? aliased;
    if (toolUseId !== undefined)
      taskIds.delete(toolUseId);
    if (notification.taskId !== undefined && aliased === toolUseId)
      taskAliases.delete(notification.taskId);
  }
  return false;
}
function boundedText(value, maxChars) {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, maxChars).join("");
}
function scanIncompleteBackgroundTasks(options) {
  const opened = openValidatedTranscript(join(resolve3(options.directory), `${options.sessionId}.jsonl`), options.expectedUid ?? currentUid2(), DEFAULT_MAX_FILE_BYTES);
  if (opened === null)
    return true;
  const taskIds = new Set;
  const taskAliases = new Map;
  let overflow = false;
  let pending = Buffer.alloc(0);
  let skipOversizedLine = false;
  const consume = (line) => {
    if (line.length === 0 || line.length > MAX_TASK_SCAN_LINE_BYTES)
      return;
    try {
      const row = JSON.parse(line.toString("utf8"));
      if (typeof row === "object" && row !== null && updateBackgroundTaskState(row, taskIds, taskAliases)) {
        overflow = true;
      }
    } catch {}
  };
  try {
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(TASK_SCAN_CHUNK_BYTES, opened.size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const count = readSync(opened.fd, chunk, 0, length, offset);
      if (count <= 0)
        break;
      offset += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (skipOversizedLine)
          skipOversizedLine = false;
        else
          consume(line);
      }
      if (pending.length > MAX_TASK_SCAN_LINE_BYTES) {
        pending = Buffer.alloc(0);
        skipOversizedLine = true;
      }
    }
    if (!skipOversizedLine)
      consume(pending);
    return overflow || taskIds.size > 0;
  } finally {
    closeSync3(opened.fd);
  }
}
function readSessionTitleContext(options) {
  const text = readUsableSessionTranscript({ ...options, tailBytes: 512 * 1024 });
  let customTitle = null;
  let aiTitle = null;
  let chatId = null;
  let chatMessageId = null;
  let userPrompt = null;
  let assistantText = "";
  const toolNames = [];
  for (const line of text.split(`
`)) {
    if (!line)
      continue;
    let row;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null)
        continue;
      row = parsed;
    } catch {
      continue;
    }
    if (row.type === "custom-title" && typeof row.customTitle === "string") {
      customTitle = row.customTitle.trim() || null;
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") {
      aiTitle = row.aiTitle.trim() || null;
      continue;
    }
    const message = typeof row.message === "object" && row.message !== null ? row.message : null;
    if (message === null)
      continue;
    if (row.type === "user" && userPrompt === null) {
      const candidates = typeof message.content === "string" ? [message.content] : contentBlocks(message.content).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text);
      for (const candidate of candidates) {
        const envelope = parseDirectTelegramEnvelope(candidate);
        if (envelope === null || parseControlCommand(envelope.body).kind !== "other")
          continue;
        const prompt = boundedText(envelope.body, 1200);
        if (prompt) {
          chatId = envelope.chatId;
          chatMessageId = envelope.messageId;
          userPrompt = prompt;
          break;
        }
      }
      continue;
    }
    if (row.type === "assistant" && userPrompt !== null && typeof message.model === "string" && !message.model.startsWith("<")) {
      for (const block of contentBlocks(message.content)) {
        if (block.type === "text" && typeof block.text === "string" && assistantText.length < 1200) {
          assistantText = boundedText(`${assistantText} ${block.text}`, 1200);
        } else if (block.type === "tool_use" && typeof block.name === "string" && toolNames.length < 5 && !toolNames.includes(block.name)) {
          toolNames.push(boundedText(block.name, 40));
        }
      }
    }
  }
  return {
    customTitle,
    aiTitle,
    chatId,
    chatMessageId,
    userPrompt,
    assistantText,
    toolNames,
    hasIncompleteForkedTask: scanIncompleteBackgroundTasks(options)
  };
}

// packages/session-control-mcp/src/session-title-state.ts
import {
  closeSync as closeSync4,
  constants as constants4,
  fstatSync as fstatSync4,
  fsyncSync,
  lstatSync as lstatSync4,
  openSync as openSync4,
  readSync as readSync2,
  renameSync,
  unlinkSync,
  writeSync
} from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { join as join2, resolve as resolve4 } from "path";
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var MAX_BYTES2 = 8 * 1024;
var MAX_TITLE_CHARS2 = 60;
var STATE_VERSION = 1;
var DIRECTORY_MODE = 448;
var FILE_MODE = 384;
var FAILURE_REASONS_BY_PHASE = {
  generate: ["timeout", "command_failed"],
  parse: ["invalid_output"],
  rename: ["rename_failed"],
  readback: ["readback_failed", "state_failed"],
  lock: ["lock_failed", "state_failed"]
};
function isRetryableTitleFailure(phase, reason) {
  return phase === "generate" && (reason === "timeout" || reason === "command_failed") || phase === "parse" && reason === "invalid_output";
}
function isValidFailureTuple(phase, reason) {
  return FAILURE_REASONS_BY_PHASE[phase].includes(reason);
}
function defaultSessionTitleStateDirectory() {
  return join2(homedir(), ".local", "state", "claude-code-telegram-kit", "session-titles");
}
function uid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || !UUID.test(sessionId))
    throw new Error("invalid session UUID");
}
function assertTitle(title) {
  if (typeof title !== "string")
    throw new Error("invalid session title");
  const chars = Array.from(title);
  if (chars.length < 1 || chars.length > MAX_TITLE_CHARS2)
    throw new Error("invalid session title");
  if (chars.some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code >= 127 && code <= 159;
  }))
    throw new Error("invalid session title");
}
function expectedDirectory(options) {
  const path = resolve4(options.directory ?? defaultSessionTitleStateDirectory());
  return { path, expectedUid: options.expectedUid ?? uid() };
}
function openDirectory(path, expectedUid) {
  return openDirectoryFd(path, expectedUid, DIRECTORY_MODE, "state directory");
}
function statePath(directory, sessionId) {
  assertSessionId(sessionId);
  return join2(directory, `${sessionId}.json`);
}
function validateState(value, sessionId) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid title state");
  const record = value;
  const keys = Object.keys(record);
  const allowed = record.status === "auto_applied" || record.status === "user_locked" ? ["version", "sessionId", "status", "attempts", "title", "updatedAt"] : record.status === "failed" ? ["version", "sessionId", "status", "attempts", "phase", "reason", "retryAt", "updatedAt"] : ["version", "sessionId", "status", "attempts", "updatedAt"];
  const diagnosticKeys = ["phase", "reason", "retryAt"];
  const required = record.status === "failed" && (("phase" in record) || ("reason" in record) || ("retryAt" in record)) ? allowed.filter((key) => key !== "retryAt") : allowed.filter((key) => !diagnosticKeys.includes(key));
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !(key in record))) {
    throw new Error("invalid title state schema");
  }
  if (record.version !== STATE_VERSION || record.sessionId !== sessionId || record.status !== "claimed" && record.status !== "auto_applied" && record.status !== "failed" && record.status !== "user_locked" || record.attempts !== 1 && record.attempts !== 2 || typeof record.updatedAt !== "number" || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
    throw new Error("invalid title state schema");
  }
  if (record.status === "auto_applied" || record.status === "user_locked") {
    if (typeof record.title !== "string")
      throw new Error("invalid title state schema");
    assertTitle(record.title);
  }
  if (record.status === "failed" && (record.phase !== undefined || record.reason !== undefined || record.retryAt !== undefined)) {
    if (typeof record.phase !== "string" || !["generate", "parse", "rename", "readback", "lock"].includes(record.phase) || typeof record.reason !== "string" || !["timeout", "command_failed", "invalid_output", "rename_failed", "readback_failed", "lock_failed", "state_failed"].includes(record.reason) || record.retryAt !== undefined && (typeof record.retryAt !== "number" || !Number.isSafeInteger(record.retryAt) || record.retryAt < 0)) {
      throw new Error("invalid title state schema");
    }
    const phase = record.phase;
    const reason = record.reason;
    if (!isValidFailureTuple(phase, reason) || record.retryAt !== undefined && !isRetryableTitleFailure(phase, reason) || record.attempts === 2 && record.retryAt !== undefined) {
      throw new Error("invalid title state schema");
    }
  }
  return record;
}
function readLeaf(path, expectedUid, sessionId) {
  let before;
  try {
    before = lstatSync4(path);
  } catch (error) {
    if (error.code === "ENOENT")
      return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 4095) !== FILE_MODE || expectedUid !== undefined && before.uid !== expectedUid || before.size > MAX_BYTES2) {
    throw new Error("unsafe title state file");
  }
  const fd = openSync4(path, constants4.O_RDONLY | constants4.O_NOFOLLOW);
  try {
    const opened = fstatSync4(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || (opened.mode & 4095) !== FILE_MODE || expectedUid !== undefined && opened.uid !== expectedUid || opened.size > MAX_BYTES2) {
      throw new Error("title state file changed");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync2(fd, buffer, offset, buffer.length - offset, null);
      if (count <= 0)
        throw new Error("short title state read");
      offset += count;
    }
    return validateState(JSON.parse(buffer.toString("utf8")), sessionId);
  } finally {
    closeSync4(fd);
  }
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0)
      throw new Error("short title state write");
    offset += count;
  }
}
function canonicalState(state) {
  const value = { version: 1, sessionId: state.sessionId, status: state.status, attempts: state.attempts };
  if (state.title !== undefined)
    value.title = state.title;
  if (state.phase !== undefined)
    value.phase = state.phase;
  if (state.reason !== undefined)
    value.reason = state.reason;
  if (state.retryAt !== undefined)
    value.retryAt = state.retryAt;
  value.updatedAt = state.updatedAt;
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BYTES2)
    throw new Error("title state exceeds size limit");
  return bytes;
}
function withDirectory(options, action) {
  assertSessionId(options.sessionId);
  const { path, expectedUid } = expectedDirectory(options);
  const dirfd = openDirectory(path, expectedUid);
  try {
    return action(path, dirfd, expectedUid);
  } finally {
    closeSync4(dirfd);
  }
}
function readSessionTitleState(options) {
  return withDirectory(options, (_directory, dirfd, expectedUid) => readLeaf(join2(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId));
}
function claimAutoTitle(options) {
  return withDirectory(options, (_directory, dirfd, _expectedUid) => {
    const leafPath = join2(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`);
    let fd;
    try {
      fd = openSync4(leafPath, constants4.O_WRONLY | constants4.O_CREAT | constants4.O_EXCL | constants4.O_NOFOLLOW, FILE_MODE);
    } catch (error) {
      if (error.code === "EEXIST")
        return false;
      throw error;
    }
    try {
      writeAll(fd, canonicalState({ version: 1, sessionId: options.sessionId, status: "claimed", attempts: 1, updatedAt: Date.now() }));
      fsyncSync(fd);
    } catch (error) {
      try {
        closeSync4(fd);
      } finally {
        try {
          unlinkSync(leafPath);
        } catch {}
      }
      throw error;
    }
    closeSync4(fd);
    fsyncSync(dirfd);
    return true;
  });
}
function transition(options, status, title) {
  if (status === "auto_applied") {
    if (title === undefined)
      throw new Error("applied title is required");
    assertTitle(title);
  }
  return withDirectory(options, (directory, dirfd, expectedUid) => {
    const path = statePath(directory, options.sessionId);
    const current = readLeaf(join2(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId);
    if (current === null || current.status !== "claimed")
      return false;
    const next = { version: 1, sessionId: options.sessionId, status, attempts: current.attempts, updatedAt: Date.now() };
    if (title !== undefined)
      next.title = title;
    if (status === "failed" && options.phase !== undefined && options.reason !== undefined) {
      next.phase = options.phase;
      next.reason = options.reason;
      if (current.attempts === 1 && options.retryAt !== undefined)
        next.retryAt = options.retryAt;
    }
    replaceLeaf(directory, dirfd, path, next);
    return true;
  });
}
function completeAutoTitle(options) {
  return transition(options, "auto_applied", options.title);
}
function failAutoTitle(options) {
  return transition(options, "failed");
}
function retryAutoTitle(options, now = Date.now()) {
  return withDirectory(options, (directory, dirfd, expectedUid) => {
    const current = readLeaf(join2(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId);
    if (current === null || current.status !== "failed" || current.attempts !== 1 || current.phase === undefined || current.reason === undefined || !isRetryableTitleFailure(current.phase, current.reason) || current.retryAt === undefined || current.retryAt > now)
      return false;
    replaceLeaf(directory, dirfd, statePath(directory, options.sessionId), { version: 1, sessionId: options.sessionId, status: "claimed", attempts: 2, updatedAt: Date.now() });
    return true;
  });
}
function lockUserTitle(options) {
  assertTitle(options.title);
  return withDirectory(options, (directory, dirfd, expectedUid) => {
    const path = statePath(directory, options.sessionId);
    readLeaf(join2(`/proc/self/fd/${dirfd}`, `${options.sessionId}.json`), expectedUid, options.sessionId);
    replaceLeaf(directory, dirfd, path, {
      version: 1,
      sessionId: options.sessionId,
      status: "user_locked",
      attempts: 1,
      title: options.title,
      updatedAt: Date.now()
    });
    return true;
  });
}
async function withSessionTitleLock(options, action, timeoutMs = 20000) {
  assertSessionId(options.sessionId);
  const boundedTimeout = Math.max(1, Math.min(timeoutMs, 60000));
  const { path, expectedUid } = expectedDirectory(options);
  const dirfd = openDirectory(path, expectedUid);
  let lockFd = null;
  try {
    const lockPath = `/proc/self/fd/${dirfd}/${options.sessionId}.lock`;
    lockFd = openSync4(lockPath, constants4.O_RDWR | constants4.O_CREAT | constants4.O_NOFOLLOW, FILE_MODE);
    const opened = fstatSync4(lockFd);
    const named = lstatSync4(lockPath);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || (opened.mode & 4095) !== FILE_MODE || expectedUid !== undefined && opened.uid !== expectedUid || opened.size > 1024) {
      throw new Error("unsafe title lock file");
    }
  } catch (error) {
    if (lockFd !== null) {
      closeSync4(lockFd);
      lockFd = null;
    }
    throw error;
  } finally {
    closeSync4(dirfd);
  }
  try {
    await new Promise((resolveLock, rejectLock) => {
      const child = spawn("/usr/bin/flock", ["-x", "-w", (boundedTimeout / 1000).toFixed(3), "3"], { stdio: ["ignore", "ignore", "ignore", lockFd] });
      child.once("error", () => rejectLock(new Error("session title lock unavailable")));
      child.once("exit", (code) => {
        if (code === 0)
          resolveLock();
        else
          rejectLock(new Error("session title lock timeout"));
      });
    });
    return await action();
  } finally {
    if (lockFd !== null)
      closeSync4(lockFd);
  }
}
function replaceLeaf(directory, dirfd, path, state) {
  const tempName = `.${state.sessionId}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const anchoredDirectory = `/proc/self/fd/${dirfd}`;
  const temp = join2(anchoredDirectory, tempName);
  const target = join2(anchoredDirectory, path.slice(directory.length + 1));
  const fd = openSync4(temp, constants4.O_WRONLY | constants4.O_CREAT | constants4.O_EXCL | constants4.O_NOFOLLOW, FILE_MODE);
  try {
    writeAll(fd, canonicalState(state));
    fsyncSync(fd);
    closeSync4(fd);
    renameSync(temp, target);
    fsyncSync(dirfd);
  } catch (error) {
    try {
      closeSync4(fd);
    } catch {}
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}

// packages/session-control-mcp/src/session-title-generator.ts
var MAX_CONTEXT_TEXT = 1200;
var MAX_TOOL_NAMES = 5;
var MAX_TOOL_NAME = 40;
var MAX_OUTPUT_BYTES = 64 * 1024;
var DEFAULT_TIMEOUT_MS = 15000;
var GENERIC_ERROR = "Session title generation failed";

class SessionTitleGenerationError extends Error {
  phase;
  reason;
  retryable;
  constructor(phase, reason, retryable) {
    super(GENERIC_ERROR);
    this.phase = phase;
    this.reason = reason;
    this.retryable = retryable;
    this.name = "SessionTitleGenerationError";
  }
}
var GENERIC_TITLES = new Set([
  "session",
  "new session",
  "untitled",
  "untitled conversation",
  "conversation",
  "chat",
  "assistant",
  "hello",
  "test"
]);
var UUID2 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
var PATH = /(?:^|\s)(?:[a-zA-Z]:[\\/]|~[\\/]|\\\\|\/(?:home|Users|srv|etc|var|opt|tmp)\/|\.\.?[\\/])/;
var SENSITIVE_OUTPUT = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^:\s/@]+:[^@\s/]+@)/i;
function redact(value) {
  return redactCredentials(value);
}
function bounded(value, limit) {
  return redact(typeof value === "string" ? value : "").slice(0, limit);
}
function buildPrompt(context) {
  const tools = (Array.isArray(context.toolNames) ? context.toolNames : []).slice(0, MAX_TOOL_NAMES).map((name) => bounded(name, MAX_TOOL_NAME).replace(/[\r\n]/g, " "));
  return [
    "Create a concise task-specific session title: 2-6 English words or a short CJK phrase. " + "Do not include paths, IDs, credentials, generic words like Session/Conversation, or punctuation wrappers. " + "Return only the requested structured title.",
    `User request: ${bounded(context.userPrompt, MAX_CONTEXT_TEXT)}`,
    `Assistant summary: ${bounded(context.assistantText, MAX_CONTEXT_TEXT)}`,
    `Tools used: ${tools.join(", ")}`
  ].join(`
`);
}
async function defaultRunner(argv, options) {
  try {
    return await runIsolatedCli(argv, { timeoutMs: options.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
  } catch (error) {
    if (error instanceof IsolatedCliTimeoutError)
      throw new SessionTitleGenerationError("generate", "timeout", true);
    throw error;
  }
}
function isValidSessionTitle(title) {
  if (typeof title !== "string" || title.length < 3 || title.length > 60)
    return false;
  if (/[\r\n\u0000-\u001f\u007f<>]/.test(title) || UUID2.test(title) || PATH.test(title))
    return false;
  if (/(?:password|passwd|token|secret|api[_ -]?key|authorization|credential)\s*[:=]\s*[^\s,;]+/i.test(title))
    return false;
  if (/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(title))
    return false;
  if (/(?:\b(?:sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b|\b[A-Fa-f0-9]{32,}\b)/.test(title))
    return false;
  if (/^(?:[A-Za-z0-9+/]{20,}={0,2})$/.test(title))
    return false;
  if (SENSITIVE_OUTPUT.test(title))
    return false;
  if (/^[!?#*_"'\[\]{}<>]|[!?#*_"'\[\]{}<>]$/u.test(title))
    return false;
  const normalized = title.trim().toLowerCase();
  if (GENERIC_TITLES.has(normalized))
    return false;
  const words = title.match(/[A-Za-z]+(?:['\u2019-][A-Za-z]+)*/g) ?? [];
  const hasCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(title);
  if (!hasCjk && (words.length < 2 || words.length > 8))
    return false;
  return true;
}
function parseTitle(stdout) {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES)
    return null;
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof outer !== "object" || outer === null)
    return null;
  const record = outer;
  let structured = record.structured_output;
  if (structured === undefined && typeof record.result === "string") {
    try {
      structured = JSON.parse(record.result).structured_output;
    } catch {
      return null;
    }
  }
  if (typeof structured !== "object" || structured === null || typeof structured.title !== "string")
    return null;
  const rawTitle = structured.title;
  if (typeof rawTitle !== "string")
    return null;
  const title = rawTitle.replace(/\s+/g, " ").trim();
  return isValidSessionTitle(title) ? title : null;
}
async function generateSessionTitle(context, options = {}) {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60000));
  const schema = JSON.stringify({ type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false });
  const argv = [
    options.claudePath ?? "claude",
    "-p",
    buildPrompt(context),
    "--model",
    "haiku",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--max-turns",
    "1",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--settings",
    "{}",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk"
  ];
  try {
    const run = options.run ?? defaultRunner;
    let timeout;
    const timeoutResult = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new SessionTitleGenerationError("generate", "timeout", true)), timeoutMs);
    });
    const result = await Promise.race([run(argv, { timeoutMs }), timeoutResult]).finally(() => {
      if (timeout !== undefined)
        clearTimeout(timeout);
    });
    if (result.exitCode !== 0 || typeof result.stdout !== "string")
      throw new SessionTitleGenerationError("generate", "command_failed", true);
    const title = parseTitle(result.stdout);
    if (!title)
      throw new SessionTitleGenerationError("parse", "invalid_output", true);
    return title;
  } catch (error) {
    if (error instanceof SessionTitleGenerationError)
      throw error;
    throw new SessionTitleGenerationError("generate", "command_failed", true);
  }
}

// packages/session-control-mcp/src/session-title-rename.ts
var SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var MAX_OUTPUT_BYTES2 = 32 * 1024;
var GENERIC_ERROR2 = "Session rename failed";
async function readBounded(stream) {
  if (stream === null)
    return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size <= MAX_OUTPUT_BYTES2) {
      const part = await reader.read();
      if (part.done)
        break;
      const remaining = MAX_OUTPUT_BYTES2 + 1 - size;
      chunks.push(part.value.slice(0, remaining));
      size += Math.min(part.value.byteLength, remaining);
      if (part.value.byteLength > remaining)
        break;
    }
  } finally {
    await reader.cancel().catch(() => {
      return;
    });
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged).slice(0, MAX_OUTPUT_BYTES2);
}
async function defaultRunner2(argv, options) {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe"
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout),
      readBounded(child.stderr)
    ]);
    if (timedOut)
      throw new Error(GENERIC_ERROR2);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
async function renameSessionWithClaude(sessionId, title, options) {
  if (!SESSION_UUID.test(sessionId) || !title || /[\r\n\u0000-\u001f\u007f]/u.test(title)) {
    throw new Error(GENERIC_ERROR2);
  }
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 1e4, 30000));
  const argv = [
    options.claudePath ?? "claude",
    "-p",
    `/rename ${title}`,
    "--resume",
    sessionId,
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--settings",
    "{}",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk"
  ];
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "CLAUDE_CONFIG_DIR"
  ]) {
    const value = process.env[key];
    if (typeof value === "string")
      env[key] = value;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = "local-rename-command-only";
  try {
    const result = await (options.run ?? defaultRunner2)(argv, {
      timeoutMs,
      cwd: options.workspaceDir,
      env
    });
    if (result.exitCode !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES2)
      throw new Error(GENERIC_ERROR2);
    const payload = JSON.parse(result.stdout);
    if (payload.is_error !== false || payload.num_turns !== 0 || payload.duration_api_ms !== 0 || payload.result !== `Session renamed to: ${title}`)
      throw new Error(GENERIC_ERROR2);
  } catch {
    throw new Error(GENERIC_ERROR2);
  }
}

// packages/session-control-mcp/src/session-title-service.ts
function normalizeManualTitle(raw) {
  if (typeof raw !== "string")
    throw new Error("invalid session title");
  const title = raw.replace(/\s+/gu, " ").trim();
  const chars = Array.from(title);
  if (chars.length < 1 || chars.length > 60)
    throw new Error("invalid session title");
  if (chars.some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code >= 127 && code <= 159;
  }))
    throw new Error("invalid session title");
  return title;
}
function createSessionTitleService(options) {
  const stateDirectory = options.stateDirectory ?? defaultSessionTitleStateDirectory();
  const readContext = options.readContext ?? ((sessionId) => readSessionTitleContext({
    directory: options.projectSessionsDir,
    sessionId
  }));
  const generate = options.generate ?? ((context) => generateSessionTitle(context, {
    claudePath: process.env.CLAUDE_TITLE_CLI ?? "claude"
  }));
  const rename = options.rename ?? (async (sessionId, title, workspaceDir) => {
    await renameSessionWithClaude(sessionId, title, {
      workspaceDir,
      claudePath: process.env.CLAUDE_TITLE_CLI ?? "claude"
    });
  });
  const stateOptions = (sessionId) => ({ directory: stateDirectory, sessionId });
  const isAuthorizedChat = options.isAuthorizedChat ?? (() => false);
  const retryDelayMs = Math.max(1, Math.min(options.retryDelayMs ?? 1000, 60000));
  const now = options.now ?? Date.now;
  async function ensureAutoTitle(sessionId, override = {}) {
    try {
      return await withSessionTitleLock(stateOptions(sessionId), async () => {
        const state = readSessionTitleState(stateOptions(sessionId));
        let retryDue = false;
        if (state?.status === "failed" && state.phase !== undefined && state.reason !== undefined && state.retryAt !== undefined && state.attempts === 1 && isRetryableTitleFailure(state.phase, state.reason)) {
          if (state.retryAt > now())
            return "retry_scheduled";
          retryDue = true;
        } else if (state !== null)
          return "already_attempted";
        const before = readContext(sessionId);
        const assistantText = override.assistantText?.trim() || before.assistantText;
        if (before.chatId === null || !isAuthorizedChat(before.chatId))
          return "no_context";
        if (before.customTitle !== null) {
          lockUserTitle({ ...stateOptions(sessionId), title: before.customTitle });
          return "existing";
        }
        if (before.aiTitle !== null) {
          lockUserTitle({ ...stateOptions(sessionId), title: before.aiTitle });
          return "existing";
        }
        if (before.hasIncompleteForkedTask === true)
          return "deferred";
        if (before.userPrompt === null || !assistantText && before.toolNames.length === 0) {
          return "no_context";
        }
        if (retryDue) {
          if (!retryAutoTitle(stateOptions(sessionId), now()))
            return "already_attempted";
        } else if (!claimAutoTitle(stateOptions(sessionId)))
          return "already_attempted";
        let phase = "generate";
        try {
          const title = await generate({
            userPrompt: before.userPrompt,
            assistantText,
            toolNames: before.toolNames
          });
          const preApply = readContext(sessionId);
          if (preApply.customTitle !== null) {
            lockUserTitle({ ...stateOptions(sessionId), title: preApply.customTitle });
            return "existing";
          }
          if (preApply.aiTitle !== null) {
            failAutoTitle(stateOptions(sessionId));
            return "existing";
          }
          phase = "rename";
          await rename(sessionId, title, options.workspaceDir);
          phase = "readback";
          const readback = readContext(sessionId);
          if (readback.customTitle !== title)
            throw new Error("session title readback failed");
          if (!completeAutoTitle({ ...stateOptions(sessionId), title })) {
            throw new Error("session title state transition failed");
          }
          return "applied";
        } catch (error) {
          if (error instanceof SessionTitleGenerationError && error.retryable) {
            failAutoTitle({ ...stateOptions(sessionId), phase: error.phase, reason: error.reason, retryAt: now() + retryDelayMs });
          } else {
            const reason = phase === "rename" ? "rename_failed" : phase === "readback" ? "readback_failed" : "command_failed";
            failAutoTitle({ ...stateOptions(sessionId), phase, reason });
          }
          return "failed";
        }
      }, 30000);
    } catch {
      return "failed";
    }
  }
  async function renameUserSession(sessionId, rawTitle) {
    const title = normalizeManualTitle(rawTitle);
    return withSessionTitleLock(stateOptions(sessionId), async () => {
      await rename(sessionId, title, options.workspaceDir);
      const readback = readContext(sessionId);
      if (readback.customTitle !== title)
        throw new Error("session rename failed");
      try {
        lockUserTitle({ ...stateOptions(sessionId), title });
      } catch {}
      return title;
    }, 30000);
  }
  return { ensureAutoTitle, renameUserSession };
}

// packages/session-control-mcp/src/session-title-worker.ts
var SESSION_UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function runSessionTitleWorker(options) {
  if (!SESSION_UUID2.test(options.sessionId))
    throw new Error("invalid session identity");
  let result;
  if (options.ensure !== undefined) {
    result = await options.ensure();
  } else {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("authenticated title source is unavailable");
    }
    const telegramConfig = loadRuntimeConfig(options.telegramStateDir);
    const service = createSessionTitleService({
      projectSessionsDir: options.projectSessionsDir,
      workspaceDir: options.workspaceDir,
      isAuthorizedChat: (chatId) => {
        try {
          assertAuthorizedChat(telegramConfig, chatId);
          return true;
        } catch {
          return false;
        }
      }
    });
    result = await service.ensureAutoTitle(options.sessionId);
  }
  if (result === "failed")
    throw new Error("automatic title failed");
  return result;
}
if (import.meta.main) {
  try {
    const sessionId = process.argv[2];
    if (process.argv.length !== 3 || typeof sessionId !== "string")
      throw new Error("exactly one session ID is required");
    await runSessionTitleWorker({
      sessionId,
      workspaceDir: process.env.CLAUDE_WORKSPACE_DIR ?? "",
      projectSessionsDir: process.env.CLAUDE_PROJECT_SESSIONS_DIR ?? "",
      telegramStateDir: process.env.TELEGRAM_STATE_DIR ?? `${homedir2()}/.claude/channels/telegram`
    });
  } catch {
    process.exitCode = 1;
  }
}
export {
  runSessionTitleWorker
};
