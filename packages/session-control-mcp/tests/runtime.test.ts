import { describe, expect, test } from "bun:test";
import {
  createResetScheduler,
  sendTelegramMessage,
  type CommandRunner,
  type FetchLike
} from "../src/runtime.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const config: RuntimeConfig = {
  token: TEST_TOKEN,
  allowedChatIds: new Set(["123456789"])
};

describe("control runtime boundaries", () => {
  test("sends the exact ACK wire and requires a message receipt", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const id = await sendTelegramMessage(config, "123456789", "Reset accepted", fetchImpl);

    expect(id).toBe(71);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendMessage")).toBe(true);
    expect(calls[0]!.body).toEqual({ chat_id: "123456789", text: "Reset accepted" });
  });

  test("constructs one fixed no-shell systemd-run command", async () => {
    const argvSeen: string[][] = [];
    const runner: CommandRunner = async argv => {
      argvSeen.push(argv);
      return { exitCode: 0, stderr: "" };
    };
    const schedule = createResetScheduler({
      run: runner,
      requestId: () => "abcdef123456",
      verifyHelper: () => undefined
    });

    const unit = await schedule("123456789");

    expect(unit).toBe("claude-session-reset-abcdef123456");
    expect(argvSeen).toEqual([[
      "/usr/bin/sudo",
      "-n",
      "/usr/bin/systemd-run",
      "--unit=claude-session-reset-abcdef123456",
      "--collect",
      "--no-block",
      "/usr/local/sbin/claude-code-session-reset",
      "--config",
      "/etc/claude-code-telegram-kit/reset.json",
      "--chat-id",
      "123456789"
    ]]);
  });

  test("rejects an invalid chat ID before systemd-run", async () => {
    let calls = 0;
    const schedule = createResetScheduler({
      run: async () => { calls += 1; return { exitCode: 0, stderr: "" }; },
      requestId: () => "abcdef123456",
      verifyHelper: () => undefined
    });

    await expect(schedule("1;rm -rf /")).rejects.toThrow("invalid chat ID");
    expect(calls).toBe(0);
  });
});
