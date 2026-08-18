import { describe, expect, test } from "bun:test";
import { UnifiedReplyInputSchema } from "../src/unified-contract.js";
import { createUnifiedDeliverer, type UnifiedFetchLike } from "../src/unified-delivery.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const config: RuntimeConfig = {
  token: TEST_TOKEN,
  allowedChatIds: new Set(["123456789"])
};

describe("unified deterministic delivery", () => {
  test("sends ordinary raw Markdown directly through MarkdownV2", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: UnifiedFetchLike = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const deliver = createUnifiedDeliverer(fakeFetch);
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      content: "## 状态\n\n**在线**"
    });

    const receipt = await deliver(input, config);

    expect(receipt).toEqual({ mode: "markdownv2", messageIds: [77] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendMessage")).toBe(true);
    expect(calls[0]!.body).toEqual({
      chat_id: "123456789",
      parse_mode: "MarkdownV2",
      text: "*状态*\n\n*在线*"
    });
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
    const deliver = createUnifiedDeliverer(fakeFetch);
    const content = "## 持仓\n\n| 项目 | 状态 |\n|---|---|\n| 早盘 | 正常 |";
    const input = UnifiedReplyInputSchema.parse({ chat_id: "123456789", content });

    const receipt = await deliver(input, config);

    expect(receipt).toEqual({ mode: "rich", messageIds: [88] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendRichMessage")).toBe(true);
    expect(calls[0]!.body).toEqual({
      chat_id: "123456789",
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
    const deliver = createUnifiedDeliverer(fakeFetch);
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      content: "**Hello**."
    });

    const receipt = await deliver(input, config);

    expect(receipt).toEqual({ mode: "text", messageIds: [99] });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ chat_id: "123456789", text: "**Hello**." });
  });

  test("latches Rich capability off after a permanent endpoint failure", async () => {
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
    const deliver = createUnifiedDeliverer(fakeFetch);
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      content: "| A | B |\n|---|---|\n| 1 | 2 |"
    });

    expect((await deliver(input, config)).mode).toBe("markdownv2");
    expect((await deliver(input, config)).mode).toBe("markdownv2");
    expect(methods).toEqual(["sendRichMessage", "sendMessage", "sendMessage"]);
  });

  test("chunks oversized ordinary Markdown before sending", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let id = 200;
    const fakeFetch: UnifiedFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      id += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: id } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const deliver = createUnifiedDeliverer(fakeFetch);
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      reply_to: "51",
      content: "a".repeat(5_000)
    });

    const receipt = await deliver(input, config);

    expect(receipt).toEqual({ mode: "markdownv2", messageIds: [201, 202] });
    expect(bodies).toHaveLength(2);
    expect(bodies.every(body => String(body.text).length <= 4_096)).toBe(true);
    expect(bodies.map(body => String(body.text)).join("")).toBe("a".repeat(5_000));
    expect(bodies[0]!.reply_parameters).toEqual({ message_id: 51 });
    expect(bodies[1]!.reply_parameters).toBeUndefined();
  });

  test("never resends after an uncertain Rich transport failure", async () => {
    let calls = 0;
    const deliver = createUnifiedDeliverer(async () => {
      calls += 1;
      throw new TypeError("connection reset");
    });
    const input = UnifiedReplyInputSchema.parse({
      chat_id: "123456789",
      content: "| A | B |\n|---|---|\n| 1 | 2 |"
    });

    await expect(deliver(input, config)).rejects.toThrow("outcome unknown");
    expect(calls).toBe(1);
  });
});
