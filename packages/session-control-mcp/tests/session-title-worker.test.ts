import { describe, expect, test } from "bun:test";
import { runSessionTitleWorker } from "../src/session-title-worker.js";

describe("dedicated session title worker boundary", () => {
  test("rejects a non-UUID before loading authenticated state", async () => {
    await expect(runSessionTitleWorker({
      sessionId: "../../etc/passwd",
      workspaceDir: "/srv/workspace",
      projectSessionsDir: "/srv/sessions",
      telegramStateDir: "/srv/telegram"
    })).rejects.toThrow("invalid session identity");
  });

  test("requires an explicit authenticated source before loading runtime state", async () => {
    const keys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      await expect(runSessionTitleWorker({
        sessionId: "11111111-1111-4111-8111-111111111111",
        workspaceDir: "/srv/workspace",
        projectSessionsDir: "/srv/sessions",
        telegramStateDir: "/srv/telegram"
      })).rejects.toThrow("authenticated title source is unavailable");
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("propagates a failed title state as a worker failure", async () => {
    await expect(runSessionTitleWorker({
      sessionId: "11111111-1111-4111-8111-111111111111",
      workspaceDir: "/srv/workspace",
      projectSessionsDir: "/srv/sessions",
      telegramStateDir: "/srv/telegram",
      ensure: async () => "failed"
    })).rejects.toThrow("automatic title failed");
  });

  test("accepts a proven applied title result", async () => {
    await expect(runSessionTitleWorker({
      sessionId: "11111111-1111-4111-8111-111111111111",
      workspaceDir: "/srv/workspace",
      projectSessionsDir: "/srv/sessions",
      telegramStateDir: "/srv/telegram",
      ensure: async () => "applied"
    })).resolves.toBe("applied");
  });
});