import { describe, expect, test } from "bun:test";
import { renameSessionWithClaude } from "../src/session-title-rename.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

function ok(title: string) {
  return JSON.stringify({
    is_error: false,
    num_turns: 0,
    duration_api_ms: 0,
    result: `Session renamed to: ${title}`
  });
}

describe("official CLI session rename", () => {
  test("uses fixed no-shell local-command argv and a minimal fake-auth environment", async () => {
    const seen: Array<{ argv: string[]; options: { timeoutMs: number; cwd: string; env: Record<string, string> } }> = [];
    process.env.SHOULD_NOT_REACH_RENAME = "private";
    try {
      await renameSessionWithClaude(SESSION, "User chosen title", {
        workspaceDir: "/workspace",
        claudePath: "/opt/claude/bin/claude",
        run: async (argv, options) => {
          seen.push({ argv, options });
          return { exitCode: 0, stdout: ok("User chosen title"), stderr: "" };
        }
      });
    } finally {
      delete process.env.SHOULD_NOT_REACH_RENAME;
    }
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.argv).toContain("/rename User chosen title");
    expect(call.argv).toContain("--resume");
    expect(call.argv).toContain(SESSION);
    expect(call.argv).not.toContain("--no-session-persistence");
    expect(call.options.cwd).toBe("/workspace");
    expect(call.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("local-rename-command-only");
    expect(call.options.env).not.toHaveProperty("SHOULD_NOT_REACH_RENAME");
  });

  test("requires zero-turn zero-api exact readback", async () => {
    for (const stdout of [
      ok("Different title"),
      JSON.stringify({ is_error: false, num_turns: 1, duration_api_ms: 0, result: "Session renamed to: Safe title" }),
      JSON.stringify({ is_error: false, num_turns: 0, duration_api_ms: 1, result: "Session renamed to: Safe title" }),
      "not-json"
    ]) {
      await expect(renameSessionWithClaude(SESSION, "Safe title", {
        workspaceDir: "/workspace",
        run: async () => ({ exitCode: 0, stdout, stderr: "private" })
      })).rejects.toThrow("Session rename failed");
    }
  });

  test("rejects malformed identity and title before invoking the runner", async () => {
    let calls = 0;
    const run = async () => { calls += 1; return { exitCode: 0, stdout: ok("Safe title") }; };
    await expect(renameSessionWithClaude("../../etc/passwd", "Safe title", { workspaceDir: "/workspace", run })).rejects.toThrow();
    await expect(renameSessionWithClaude(SESSION, "bad\ntitle", { workspaceDir: "/workspace", run })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
