import {
  readTelegramJson,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

export type MenuFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export const TELEGRAM_BOT_MENU_COMMANDS = [
  { command: "start", description: "Welcome and setup guide" },
  { command: "help", description: "What this bot can do" },
  { command: "status", description: "Check your pairing status" },
  { command: "usage", description: "Show Claude subscription usage" },
  { command: "resume", description: "List or resume recent sessions" },
  { command: "model", description: "Show or switch Claude model" },
  { command: "reset", description: "Start a confirmed fresh session" }
] as const;

const PRIVATE_CHAT_ID = /^[1-9]\d{0,19}$/;
const MENU_TIMEOUT_MS = 10_000;

interface TelegramMenuEnvelope {
  ok?: unknown;
  result?: unknown;
}

function menuMatches(readback: unknown): boolean {
  return Array.isArray(readback)
    && readback.length === TELEGRAM_BOT_MENU_COMMANDS.length
    && readback.every((item, index) => {
      if (typeof item !== "object" || item === null) return false;
      const command = item as { command?: unknown; description?: unknown };
      const expected = TELEGRAM_BOT_MENU_COMMANDS[index]!;
      return command.command === expected.command && command.description === expected.description;
    });
}

async function callMenuApi(
  config: RuntimeConfig,
  method: "setMyCommands" | "getMyCommands" | "deleteMyCommands",
  body: Record<string, unknown>,
  fetchImpl: MenuFetch
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${config.token}/${method}`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MENU_TIMEOUT_MS)
      }
    );
  } catch {
    throw new Error("Telegram command menu sync failed");
  }

  let envelope: TelegramMenuEnvelope;
  try {
    envelope = await readTelegramJson(response) as TelegramMenuEnvelope;
  } catch {
    throw new Error("Telegram command menu sync failed");
  }
  if (!response.ok || envelope.ok !== true) {
    throw new Error("Telegram command menu sync failed");
  }
  return envelope.result;
}

export async function syncTelegramCommandMenu(
  config: RuntimeConfig,
  fetchImpl: MenuFetch = fetch
): Promise<number> {
  const privateChatIds = [...config.allowedChatIds]
    .filter(chatId => PRIVATE_CHAT_ID.test(chatId))
    .sort();

  for (const chatId of privateChatIds) {
    const scope = { type: "chat", chat_id: chatId } as const;
    const setResult = await callMenuApi(config, "setMyCommands", {
      commands: TELEGRAM_BOT_MENU_COMMANDS,
      scope
    }, fetchImpl);
    if (setResult !== true) throw new Error("Telegram command menu sync failed");

    const readback = await callMenuApi(config, "getMyCommands", { scope }, fetchImpl);
    if (!menuMatches(readback)) {
      throw new Error("Telegram command menu sync failed");
    }
  }
  return privateChatIds.length;
}

export async function deleteTelegramCommandMenu(
  config: RuntimeConfig,
  fetchImpl: MenuFetch = fetch
): Promise<number> {
  const privateChatIds = [...config.allowedChatIds]
    .filter(chatId => PRIVATE_CHAT_ID.test(chatId))
    .sort();

  for (const chatId of privateChatIds) {
    const scope = { type: "chat", chat_id: chatId } as const;
    const deleted = await callMenuApi(config, "deleteMyCommands", { scope }, fetchImpl);
    if (deleted !== true) throw new Error("Telegram command menu sync failed");
    const readback = await callMenuApi(config, "getMyCommands", { scope }, fetchImpl);
    if (!Array.isArray(readback) || readback.length !== 0) {
      throw new Error("Telegram command menu sync failed");
    }
  }
  return privateChatIds.length;
}
