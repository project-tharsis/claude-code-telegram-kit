import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import {
  deleteTelegramCommandMenu,
  TELEGRAM_BOT_MENU_COMMANDS,
  syncTelegramCommandMenu
} from "../src/telegram-menu.js";

const config = (ids: string[]): RuntimeConfig => ({
  token: "123456789:" + "A".repeat(32),
  allowedChatIds: new Set(ids)
});

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("per-chat Telegram command menu", () => {
  test("advertises only implemented deterministic controls plus official commands", () => {
    expect(TELEGRAM_BOT_MENU_COMMANDS.map(item => item.command)).toEqual([
      "start", "help", "status", "usage", "sessions", "model", "reset"
    ]);
    expect(TELEGRAM_BOT_MENU_COMMANDS.map(item => item.command)).not.toContain("resume");
  });

  test("sets and reads back one private-chat scope without polling", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown>; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").at(-1)!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, body, ...(init === undefined ? {} : { init }) });
      return method === "setMyCommands"
        ? ok(true)
        : ok(TELEGRAM_BOT_MENU_COMMANDS.map((item: { command: string; description: string }) => ({
            description: item.description,
            command: item.command,
            is_ephemeral: false
          })));
    };

    await expect(syncTelegramCommandMenu(config(["123", "-100456"]), fetchImpl)).resolves.toBe(1);
    expect(calls.map(call => call.method)).toEqual(["setMyCommands", "getMyCommands"]);
    expect(calls.every(call => call.method !== "getUpdates")).toBe(true);
    expect(calls[0]!.body).toEqual({
      commands: TELEGRAM_BOT_MENU_COMMANDS,
      scope: { type: "chat", chat_id: "123" }
    });
    expect(calls[1]!.body).toEqual({ scope: { type: "chat", chat_id: "123" } });
    expect(calls.every(call => call.init?.redirect === "error")).toBe(true);
  });

  test("skips group-only authority and rejects failed or mismatched readback", async () => {
    let calls = 0;
    const never = async () => { calls += 1; return ok(true); };
    await expect(syncTelegramCommandMenu(config(["-100456"]), never)).resolves.toBe(0);
    expect(calls).toBe(0);

    await expect(syncTelegramCommandMenu(config(["123"]), async input =>
      String(input).endsWith("setMyCommands") ? ok(true) : ok([{ command: "start", description: "wrong" }])
    )).rejects.toThrow("command menu sync failed");

    await expect(syncTelegramCommandMenu(config(["123"]), async () =>
      new Response(JSON.stringify({ ok: false }), { status: 400 })
    )).rejects.toThrow("command menu sync failed");
  });

  test("deletes and reads back an empty scope before allowlist removal", async () => {
    const methods: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").at(-1)!;
      methods.push(method);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return method === "deleteMyCommands" ? ok(true) : ok([]);
    };
    await expect(deleteTelegramCommandMenu(config(["123"]), fetchImpl)).resolves.toBe(1);
    expect(methods).toEqual(["deleteMyCommands", "getMyCommands"]);
    expect(bodies).toEqual([
      { scope: { type: "chat", chat_id: "123" } },
      { scope: { type: "chat", chat_id: "123" } }
    ]);
  });
});
