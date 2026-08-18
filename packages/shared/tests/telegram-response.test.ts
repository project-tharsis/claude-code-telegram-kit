import { describe, expect, test } from "bun:test";
import {
  MAX_TELEGRAM_RESPONSE_BYTES,
  readTelegramJson
} from "../src/telegram-response.js";

describe("bounded Telegram JSON responses", () => {
  test("parses a normal response", async () => {
    const response = new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { "content-type": "application/json" }
    });
    await expect(readTelegramJson(response)).resolves.toEqual({ ok: true, result: true });
  });

  test("rejects a content-length above the cap", async () => {
    const response = new Response("{}", {
      headers: { "content-length": String(MAX_TELEGRAM_RESPONSE_BYTES + 1) }
    });
    await expect(readTelegramJson(response)).rejects.toThrow("response too large");
  });

  test("stops streaming once the cap is crossed", async () => {
    const body = JSON.stringify({ ok: true, padding: "x".repeat(MAX_TELEGRAM_RESPONSE_BYTES) });
    const response = new Response(body);
    await expect(readTelegramJson(response)).rejects.toThrow("response too large");
  });
});
