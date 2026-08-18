import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type CommandRunner = (argv: string[]) => Promise<{ exitCode: number; stderr: string }>;

const DEFAULT_HELPER = "/usr/local/sbin/claude-code-session-reset";
const DEFAULT_CONFIG = "/etc/claude-code-telegram-kit/reset.json";
const DEFAULT_UNIT_PREFIX = "claude-session-reset";

interface TelegramEnvelope {
  ok?: unknown;
  result?: { message_id?: unknown };
}

export async function sendTelegramMessage(
  config: RuntimeConfig,
  chatId: string,
  text: string,
  fetchImpl: FetchLike = fetch
): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
      }
    );
  } catch {
    throw new Error("Telegram control notification failed");
  }
  let envelope: TelegramEnvelope;
  try {
    envelope = await response.json() as TelegramEnvelope;
  } catch {
    throw new Error("Telegram control notification failed");
  }
  const messageId = envelope.result?.message_id;
  if (!response.ok || envelope.ok !== true || typeof messageId !== "number" || !Number.isInteger(messageId)) {
    throw new Error("Telegram control notification failed");
  }
  return messageId;
}

async function defaultRunner(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    child.stderr ? new Response(child.stderr).text() : Promise.resolve("")
  ]);
  return { exitCode, stderr: stderr.slice(0, 4_096) };
}

function assertAbsolutePath(value: string, label: string): void {
  if (!value.startsWith("/") || value.includes("\0")) throw new Error(`${label} must be an absolute path`);
}

function verifyRootOwnedFile(path: string, mode: number, label: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (info.uid !== 0 || (info.mode & 0o777) !== mode || info.nlink !== 1) {
    throw new Error(`${label} ownership or mode is invalid`);
  }
}

export function createResetScheduler(options: {
  run?: CommandRunner;
  verifyHelper?: () => void;
  helperPath?: string;
  configPath?: string;
  unitPrefix?: string;
} = {}) {
  const run = options.run ?? defaultRunner;
  const helperPath = options.helperPath ?? process.env.CLAUDE_SESSION_RESET_HELPER ?? DEFAULT_HELPER;
  const configPath = options.configPath ?? process.env.CLAUDE_SESSION_RESET_CONFIG ?? DEFAULT_CONFIG;
  const unitPrefix = options.unitPrefix ?? process.env.CLAUDE_SESSION_RESET_UNIT_PREFIX ?? DEFAULT_UNIT_PREFIX;
  assertAbsolutePath(helperPath, "reset helper");
  assertAbsolutePath(configPath, "reset config");
  if (!/^[A-Za-z0-9_.@-]+$/.test(unitPrefix)) throw new Error("invalid reset unit prefix");

  const verifyHelper = options.verifyHelper ?? (() => {
    verifyRootOwnedFile(helperPath, 0o755, "reset helper");
    verifyRootOwnedFile(configPath, 0o644, "reset config");
  });

  return async (chatId: string, messageId: string): Promise<string> => {
    if (!/^\d+$/.test(chatId)) throw new Error("invalid chat ID");
    if (!/^\d+$/.test(messageId)) throw new Error("invalid message ID");
    verifyHelper();
    const id = createHash("sha256").update(`${chatId}:${messageId}`).digest("hex").slice(0, 24);
    const unit = `${unitPrefix}-${id}`;
    const argv = [
      "/usr/bin/sudo",
      "-n",
      "/usr/bin/systemd-run",
      `--unit=${unit}`,
      "--collect",
      "--no-block",
      helperPath,
      "--config",
      configPath,
      "--chat-id",
      chatId,
      "--request-id",
      id
    ];
    const result = await run(argv);
    if (result.exitCode !== 0) throw new Error("systemd rejected the reset job");
    return unit;
  };
}
