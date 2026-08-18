import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeConfig {
  token: string;
  allowedChatIds: Set<string>;
}

export function assertAuthorizedChat(config: RuntimeConfig, chatId: string): void {
  if (!config.allowedChatIds.has(chatId)) throw new Error("chat is not authorized");
}

function assertSecureFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("channel state must be a regular file");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("channel state must have mode 0600");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("channel state must be owned by the sidecar user");
  }
}

export function loadRuntimeConfig(stateDir: string): RuntimeConfig {
  const envPath = join(stateDir, ".env");
  const accessPath = join(stateDir, "access.json");
  assertSecureFile(envPath);
  assertSecureFile(accessPath);

  const envText = readFileSync(envPath, "utf8");
  const tokenLines = envText
    .split(/\r?\n/)
    .filter(line => line.startsWith("TELEGRAM_BOT_TOKEN="));
  if (tokenLines.length !== 1) throw new Error("expected exactly one Telegram bot token");
  const token = tokenLines[0]!.slice("TELEGRAM_BOT_TOKEN=".length).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("invalid Telegram bot token format");

  const access = JSON.parse(readFileSync(accessPath, "utf8")) as {
    dmPolicy?: unknown;
    allowFrom?: unknown;
  };
  if (access.dmPolicy !== "allowlist") throw new Error("dmPolicy must be allowlist");
  if (!Array.isArray(access.allowFrom) || !access.allowFrom.every(value => typeof value === "string")) {
    throw new Error("invalid Telegram allowlist");
  }

  return { token, allowedChatIds: new Set(access.allowFrom) };
}
