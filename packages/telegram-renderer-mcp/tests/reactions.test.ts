import { describe, expect, test } from "bun:test";
import {
  finalizeReaction,
  type ReactionFetchLike
} from "../src/reactions.js";
import {
  MAX_TELEGRAM_RESPONSE_BYTES,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

const config: RuntimeConfig = {
  token: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
  allowedChatIds: new Set(["123456789"])
};

describe("Telegram reaction finalization", () => {
  test("uses a bounded no-redirect request and sends the exact success wire", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: ReactionFetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };

    const result = await finalizeReaction(config, "123456789", "51", "success", { fetchImpl });

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeDefined();
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      chat_id: "123456789",
      message_id: 51,
      reaction: [{ type: "emoji", emoji: "👍" }]
    });
  });

  test("returns false without throwing when the reaction API fails", async () => {
    const result = await finalizeReaction(config, "123456789", "52", "failure", {
      fetchImpl: async () => { throw new TypeError("connection reset"); }
    });

    expect(result).toBe(false);
  });

  test("rejects an oversized reaction response", async () => {
    const result = await finalizeReaction(config, "123456789", "52", "success", {
      fetchImpl: async () => new Response("x".repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1), { status: 200 })
    });

    expect(result).toBe(false);
  });

  test("rejects a lossy message ID before any network call", async () => {
    let calls = 0;
    await expect(finalizeReaction(config, "123456789", "9007199254740992", "success", {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
    })).rejects.toThrow("invalid message ID");
    expect(calls).toBe(0);
  });
});
