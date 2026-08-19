import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createResetScheduler,
  createSessionScheduler,
  HELPER_PROTOCOL_VERSION,
  isSecureRootOwnedFileMetadata,
  probeHelperCapabilities,
  sendTelegramMessage,
  type CommandRunner,
  type FetchLike
} from "../src/runtime.js";

describe("root-owned scheduler file metadata", () => {
  const info = (overrides: Record<string, unknown> = {}) => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100600,
    nlink: 1,
    ...overrides
  });

  test("accepts only the explicitly allowed private or public-read modes", () => {
    expect(isSecureRootOwnedFileMetadata(info(), [0o600, 0o644])).toBe(true);
    expect(isSecureRootOwnedFileMetadata(info({ mode: 0o100644 }), [0o600, 0o644])).toBe(true);
    for (const mode of [0o100640, 0o100666, 0o100755]) {
      expect(isSecureRootOwnedFileMetadata(info({ mode }), [0o600, 0o644])).toBe(false);
    }
  });

  test("rejects foreign ownership, links, symlinks, and non-files", () => {
    expect(isSecureRootOwnedFileMetadata(info({ uid: 1000 }), [0o600])).toBe(false);
    expect(isSecureRootOwnedFileMetadata(info({ nlink: 2 }), [0o600])).toBe(false);
    expect(isSecureRootOwnedFileMetadata(info({ isSymbolicLink: () => true }), [0o600])).toBe(false);
    expect(isSecureRootOwnedFileMetadata(info({ isFile: () => false }), [0o600])).toBe(false);
  });
});
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

    const id = await sendTelegramMessage(config, "123456789", "Reset accepted", fetchImpl, "51");

    expect(id).toBe(71);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendMessage")).toBe(true);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeDefined();
    expect(calls[0]!.body).toEqual({
      chat_id: "123456789",
      reply_parameters: { message_id: 51 },
      text: "Reset accepted"
    });
  });

  test("keeps injected fetch as the fourth argument", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 72 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const id = await sendTelegramMessage(config, "123456789", "Independent", fetchImpl);

    expect(id).toBe(72);
    expect(bodies).toEqual([{ chat_id: "123456789", text: "Independent" }]);
  });

  test("rejects an unauthorized chat before the Telegram request", async () => {
    let calls = 0;
    await expect(sendTelegramMessage(config, "999", "Reset accepted", async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), { status: 200 });
    }, undefined)).rejects.toThrow("chat is not authorized");
    expect(calls).toBe(0);
  });

  test("rejects a lossy reply message ID before the Telegram request", async () => {
    let calls = 0;
    await expect(sendTelegramMessage(config, "123456789", "Reset accepted", async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), { status: 200 });
    }, "9007199254740993")).rejects.toThrow("invalid reply message ID");
    expect(calls).toBe(0);
  });

  test("rejects an oversized ACK response", async () => {
    await expect(sendTelegramMessage(
      config,
      "123456789",
      "Reset accepted",
      async () => new Response("x".repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1), { status: 200 }),
      undefined
    )).rejects.toThrow("notification failed");
  });

  test("rejects invalid Telegram response message IDs", async () => {
    for (const messageId of [0, -1, 9_007_199_254_740_992]) {
      await expect(sendTelegramMessage(
        config,
        "123456789",
        "Reset accepted",
        async () => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )).rejects.toThrow("notification failed");
    }
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
      "--protocol",
      String(HELPER_PROTOCOL_VERSION),
      "--action",
      "reset",
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

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";

describe("session action scheduling", () => {
  function scheduler(run: CommandRunner) {
    return createSessionScheduler({ run, verifyHelper: () => undefined });
  }

  test("schedules a resume with a fixed argv carrying the exact session UUID", async () => {
    const argvSeen: string[][] = [];
    const schedule = scheduler(async argv => {
      argvSeen.push(argv);
      return { exitCode: 0, stderr: "" };
    });
    const requestId = createHash("sha256")
      .update(`resume:123456789:51:${SESSION}`)
      .digest("hex")
      .slice(0, 24);

    const unit = await schedule.scheduleResume("123456789", "51", SESSION, SESSION);

    expect(unit).toBe(`claude-session-reset-resume-${requestId}`);
    expect(argvSeen).toEqual([[
      "/usr/bin/sudo",
      "-n",
      "/usr/bin/systemd-run",
      `--unit=claude-session-reset-resume-${requestId}`,
      "--collect",
      "--no-block",
      "/usr/local/sbin/claude-code-session-reset",
      "--config",
      "/etc/claude-code-telegram-kit/reset.json",
      "--protocol",
      String(HELPER_PROTOCOL_VERSION),
      "--action",
      "resume",
      "--current-session-id",
      SESSION,
      "--session-id",
      SESSION,
      "--chat-id",
      "123456789",
      "--request-id",
      requestId
    ]]);
  });

  test("gives reset and resume distinct idempotency keys and units", async () => {
    const argvSeen: string[][] = [];
    const schedule = scheduler(async argv => {
      argvSeen.push(argv);
      return { exitCode: 0, stderr: "" };
    });

    const resetUnit = await schedule.scheduleReset("123456789", "51");
    const resumeUnit = await schedule.scheduleResume("123456789", "51", SESSION, SESSION);

    expect(resetUnit).not.toBe(resumeUnit);
    expect(argvSeen[0]!.at(-1)).not.toBe(argvSeen[1]!.at(-1));
  });

  test("never accepts a path, service, or command in place of a session UUID", async () => {
    let calls = 0;
    const schedule = scheduler(async () => {
      calls += 1;
      return { exitCode: 0, stderr: "" };
    });

    for (const bad of [
      "/etc/passwd",
      "../../etc/passwd",
      "claude-telegram.service",
      "3fcbaf06-4378-4339-b026-8c2e026a65e7 --continue",
      "3FCBAF06-4378-4339-B026-8C2E026A65E7",
      ""
    ]) {
      await expect(schedule.scheduleResume("123456789", "51", SESSION, bad)).rejects.toThrow("invalid session UUID");
    }
    expect(calls).toBe(0);
  });

  test("never accepts a non-UUID current session identity", async () => {
    let calls = 0;
    const schedule = scheduler(async () => {
      calls += 1;
      return { exitCode: 0, stderr: "" };
    });

    for (const bad of [
      "3fcbaf06-4378-4339-b026-8c2e026a65e7 --continue",
      "../../etc/passwd",
      "claude-telegram.service",
      "3FCBAF06-4378-4339-B026-8C2E026A65E7",
      ""
    ]) {
      await expect(schedule.scheduleResume("123456789", "51", bad, SESSION)).rejects.toThrow(
        "invalid current session UUID"
      );
    }
    expect(calls).toBe(0);
  });

  test("reports a systemd rejection instead of reporting success", async () => {
    const schedule = scheduler(async () => ({ exitCode: 1, stderr: "denied" }));
    await expect(schedule.scheduleResume("123456789", "51", SESSION, SESSION)).rejects.toThrow("systemd rejected");
  });
});

describe("root helper capability preflight", () => {
  test("requires Session Control Protocol v3", () => {
    expect(HELPER_PROTOCOL_VERSION).toBe(3);
  });

  test("accepts a matching protocol and action set", async () => {
    const argvSeen: string[][] = [];
    const capabilities = await probeHelperCapabilities({
      run: async argv => {
        argvSeen.push(argv);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ protocol: 3, actions: ["reset", "resume"] }),
          stderr: ""
        };
      },
      verifyHelper: () => undefined
    });

    expect(capabilities).toEqual({ protocol: 3, actions: ["reset", "resume"] });
    expect(argvSeen).toEqual([["/usr/local/sbin/claude-code-session-reset", "--capabilities"]]);
  });

  test("fails closed on a protocol mismatch, a missing action, or unusable output", async () => {
    for (const output of [
      JSON.stringify({ protocol: 2, actions: ["reset", "resume"] }),
      JSON.stringify({ protocol: 3, actions: ["reset"] }),
      JSON.stringify({ protocol: 1 }),
      JSON.stringify({ actions: ["reset", "resume"] }),
      "not json",
      "x".repeat(70_000)
    ]) {
      await expect(probeHelperCapabilities({
        run: async () => ({ exitCode: 0, stdout: output, stderr: "" }),
        verifyHelper: () => undefined
      })).rejects.toThrow();
    }
  });

  test("fails closed when the helper cannot run at all", async () => {
    await expect(probeHelperCapabilities({
      run: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
      verifyHelper: () => undefined
    })).rejects.toThrow();
    await expect(probeHelperCapabilities({
      run: async () => {
        throw new Error("ENOENT");
      },
      verifyHelper: () => undefined
    })).rejects.toThrow();
  });
});
