import { describe, expect, test } from "bun:test";
import { UnifiedReplyInputSchema } from "../src/unified-contract.js";
import {
  createUnifiedDeliverer,
  RICH_CAPABILITY_COOLDOWN_MS,
  TelegramContentTooLargeError,
  TelegramUncertainOutcomeError,
  type UnifiedFetchLike
} from "../src/unified-delivery.js";
import {
  MAX_TELEGRAM_RESPONSE_BYTES,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const config: RuntimeConfig = {
  token: TEST_TOKEN,
  allowedChatIds: new Set(["123456789"])
};

function withReactionSupport(delivery: UnifiedFetchLike): UnifiedFetchLike {
  return async (input, init) => {
    if (String(input).endsWith("/setMessageReaction")) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return delivery(input, init);
  };
}

describe("unified deterministic delivery", () => {
  test("sends ordinary raw Markdown directly through MarkdownV2", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; init: RequestInit | undefined }> = [];
    const fakeFetch: UnifiedFetchLike = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)), init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const deliver = createUnifiedDeliverer(withReactionSupport(fakeFetch));
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "## 状态\n\n**在线**"
    });

    const receipt = await deliver(input, config);

    expect(receipt).toEqual({ mode: "markdownv2", messageIds: [77] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendMessage")).toBe(true);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeDefined();
    expect(calls[0]!.body).toEqual({
      chat_id: "123456789",
      reply_parameters: { message_id: 51 },
      parse_mode: "MarkdownV2",
      text: "*状态*\n\n*在线*"
    });
  });

  test("lets an explicit reply target override the inbound message", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const fakeFetch: UnifiedFetchLike = async (_input, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 78 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const deliver = createUnifiedDeliverer(withReactionSupport(fakeFetch));
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      reply_to: "49",
      content: "done"
    });

    await deliver(input, config);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.reply_parameters).toEqual({ message_id: 49 });
  });

  test("sends rich CJK tables through native Rich Message", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: UnifiedFetchLike = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const deliver = createUnifiedDeliverer(withReactionSupport(fakeFetch));
    const content = "## 持仓\n\n| 项目 | 状态 |\n|---|---|\n| 早盘 | 正常 |";
    const input = UnifiedReplyInputSchema.parse({ chat_id: "123456789", message_id: "51", content });

    const receipt = await deliver(input, config);

    expect(receipt).toEqual({ mode: "rich", messageIds: [88] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendRichMessage")).toBe(true);
    expect(calls[0]!.body).toEqual({
      chat_id: "123456789",
      reply_parameters: { message_id: 51 },
      rich_message: { markdown: content }
    });
  });

  test("falls back to plain text only after a permanent MarkdownV2 rejection", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: UnifiedFetchLike = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      const ok = calls.length === 2;
      return new Response(JSON.stringify(ok
        ? { ok: true, result: { message_id: 99 } }
        : { ok: false, description: "Bad Request" }), {
        status: ok ? 200 : 400,
        headers: { "content-type": "application/json" }
      });
    };
    const deliver = createUnifiedDeliverer(withReactionSupport(fakeFetch));
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "**Hello**."
    });

    const receipt = await deliver(input, config);

    expect(receipt).toEqual({ mode: "text", messageIds: [99] });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({
      chat_id: "123456789",
      reply_parameters: { message_id: 51 },
      text: "**Hello**."
    });
  });

  test("holds Rich off for the cooldown after a permanent endpoint failure", async () => {
    const methods: string[] = [];
    let messageId = 100;
    const fakeFetch: UnifiedFetchLike = async (input) => {
      const method = String(input).split("/").pop()!;
      methods.push(method);
      if (methods.length === 1) {
        return new Response(JSON.stringify({ ok: false, description: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      messageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const deliver = createUnifiedDeliverer(withReactionSupport(fakeFetch));
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "| A | B |\n|---|---|\n| 1 | 2 |"
    });

    expect((await deliver(input, config)).mode).toBe("markdownv2");
    expect((await deliver(input, config)).mode).toBe("markdownv2");
    expect(methods).toEqual(["sendRichMessage", "sendMessage", "sendMessage"]);
  });

  test("rejects oversized ordinary Markdown before any network call", async () => {
    let calls = 0;
    const deliver = createUnifiedDeliverer(withReactionSupport(async () => {
      calls += 1;
      throw new Error("network must not be called");
    }));
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      reply_to: "51",
      content: "a".repeat(5_000)
    });

    await expect(deliver(input, config)).rejects.toBeInstanceOf(TelegramContentTooLargeError);
    expect(calls).toBe(0);
  });

  test("never resends after an uncertain Rich transport failure", async () => {
    let calls = 0;
    const deliver = createUnifiedDeliverer(withReactionSupport(async () => {
      calls += 1;
      throw new TypeError("connection reset");
    }));
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "| A | B |\n|---|---|\n| 1 | 2 |"
    });

    await expect(deliver(input, config)).rejects.toThrow("outcome unknown");
    expect(calls).toBe(1);
  });

  test("treats an oversized Telegram response as unknown without fallback", async () => {
    let calls = 0;
    const deliver = createUnifiedDeliverer(async () => {
      calls += 1;
      return new Response("x".repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1), { status: 200 });
    });
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "done"
    });

    await expect(deliver(input, config)).rejects.toThrow("outcome unknown");
    expect(calls).toBe(1);
  });

  test("treats invalid Telegram response message IDs as unknown", async () => {
    for (const messageId of [0, -1, 9_007_199_254_740_992]) {
      let calls = 0;
      const deliver = createUnifiedDeliverer(async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      });
      const input = UnifiedReplyInputSchema.parse({
        chat_id: "123456789",
        message_id: "51",
        content: "done"
      });

      await expect(deliver(input, config)).rejects.toBeInstanceOf(TelegramUncertainOutcomeError);
      expect(calls).toBe(1);
    }
  });

  test("finalizes a successful reply with thumbs up", async () => {
    const methods: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const deliver = createUnifiedDeliverer(async (input, init) => {
      const method = String(input).split("/").pop()!;
      methods.push(method);
      bodies.push(JSON.parse(String(init?.body)));
      if (method === "setMessageReaction") {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
    });
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "done"
    });

    await deliver(input, config);

    expect(methods).toEqual(["sendMessage", "setMessageReaction"]);
    expect(bodies[1]).toEqual({
      chat_id: "123456789",
      message_id: 51,
      reaction: [{ type: "emoji", emoji: "👍" }]
    });
  });

  test("keeps a confirmed reply successful when reaction finalization fails", async () => {
    const previous = process.env.TELEGRAM_STATUS_STATE_DIR;
    process.env.TELEGRAM_STATUS_STATE_DIR = "/dev/null";
    try {
      const deliver = createUnifiedDeliverer(async (input) => {
        if (String(input).endsWith("/setMessageReaction")) {
          return new Response(JSON.stringify({ ok: false }), { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), { status: 200 });
      });
      const receipt = await deliver(UnifiedReplyInputSchema.parse({
        chat_id: "123456789",
        message_id: "53",
        content: "delivered"
      }), config);

      expect(receipt).toEqual({ mode: "markdownv2", messageIds: [88] });
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_STATUS_STATE_DIR;
      else process.env.TELEGRAM_STATUS_STATE_DIR = previous;
    }
  });

  test("types an unknown outcome so the acknowledgement survives it", async () => {
    const deliver = createUnifiedDeliverer(async () => { throw new TypeError("connection reset"); });
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "done"
    });

    await expect(deliver(input, config)).rejects.toBeInstanceOf(TelegramUncertainOutcomeError);
  });

  test("leaves failure reactions to the tool handler", async () => {
    const methods: string[] = [];
    const deliver = createUnifiedDeliverer(async input => {
      methods.push(String(input).split("/").pop()!);
      return new Response(JSON.stringify({ ok: false }), { status: 400 });
    });
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "done"
    });

    await expect(deliver(input, config)).rejects.toThrow("Telegram delivery rejected");
    expect(methods).toEqual(["sendMessage", "sendMessage"]);
  });

  test("absorbs Telegram tail latency instead of reporting an unknown outcome", async () => {
    const slow = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("/setMessageReaction")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        await Bun.sleep(3_500);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }), { status: 200 });
      }
    });
    try {
      const deliver = createUnifiedDeliverer((url, init) =>
        fetch(`http://127.0.0.1:${slow.port}/${String(url).split("/").pop()}`, init));
      const receipt = await deliver(UnifiedReplyInputSchema.parse({
        chat_id: "123456789",
        message_id: "51",
        content: "slow but delivered"
      }), config);

      expect(receipt).toEqual({ mode: "markdownv2", messageIds: [91] });
    } finally {
      slow.stop(true);
    }
  }, 20_000);

  test("re-probes Rich once the capability cooldown expires", async () => {
    const methods: string[] = [];
    let clock = 1_000;
    let messageId = 200;
    const fakeFetch: UnifiedFetchLike = async input => {
      const method = String(input).split("/").pop()!;
      methods.push(method);
      if (method === "sendRichMessage" && methods.length === 1) {
        return new Response(JSON.stringify({ ok: false, description: "Not Found" }), { status: 404 });
      }
      messageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
    };
    const deliver = createUnifiedDeliverer(withReactionSupport(fakeFetch), () => clock);
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      message_id: "51",
      content: "| A | B |\n|---|---|\n| 1 | 2 |"
    });

    expect((await deliver(input, config)).mode).toBe("markdownv2");
    clock += RICH_CAPABILITY_COOLDOWN_MS - 1;
    expect((await deliver(input, config)).mode).toBe("markdownv2");
    clock += 1;
    expect((await deliver(input, config)).mode).toBe("rich");
    expect(methods).toEqual([
      "sendRichMessage",
      "sendMessage",
      "sendMessage",
      "sendRichMessage"
    ]);
  });
});
