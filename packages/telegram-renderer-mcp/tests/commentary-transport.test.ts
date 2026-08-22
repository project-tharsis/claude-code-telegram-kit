import { describe, expect, test } from "bun:test";
import {
  INTERIM_COMMENTARY_TIMEOUT_MS,
  sendInterimCommentary
} from "../src/progress-transport.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
describe("interim commentary transport", () => {
  test("is silent, quoted, MarkdownV2, and does not invoke reactions", async () => {
    let url = "";
    const result = await sendInterimCommentary(config, "123", "9", "**hello**", async (input, init) => {
      url = String(input);
      const body = JSON.parse(String(init!.body));
      expect(body.disable_notification).toBe(true);
      expect(body.reply_parameters).toEqual({ message_id: 9 });
      expect(body.parse_mode).toBe("MarkdownV2");
      return reply(200, { ok: true, result: { message_id: 5 } });
    });
    expect(result).toBe("delivered");
    expect(url).toContain("/sendMessage");
  });
  test("unauthorized is before network; uncertain outcomes are terminal", async () => {
    let calls = 0;
    await expect(sendInterimCommentary(config, "999", "9", "x", async () => { calls += 1; return reply(200, {}); })).rejects.toThrow();
    expect(calls).toBe(0);
    for (const result of [
      await sendInterimCommentary(config, "123", "9", "x", async () => { throw new Error("timeout"); }),
      await sendInterimCommentary(config, "123", "9", "x", async () => reply(429, {})),
      await sendInterimCommentary(config, "123", "9", "x", async () => reply(500, {})),
      await sendInterimCommentary(config, "123", "9", "x", async () => new Response("bad", { status: 200 }))
    ]) expect(result).toBe("uncertain");
  });
  test("a stalled request aborts on the short commentary handoff budget", async () => {
    const started = performance.now();
    const result = await sendInterimCommentary(config, "123", "9", "x", async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    expect(result).toBe("uncertain");
    expect(performance.now() - started).toBeLessThan(INTERIM_COMMENTARY_TIMEOUT_MS + 500);
  });

  test("400 is rejected", async () => {
    expect(await sendInterimCommentary(config, "123", "9", "x", async () => reply(400, {}))).toBe("rejected");
  });
});
