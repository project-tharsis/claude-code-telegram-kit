import { describe, expect, test } from "bun:test";
import { createClaudeAuthProbe, parseClaudeAuthStatus } from "../src/claude-auth-status.js";

describe("Claude auth status parser", () => {
  test("classifies only Claude's explicit expired-login marker as unavailable", () => {
    expect(parseClaudeAuthStatus("Login: Expired — log in again\nOrganization: example")).toBe("unavailable");
    expect(parseClaudeAuthStatus("Login: claude.ai\nOrganization: example")).toBe("unknown");
    expect(parseClaudeAuthStatus("Not logged in. Run claude auth login to authenticate.")).toBe("unknown");
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toBe("unknown");
  });

  test("fails open on malformed, oversized, or ambiguous output", () => {
    expect(parseClaudeAuthStatus("not-json")).toBe("unknown");
    expect(parseClaudeAuthStatus("x".repeat(16_385))).toBe("unknown");
    expect(parseClaudeAuthStatus('{"loggedIn":"false"}')).toBe("unknown");
    expect(parseClaudeAuthStatus("Login: claude.ai\nwarning: Login: Expired")).toBe("unknown");
  });
});

describe("Claude auth probe", () => {
  test("uses fixed no-shell text-status argv and accepts exit one with an expired marker", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const probe = createClaudeAuthProbe({
      command: "/usr/local/bin/claude",
      env: { CLAUDE_CODE_AUTH_PREFLIGHT: "interactive-login" },
      run: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 1, stdout: "Login: Expired — log in again", stderr: "" };
      }
    });
    await expect(probe()).resolves.toBe("unavailable");
    expect(calls).toEqual([{ command: "/usr/local/bin/claude", args: ["auth", "status", "--text"] }]);
  });

  test("fails open when the subprocess fails or an alternate credential source is configured", async () => {
    const failed = createClaudeAuthProbe({
      env: { CLAUDE_CODE_AUTH_PREFLIGHT: "interactive-login" },
      run: async () => { throw new Error("timeout"); }
    });
    await expect(failed()).resolves.toBe("unknown");

    let calls = 0;
    const alternate = createClaudeAuthProbe({
      env: {
        CLAUDE_CODE_AUTH_PREFLIGHT: "interactive-login",
        CLAUDE_CODE_OAUTH_TOKEN: "configured"
      },
      run: async () => {
        calls += 1;
        return { exitCode: 1, stdout: '{"loggedIn":false}', stderr: "" };
      }
    });
    await expect(alternate()).resolves.toBe("unknown");
    expect(calls).toBe(0);
  });

  test("is disabled unless the deployment explicitly selects interactive-login auth", async () => {
    let calls = 0;
    const probe = createClaudeAuthProbe({
      env: {},
      run: async () => {
        calls += 1;
        return { exitCode: 1, stdout: "Login: Expired — log in again", stderr: "" };
      }
    });
    await expect(probe()).resolves.toBe("unknown");
    expect(calls).toBe(0);
  });
});
