import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createResetScheduler,
  sendTelegramMessage,
  type CommandRunner,
  type FetchLike
} from "../src/runtime.js";
import {
  MAX_TELEGRAM_RESPONSE_BYTES,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const config: RuntimeConfig = {
  token: TEST_TOKEN,
  allowedChatIds: new Set(["123456789"])
};

describe("control runtime boundaries", () => {
  test("sends the exact ACK wire and requires a message receipt", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)), init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const id = await sendTelegramMessage(config, "123456789", "Reset accepted", fetchImpl);

    expect(id).toBe(71);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendMessage")).toBe(true);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeDefined();
    expect(calls[0]!.body).toEqual({ chat_id: "123456789", text: "Reset accepted" });
  });

  test("rejects an unauthorized chat before the Telegram request", async () => {
    let calls = 0;
    await expect(sendTelegramMessage(config, "999", "Reset accepted", async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), { status: 200 });
    })).rejects.toThrow("chat is not authorized");
    expect(calls).toBe(0);
  });

  test("rejects an oversized ACK response", async () => {
    await expect(sendTelegramMessage(
      config,
      "123456789",
      "Reset accepted",
      async () => new Response("x".repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1), { status: 200 })
    )).rejects.toThrow("notification failed");
  });

  test("constructs one fixed no-shell systemd-run command", async () => {
    const argvSeen: string[][] = [];
    const runner: CommandRunner = async argv => {
      argvSeen.push(argv);
      return { exitCode: 0, stderr: "" };
    };
    const schedule = createResetScheduler({
      run: runner,
      verifyHelper: () => undefined
    });
    const requestId = createHash("sha256").update("123456789:51").digest("hex").slice(0, 24);

    const unit = await schedule("123456789", "51");

    expect(unit).toBe(`claude-session-reset-${requestId}`);
    expect(argvSeen).toEqual([[
      "/usr/bin/sudo",
      "-n",
      "/usr/bin/systemd-run",
      `--unit=${requestId ? `claude-session-reset-${requestId}` : ""}`,
      "--collect",
      "--no-block",
      "/usr/local/sbin/claude-code-session-reset",
      "--config",
      "/etc/claude-code-telegram-kit/reset.json",
      "--chat-id",
      "123456789",
      "--request-id",
      requestId
    ]]);
  });

  test("rejects an invalid chat ID before systemd-run", async () => {
    let calls = 0;
    const schedule = createResetScheduler({
      run: async () => { calls += 1; return { exitCode: 0, stderr: "" }; },
      verifyHelper: () => undefined
    });

    await expect(schedule("1;rm -rf /", "51")).rejects.toThrow("invalid chat ID");
    expect(calls).toBe(0);
  });
});
