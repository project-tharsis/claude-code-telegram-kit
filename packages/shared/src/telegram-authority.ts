import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { resolve } from "node:path";

export interface RuntimeConfig {
  token: string;
  allowedChatIds: Set<string>;
}

export interface RuntimeConfigOptions {
  allowMultipleChats?: boolean;
  /** Test hook used to verify directory-fd anchoring under pathname replacement. */
  onDirectoryOpened?: () => void;
}

export function assertAuthorizedChat(config: RuntimeConfig, chatId: string): void {
  if (!config.allowedChatIds.has(chatId)) throw new Error("chat is not authorized");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function openPrivateDirectory(path: string): number {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("channel state directory must be a real directory");
  }
  if (realpathSync(path) !== resolve(path)) {
    throw new Error("channel state directory must not traverse symlinks");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(fd);
    throw new Error("channel state directory changed during validation");
  }
  if ((opened.mode & 0o777) !== 0o700) {
    closeSync(fd);
    throw new Error("channel state directory must have mode 0700");
  }
  const uid = currentUid();
  if (uid !== undefined && opened.uid !== uid) {
    closeSync(fd);
    throw new Error("channel state directory must be owned by the sidecar user");
  }
  return fd;
}

function readSecureFileAt(directoryFd: number, name: ".env" | "access.json"): string {
  const anchoredPath = `/proc/self/fd/${directoryFd}/${name}`;
  const fd = openSync(anchoredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("channel state must be a single regular file");
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
  const directoryFd = openPrivateDirectory(stateDir);
  let envText: string;
  let accessText: string;
  try {
    options.onDirectoryOpened?.();
    envText = readSecureFileAt(directoryFd, ".env");
    accessText = readSecureFileAt(directoryFd, "access.json");
  } finally {
    closeSync(directoryFd);
  }

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
