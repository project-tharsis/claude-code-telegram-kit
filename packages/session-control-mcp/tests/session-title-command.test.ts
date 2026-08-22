import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleSessionTitleCommand,
  shouldEnsureSessionTitle
} from "../src/session-title-command.js";
import type { SessionTitleState } from "../src/session-title-state.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "title-command-"));
  roots.push(root);
  const workspaceDir = join(root, "workspace");
  const projectSessionsDir = join(root, "sessions");
  mkdirSync(workspaceDir, { mode: 0o700 });
  mkdirSync(projectSessionsDir, { mode: 0o700 });
  return {
    workspaceDir,
    projectSessionsDir,
    payload: {
      session_id: SESSION,
      cwd: workspaceDir,
      transcript_path: join(projectSessionsDir, `${SESSION}.jsonl`),
      last_assistant_message: "Final answer"
    }
  };
}

const telegram = (body: string) =>
  `<channel source="plugin:telegram:telegram" chat_id="123" message_id="9">${body}</channel>`;

describe("session title command hook", () => {
  test("runs on Stop and only the title backstop controls", () => {
    const { payload } = fixture();
    expect(shouldEnsureSessionTitle({ ...payload, hook_event_name: "Stop" })).toBe(true);
    for (const body of ["/resume", "/sessions", "/reset", "/reset confirm ABC234"]) {
      expect(shouldEnsureSessionTitle({ ...payload, hook_event_name: "UserPromptSubmit", prompt: telegram(body) })).toBe(true);
    }
    for (const body of ["hello", "/usage", "/model", "/rename Manual title", "/resume 1"]) {
      expect(shouldEnsureSessionTitle({ ...payload, hook_event_name: "UserPromptSubmit", prompt: telegram(body) })).toBe(false);
    }
  });

  test("binds fixed roots while allowing Claude's mutable tool cwd", async () => {
    const { payload, workspaceDir, projectSessionsDir } = fixture();
    const seen: unknown[] = [];
    await handleSessionTitleCommand({ ...payload, cwd: projectSessionsDir, hook_event_name: "Stop" }, {
      workspaceDir,
      projectSessionsDir,
      ensure: async authority => { seen.push(authority); }
    });
    expect(seen).toEqual([{
      sessionId: SESSION,
      workspaceDir,
      projectSessionsDir,
      assistantText: "Final answer"
    }]);
  });

  test("delegates failed state but skips a claimed state", async () => {
    const { payload, workspaceDir, projectSessionsDir } = fixture();
    const seen: string[] = [];
    let state: SessionTitleState = {
      version: 1, sessionId: SESSION, status: "failed", attempts: 1, updatedAt: 1
    };
    const options = {
      workspaceDir, projectSessionsDir,
      readState: () => state,
      ensure: async () => { seen.push("called"); }
    };
    await handleSessionTitleCommand({ ...payload, hook_event_name: "Stop" }, options);
    state = { version: 1, sessionId: SESSION, status: "claimed", attempts: 1, updatedAt: 2 };
    await handleSessionTitleCommand({ ...payload, hook_event_name: "Stop" }, options);
    expect(seen).toEqual(["called"]);
  });

  test("rejects traversal and transcript identity mismatch", async () => {
    const { payload, workspaceDir, projectSessionsDir } = fixture();
    for (const candidate of [
      { ...payload, hook_event_name: "Stop", session_id: "../../etc/passwd" },
      { ...payload, hook_event_name: "Stop", transcript_path: join(projectSessionsDir, "other.jsonl") }
    ]) {
      await expect(handleSessionTitleCommand(candidate, {
        workspaceDir,
        projectSessionsDir,
        ensure: async () => undefined
      })).rejects.toThrow();
    }
  });
});
