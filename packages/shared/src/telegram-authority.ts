import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { join, resolve } from "node:path";

export interface RuntimeConfig {
  token: string;
  allowedChatIds: Set<string>;
}

export interface RuntimeConfigOptions {
  allowMultipleChats?: boolean;
}

export function assertAuthorizedChat(config: RuntimeConfig, chatId: string): void {
  if (!config.allowedChatIds.has(chatId)) throw new Error("chat is not authorized");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertPrivateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("channel state directory must be a real directory");
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error("channel state directory must have mode 0700");
  }
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error("channel state directory must be owned by the sidecar user");
  }
  if (realpathSync(path) !== resolve(path)) {
    throw new Error("channel state directory must not traverse symlinks");
  }
}

function readSecureFile(path: string): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("channel state must be a single regular file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("channel state changed during validation");
    }
    if ((opened.mode & 0o777) !== 0o600) {
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
    closeSync(fd);
  }
}

export function loadRuntimeConfig(stateDir: string, options: RuntimeConfigOptions = {}): RuntimeConfig {
  assertPrivateDirectory(stateDir);
  const envText = readSecureFile(join(stateDir, ".env"));
  const accessText = readSecureFile(join(stateDir, "access.json"));

  const tokenLines = envText
    .split(/\r?\n/)
    .filter(line => line.startsWith("TELEGRAM_BOT_TOKEN="));
  if (tokenLines.length !== 1) throw new Error("expected exactly one Telegram bot token");
  const token = tokenLines[0]!.slice("TELEGRAM_BOT_TOKEN=".length).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("invalid Telegram bot token format");

  const access = JSON.parse(accessText) as {
    dmPolicy?: unknown;
    allowFrom?: unknown;
  };
  if (access.dmPolicy !== "allowlist") throw new Error("dmPolicy must be allowlist");
  if (!Array.isArray(access.allowFrom) || !access.allowFrom.every(
    value => typeof value === "string" && /^\d+$/.test(value)
  )) {
    throw new Error("invalid Telegram allowlist");
  }
  const allowedChatIds = new Set(access.allowFrom);
  if (allowedChatIds.size !== access.allowFrom.length) {
    throw new Error("Telegram allowlist must not contain duplicates");
  }
  const allowMultipleChats = options.allowMultipleChats
    ?? process.env.TELEGRAM_ALLOW_MULTIPLE_CHATS === "true";
  if (!allowMultipleChats && allowedChatIds.size !== 1) {
    throw new Error("exactly one allowlisted chat is required by default");
  }

  return { token, allowedChatIds };
}
