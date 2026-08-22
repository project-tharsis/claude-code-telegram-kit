import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionTitleService } from "../src/session-title-service.js";
import { readSessionTitleState } from "../src/session-title-state.js";
import { SessionTitleGenerationError } from "../src/session-title-generator.js";
import type { SessionTitleContext } from "../src/session-catalog.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "title-service-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
function context(overrides: Partial<SessionTitleContext> = {}): SessionTitleContext {
  return {
    customTitle: null,
    aiTitle: null,
    chatId: "123",
    userPrompt: "Build Telegram model controls",
    assistantText: "Implemented deterministic model controls.",
    toolNames: ["Read"],
    ...overrides
  };
}

describe("session title service", () => {
  test("generates and applies at most once with exact readback", async () => {
    const directory = stateDir();
    let current = context();
    let generated = 0;
    let renamed = 0;
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions",
      workspaceDir: "/workspace",
      stateDirectory: directory, isAuthorizedChat: () => true,
      readContext: () => current,
      generate: async () => { generated += 1; return "Telegram Model Controls"; },
      rename: async (sessionId, title, workspace) => {
        expect([sessionId, workspace]).toEqual([SESSION, "/workspace"]);
        renamed += 1;
        current = { ...current, customTitle: title };
      }
    });

    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("applied");
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("already_attempted");
    expect({ generated, renamed }).toEqual({ generated: 1, renamed: 1 });
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toMatchObject({
      status: "auto_applied", title: "Telegram Model Controls", attempts: 1
    });
  });

  test("manual rename overrides and permanently locks an auto title", async () => {
    const directory = stateDir();
    let current = context();
    let generated = 0;
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory, isAuthorizedChat: () => true,
      readContext: () => current,
      generate: async () => { generated += 1; return "Automatic Title"; },
      rename: async (_id, title) => { current = { ...current, customTitle: title }; }
    });
    await service.ensureAutoTitle(SESSION);
    await expect(service.renameUserSession(SESSION, "  User   Chosen Title  ")).resolves.toBe("User Chosen Title");
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toMatchObject({
      status: "user_locked", title: "User Chosen Title"
    });
    await service.ensureAutoTitle(SESSION);
    expect(generated).toBe(1);
  });

  test("never generates when a native or external title already exists", async () => {
    for (const existing of [context({ aiTitle: "Native title" }), context({ customTitle: "Manual title" })]) {
      const directory = stateDir();
      let generated = 0;
      const service = createSessionTitleService({
        projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory, isAuthorizedChat: () => true,
        readContext: () => existing,
        generate: async () => { generated += 1; return "Unexpected Title"; },
        rename: async () => { throw new Error("must not rename"); }
      });
      await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("existing");
      expect(generated).toBe(0);
    }
  });

  test("a generation failure is persisted and never retried", async () => {
    const directory = stateDir();
    let generated = 0;
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory, isAuthorizedChat: () => true,
      readContext: () => context(),
      generate: async () => { generated += 1; throw new Error("provider detail"); },
      rename: async () => undefined
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("failed");
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("already_attempted");
    expect(generated).toBe(1);
    expect(readSessionTitleState({ directory, sessionId: SESSION })?.status).toBe("failed");
  });

  test("retries one proven pre-mutation failure after persisted backoff", async () => {
    const directory = stateDir();
    let generated = 0;
    let clock = 1_000;
    let current = context();
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory, isAuthorizedChat: () => true, retryDelayMs: 10, now: () => clock,
      readContext: () => current,
      generate: async () => {
        generated += 1;
        if (generated === 1) throw new SessionTitleGenerationError("parse", "invalid_output", true);
        return "Recovered Title";
      },
      rename: async (_id, title) => { current = { ...current, customTitle: title }; }
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("failed");
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("retry_scheduled");
    clock = 1_010;
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("applied");
    expect(generated).toBe(2);
  });

  test("does not consume the safe retry while context is unauthorized", async () => {
    const directory = stateDir();
    let generated = 0;
    let clock = 1_000;
    let authorized = true;
    let current = context();
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory,
      isAuthorizedChat: () => authorized, retryDelayMs: 10, now: () => clock,
      readContext: () => current,
      generate: async () => {
        generated += 1;
        if (generated === 1) throw new SessionTitleGenerationError("generate", "command_failed", true);
        return "Recovered Later";
      },
      rename: async (_id, title) => { current = { ...current, customTitle: title }; }
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("failed");
    clock = 1_010;
    authorized = false;
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("no_context");
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toMatchObject({ status: "failed", attempts: 1 });
    authorized = true;
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("applied");
    expect(generated).toBe(2);
  });

  test("stops permanently after the one safe retry also fails", async () => {
    const directory = stateDir();
    let generated = 0;
    let clock = 2_000;
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory,
      isAuthorizedChat: () => true, retryDelayMs: 1, now: () => clock,
      readContext: () => context(),
      generate: async () => {
        generated += 1;
        throw new SessionTitleGenerationError("generate", "command_failed", true);
      },
      rename: async () => undefined
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("failed");
    clock = 2_001;
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("failed");
    clock = 3_000;
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("already_attempted");
    expect(generated).toBe(2);
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toMatchObject({ status: "failed", attempts: 2 });
  });

  test("never retries after rename ambiguity", async () => {
    const directory = stateDir();
    let generated = 0;
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory, isAuthorizedChat: () => true, retryDelayMs: 1,
      readContext: () => context(),
      generate: async () => { generated += 1; return "Mutation Ambiguous"; },
      rename: async () => { throw new Error("rename outcome unknown"); }
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("failed");
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("already_attempted");
    expect(generated).toBe(1);
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toMatchObject({ phase: "rename", reason: "rename_failed" });
  });

  test("a title appearing during generation wins before title mutation", async () => {
    const directory = stateDir();
    let current = context();
    let renamed = 0;
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory, isAuthorizedChat: () => true,
      readContext: () => current,
      generate: async () => {
        current = { ...current, customTitle: "External Rename" };
        return "Generated Title";
      },
      rename: async () => { renamed += 1; }
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("existing");
    expect(renamed).toBe(0);
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toMatchObject({
      status: "user_locked", title: "External Rename"
    });
  });

  test("serializes automatic and manual title mutations so the user title wins", async () => {
    const directory = stateDir();
    let current = context();
    let releaseGenerate!: (title: string) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const generated = new Promise<string>(resolve => { releaseGenerate = resolve; });
    const renamed: string[] = [];
    const options = {
      projectSessionsDir: "/sessions",
      workspaceDir: "/workspace",
      stateDirectory: directory, isAuthorizedChat: () => true,
      readContext: () => ({ ...current, toolNames: [...current.toolNames] }),
      rename: async (_sessionId: string, title: string) => {
        renamed.push(title);
        current = { ...current, customTitle: title };
      }
    };
    const automatic = createSessionTitleService({
      ...options,
      generate: async () => { markStarted(); return generated; }
    });
    const manual = createSessionTitleService({
      ...options,
      generate: async () => "unused"
    });

    const automaticRun = automatic.ensureAutoTitle(SESSION);
    await started;
    const manualRun = manual.renameUserSession(SESSION, "User chosen title");
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(renamed).toEqual([]);
    releaseGenerate("Automatic title");
    await expect(automaticRun).resolves.toBe("applied");
    await expect(manualRun).resolves.toBe("User chosen title");
    expect(renamed).toEqual(["Automatic title", "User chosen title"]);
    expect(current.customTitle).toBe("User chosen title");
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toMatchObject({
      status: "user_locked", title: "User chosen title"
    });
  });

  test("never spends title quota for an unauthorized Telegram chat", async () => {
    const directory = stateDir();
    let generated = 0;
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory,
      isAuthorizedChat: () => false,
      readContext: () => context({ chatId: "999" }),
      generate: async () => { generated += 1; return "Unexpected Title"; },
      rename: async () => undefined
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("no_context");
    expect(generated).toBe(0);
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toBeNull();
  });

  test("control-only sessions remain unclaimed for a future meaningful turn", async () => {
    const directory = stateDir();
    const service = createSessionTitleService({
      projectSessionsDir: "/sessions", workspaceDir: "/workspace", stateDirectory: directory, isAuthorizedChat: () => true,
      readContext: () => context({ userPrompt: null, assistantText: "", toolNames: [] }),
      generate: async () => "Unexpected Title",
      rename: async () => undefined
    });
    await expect(service.ensureAutoTitle(SESSION)).resolves.toBe("no_context");
    expect(readSessionTitleState({ directory, sessionId: SESSION })).toBeNull();
  });
});
