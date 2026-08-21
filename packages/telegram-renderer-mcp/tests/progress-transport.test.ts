import { describe, expect, test } from "bun:test";
import {
  editProgressBubble,
  sendProgressBubble,
  sendTypingAction
} from "../src/progress-transport.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("typing heartbeat transport", () => {
  test("sends one authorized typing action with redirects disabled", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await sendTypingAction(config, "123", async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return reply(200, { ok: true, result: true });
    });
    expect(outcome).toBe("sent");
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot1:tok/sendChatAction");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ chat_id: "123", action: "typing" });
  });

  test("classifies throttle, permanent refusal, and transient failures", async () => {
    expect(await sendTypingAction(config, "123", async () => reply(429, { ok: false }))).toBe("throttled");
    expect(await sendTypingAction(config, "123", async () => reply(400, { ok: false }))).toBe("rejected");
    expect(await sendTypingAction(config, "123", async () => reply(500, { ok: false }))).toBe("transient");
    expect(await sendTypingAction(config, "123", async () => { throw new Error("network"); })).toBe("transient");
  });

  test("rejects unauthorized chats before network I/O", async () => {
    let called = false;
    await expect(sendTypingAction(config, "999", async () => {
      called = true;
      return reply(200, { ok: true, result: true });
    })).rejects.toThrow("chat is not authorized");
    expect(called).toBe(false);
  });
});

describe("progress bubble send", () => {
  test("sends silently, quotes the inbound message, and rejects redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await sendProgressBubble(
      config,
      "123",
      "9",
      "Tinkering…\n💻 terminal\n```shell\nls <x>\n```",
      async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return reply(200, { ok: true, result: { message_id: 55 } });
    });

    expect(outcome).toEqual({ kind: "sent", messageId: 55 });
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot1:tok/sendMessage");
    expect(calls[0]!.init.redirect).toBe("error");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      chat_id: "123",
      text: "<b>✦ Tinkering…</b>\n\n💻 terminal\n<pre><code class=\"language-shell\">ls &lt;x&gt;</code></pre>",
      parse_mode: "HTML",
      disable_notification: true,
      reply_parameters: { message_id: 9 }
    });
  });

  test("refuses an unauthorized chat before any request", async () => {
    let called = false;
    await expect(sendProgressBubble(config, "999", "9", "x", async () => {
      called = true;
      return reply(200, { ok: true, result: { message_id: 1 } });
    })).rejects.toThrow("chat is not authorized");
    expect(called).toBe(false);
  });

  test("a timeout, a 429, and a 5xx are all uncertain, never rejected", async () => {
    expect(await sendProgressBubble(config, "123", "9", "x", async () => {
      throw new Error("timed out");
    })).toEqual({ kind: "uncertain" });
    expect(await sendProgressBubble(config, "123", "9", "x", async () =>
      reply(429, { ok: false, description: "Too Many Requests: retry after 30" })
    )).toEqual({ kind: "uncertain" });
    expect(await sendProgressBubble(config, "123", "9", "x", async () =>
      reply(502, { ok: false, description: "Bad Gateway" })
    )).toEqual({ kind: "uncertain" });
  });

  test("an unparseable or lossy body is uncertain rather than a fake success", async () => {
    expect(await sendProgressBubble(config, "123", "9", "x", async () =>
      new Response("not json", { status: 200 })
    )).toEqual({ kind: "uncertain" });
    expect(await sendProgressBubble(config, "123", "9", "x", async () =>
      reply(200, { ok: true, result: { message_id: 0 } })
    )).toEqual({ kind: "uncertain" });
  });

  test("a definitive bad request creates no message", async () => {
    expect(await sendProgressBubble(config, "123", "9", "x", async () =>
      reply(400, { ok: false, description: "Bad Request: chat not found" })
    )).toEqual({ kind: "rejected" });
  });
});

describe("progress bubble edit", () => {
  test("edits an existing bubble in place", async () => {
    const calls: string[] = [];
    const outcome = await editProgressBubble(config, "123", 55, "Done\n📖 Reading auth.ts", async (url, init) => {
      calls.push(String(url));
      expect(JSON.parse(String(init!.body))).toEqual({
        chat_id: "123",
        message_id: 55,
        text: "<b>✓ Done</b>\n\n📖 Reading auth.ts",
        parse_mode: "HTML"
      });
      return reply(200, { ok: true, result: { message_id: 55 } });
    });
    expect(outcome).toEqual({ kind: "edited" });
    expect(calls[0]).toBe("https://api.telegram.org/bot1:tok/editMessageText");
  });

  test("accepts a boolean result", async () => {
    expect(await editProgressBubble(config, "123", 55, "Done", async () =>
      reply(200, { ok: true, result: true })
    )).toEqual({ kind: "edited" });
  });

  test("treats an unmodified message as already current", async () => {
    expect(await editProgressBubble(config, "123", 55, "Done", async () =>
      reply(400, { ok: false, description: "Bad Request: message is not modified" })
    )).toEqual({ kind: "unchanged" });
  });

  test("classifies a lost or uneditable bubble as gone", async () => {
    for (const description of [
      "Bad Request: message to edit not found",
      "Bad Request: message can't be edited",
      "Bad Request: MESSAGE_ID_INVALID"
    ]) {
      expect(await editProgressBubble(config, "123", 55, "Done", async () =>
        reply(400, { ok: false, description })
      )).toEqual({ kind: "gone" });
    }
    expect(await editProgressBubble(config, "123", 55, "Done", async () =>
      reply(404, { ok: false, description: "Not Found" })
    )).toEqual({ kind: "gone" });
  });

  test("keeps identity for network/server failures but trips a turn-level breaker on 429", async () => {
    expect(await editProgressBubble(config, "123", 55, "Done", async () => {
      throw new Error("network");
    })).toEqual({ kind: "transient" });
    expect(await editProgressBubble(config, "123", 55, "Done", async () =>
      reply(429, { ok: false, description: "Too Many Requests: retry after 30" })
    )).toEqual({ kind: "throttled" });
    expect(await editProgressBubble(config, "123", 55, "Done", async () =>
      reply(500, { ok: false, description: "Internal Server Error" })
    )).toEqual({ kind: "transient" });
  });

  test("stops on any other permanent refusal instead of resending", async () => {
    expect(await editProgressBubble(config, "123", 55, "Done", async () =>
      reply(400, { ok: false, description: "Bad Request: chat not found" })
    )).toEqual({ kind: "rejected" });
  });

  test("refuses an unauthorized chat before any request", async () => {
    await expect(editProgressBubble(config, "999", 55, "x", async () =>
      reply(200, { ok: true, result: true })
    )).rejects.toThrow("chat is not authorized");
  });
});
