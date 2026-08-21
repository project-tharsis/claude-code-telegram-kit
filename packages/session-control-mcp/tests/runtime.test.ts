import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROKER_PROTOCOL_VERSION,
  callControlBroker,
  createResetScheduler,
  createSessionScheduler,
  HELPER_PROTOCOL_VERSION,
  probeHelperCapabilities,
  sendTelegramMessage,
  type BrokerCall,
  type FetchLike
} from "../src/runtime.js";
import { MAX_TELEGRAM_RESPONSE_BYTES, type RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const config: RuntimeConfig = { token: TEST_TOKEN, allowedChatIds: new Set(["123456789"]) };
const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function broker(response: unknown, seen: unknown[] = []): BrokerCall {
  return async request => { seen.push(request); return response; };
}

function capabilities(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    capabilities: {
      protocol: HELPER_PROTOCOL_VERSION,
      actions: ["reset", "resume", "model"],
      models: ["opus", "sonnet", "haiku", "inherit"],
      ...overrides
    }
  };
}

async function unixServer(handler: (socket: Socket) => void): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "control-socket-"));
  roots.push(root);
  const path = join(root, "control.sock");
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject));
  return path;
}

describe("control Telegram notification", () => {
  test("sends the exact quoted ACK wire and requires a message receipt", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)), init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), { status: 200 });
    };
    expect(await sendTelegramMessage(config, "123456789", "Reset accepted", fetchImpl, "51")).toBe(71);
    expect(calls[0]!.url.endsWith("/sendMessage")).toBe(true);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeDefined();
    expect(calls[0]!.body).toEqual({ chat_id: "123456789", text: "Reset accepted", reply_parameters: { message_id: 51 } });
  });

  test("adds HTML and a reply keyboard only when requested", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 73 } }), { status: 200 });
    };
    const replyMarkup = { keyboard: [[{ text: "1 · Opus" }]], one_time_keyboard: true };
    await sendTelegramMessage(config, "123456789", "<b>Usage</b>", fetchImpl, "51", "HTML", replyMarkup);
    expect(bodies[0]).toEqual({ chat_id: "123456789", text: "<b>Usage</b>", parse_mode: "HTML", reply_markup: replyMarkup, reply_parameters: { message_id: 51 } });
  });

  test("rejects unauthorized, lossy, oversized, and malformed outcomes", async () => {
    let calls = 0;
    await expect(sendTelegramMessage(config, "999", "x", async () => { calls += 1; return new Response(); })).rejects.toThrow("not authorized");
    await expect(sendTelegramMessage(config, "123456789", "x", async () => { calls += 1; return new Response(); }, "9007199254740993")).rejects.toThrow("invalid reply");
    expect(calls).toBe(0);
    await expect(sendTelegramMessage(config, "123456789", "x", async () => new Response("x".repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1), { status: 200 }))).rejects.toThrow("notification failed");
    await expect(sendTelegramMessage(config, "123456789", "x", async () => new Response("not json", { status: 200 }))).rejects.toThrow("notification failed");
  });
});

describe("Unix control broker transport", () => {
  test("sends one JSON line and accepts one bounded JSON response", async () => {
    let request = "";
    const path = await unixServer(socket => {
      socket.on("data", chunk => {
        request += chunk.toString();
        if (request.endsWith("\n")) {
          socket.end(`{"status":"ok","capabilities":{"protocol":${HELPER_PROTOCOL_VERSION},"actions":["reset","resume","model"],"models":["opus","sonnet","haiku","inherit"]}}\n`);
        }
      });
    });
    const result = await callControlBroker({ protocol: BROKER_PROTOCOL_VERSION, action: "capabilities" }, { socketPath: path });
    expect(JSON.parse(request)).toEqual({ protocol: BROKER_PROTOCOL_VERSION, action: "capabilities" });
    expect((result as { status: string }).status).toBe("ok");
  });

  test("bounds timeout and malformed responses", async () => {
    const hanging = await unixServer(() => undefined);
    await expect(callControlBroker({ protocol: BROKER_PROTOCOL_VERSION, action: "capabilities" }, { socketPath: hanging, timeoutMs: 20 })).rejects.toThrow("timed out");
    const malformed = await unixServer(socket => socket.end("{}\n{}\n"));
    await expect(callControlBroker({ protocol: BROKER_PROTOCOL_VERSION, action: "capabilities" }, { socketPath: malformed })).rejects.toThrow("malformed");
  });
});

describe("session scheduler broker contract", () => {
  test("sends bounded reset, resume, and model requests", async () => {
    const seen: unknown[] = [];
    const scheduler = createSessionScheduler({ callBroker: broker({ status: "scheduled", unit: `claude-session-reset-${"a".repeat(24)}` }, seen) });
    expect(await scheduler.scheduleReset("123", "51", SESSION)).toMatch(/^claude-session-reset-/);
    const resume = createSessionScheduler({ callBroker: broker({ status: "scheduled", unit: `claude-session-reset-resume-${"b".repeat(24)}` }, seen) });
    await resume.scheduleResume("123", "52", SESSION, SESSION);
    const model = createSessionScheduler({ callBroker: broker({ status: "scheduled", unit: `claude-session-reset-model-${"c".repeat(24)}` }, seen) });
    await model.scheduleModel("123", "53", "sonnet");
    expect(seen).toEqual([
      { protocol: BROKER_PROTOCOL_VERSION, action: "reset", chat_id: "123", message_id: "51", current_session_id: SESSION },
      { protocol: BROKER_PROTOCOL_VERSION, action: "resume", chat_id: "123", message_id: "52", current_session_id: SESSION, session_id: SESSION },
      { protocol: BROKER_PROTOCOL_VERSION, action: "model", chat_id: "123", message_id: "53", model: "sonnet" }
    ]);
  });

  test("rejects malformed identity and broker receipts", async () => {
    const schedule = createResetScheduler({ callBroker: broker({ status: "scheduled", unit: "evil.service" }) });
    await expect(schedule("123", "51", SESSION)).rejects.toThrow("rejected");
    const scheduler = createSessionScheduler({ callBroker: broker({ status: "scheduled", unit: `claude-session-reset-resume-${"a".repeat(24)}` }) });
    await expect(scheduler.scheduleReset("123", "51", "bad")).rejects.toThrow("current session UUID");
    await expect(scheduler.scheduleResume("123", "51", "bad", SESSION)).rejects.toThrow("current session UUID");
    await expect(scheduler.scheduleModel("123", "51", "other" as "sonnet")).rejects.toThrow("model alias");
  });
});

describe("broker capability preflight", () => {
  test("accepts the current helper protocol and required actions/models", async () => {
    expect(await probeHelperCapabilities({ callBroker: broker(capabilities()) })).toEqual({
      protocol: HELPER_PROTOCOL_VERSION,
      actions: ["reset", "resume", "model"],
      models: ["opus", "sonnet", "haiku", "inherit"]
    });
  });

  test("fails closed on protocol/action/model skew", async () => {
    await expect(probeHelperCapabilities({ callBroker: broker(capabilities({ protocol: 3 })) })).rejects.toThrow("protocol mismatch");
    await expect(probeHelperCapabilities({ callBroker: broker(capabilities({ actions: ["reset"] })) })).rejects.toThrow("actions");
    await expect(probeHelperCapabilities({ callBroker: broker(capabilities({ models: ["opus"] })) })).rejects.toThrow("models");
  });
});
