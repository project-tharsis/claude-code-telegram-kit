import { describe, expect, test } from "bun:test";
import { generateSessionTitle, isValidSessionTitle } from "../src/session-title-generator.js";

const context = {
  userPrompt: "Help me compare the deployment options",
  assistantText: "I will inspect the service configuration and outline the tradeoffs.",
  toolNames: ["read_file", "terminal"]
};

function successful(title: string, seen: string[][] = []) {
  return generateSessionTitle(context, {
    run: async (argv) => {
      seen.push(argv);
      return { exitCode: 0, stdout: JSON.stringify({ structured_output: { title } }), stderr: "" };
    }
  });
}

describe("isValidSessionTitle", () => {
  test("accepts concise English and CJK titles", () => {
    expect(isValidSessionTitle("Deployment Options")).toBe(true);
    expect(isValidSessionTitle("部署方案对比")).toBe(true);
  });

  test("rejects malformed, oversized, secret-like, and generic titles", () => {
    const githubToken = `ghp_${"A".repeat(24)}`;
    const slackToken = `xoxb-${"B".repeat(20)}`;
    const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    for (const title of [
      "",
      "a",
      "a\nb",
      "<script>alert(1)</script>",
      "x".repeat(61),
      "550e8400-e29b-41d4-a716-446655440000",
      "Fix 550e8400-e29b-41d4-a716-446655440000",
      "/home/USER/project",
      "Fix /home/USER/project",
      "password=supersecret",
      "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      `Fix ${githubToken}`,
      `Fix ${slackToken}`,
      `Fix ${jwt}`,
      "!!! Deployment Plan !!!",
      "Session",
      "Untitled Conversation"
    ]) expect(isValidSessionTitle(title)).toBe(false);
  });
});

describe("generateSessionTitle", () => {
  test("uses a fixed isolated Haiku argv and bounds/redacts context", async () => {
    const seen: string[][] = [];
    const githubToken = `ghp_${"A".repeat(24)}`;
    const slackToken = `xoxb-${"B".repeat(20)}`;
    const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    const result = await generateSessionTitle({
      userPrompt: `please deploy ${"x".repeat(2000)} token=topsecret ${githubToken} ${slackToken} ${jwt} Bearer abcdefghijklmnopqrstuvwxyz`,
      assistantText: `result password: hunter2 ${"y".repeat(2000)}`,
      toolNames: ["read_file", "terminal", "a".repeat(100), "third", "fourth", "fifth", "sixth"]
    }, {
      run: async (argv) => {
        seen.push(argv);
        return { exitCode: 0, stdout: JSON.stringify({ structured_output: { title: "Deployment Plan" } }), stderr: "" };
      }
    });
    expect(result).toBe("Deployment Plan");
    expect(seen).toHaveLength(1);
    const capturedArgv = seen[0] ?? [];
    const joined = capturedArgv.join(" ");
    expect(capturedArgv[0]).toBe("claude");
    expect(joined).toContain("--model haiku");
    expect(joined).toContain("--output-format json");
    expect(joined).toContain("--max-turns 1");
    expect(joined).toContain("--no-session-persistence");
    expect(joined).toContain("--strict-mcp-config");
    expect(joined).toContain("--permission-mode dontAsk");
    expect(joined).not.toContain("topsecret");
    expect(joined).not.toContain("hunter2");
    expect(joined).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz");
    expect(joined).not.toContain(githubToken);
    expect(joined).not.toContain(slackToken);
    expect(joined).not.toContain(jwt);
    const prompt = seen[0]?.[2] ?? "";
    expect(prompt).toContain("User request:");
    const userPart = prompt.match(/User request: ([\s\S]*?)\nAssistant summary:/)?.[1] ?? "";
    const assistantPart = prompt.match(/Assistant summary: ([\s\S]*?)\nTools used:/)?.[1] ?? "";
    expect(userPart.length).toBeLessThanOrEqual(1200);
    expect(assistantPart.length).toBeLessThanOrEqual(1200);
  });

  test("accepts the CLI's structured output and a JSON-string result", async () => {
    expect(await successful("Release Checklist")).toBe("Release Checklist");
    expect(await generateSessionTitle(context, {
      run: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ result: JSON.stringify({ structured_output: { title: "发布清单" } }) }) })
    })).toBe("发布清单");
  });

  test("returns a generic error for malformed output, nonzero exit, and timeout", async () => {
    const generic = "Session title generation failed";
    await expect(generateSessionTitle(context, { run: async () => ({ exitCode: 0, stdout: "{}", stderr: "secret" }) })).rejects.toThrow(generic);
    await expect(generateSessionTitle(context, { run: async () => ({ exitCode: 2, stdout: "", stderr: "private details" }) })).rejects.toThrow(generic);
    await expect(generateSessionTitle(context, { timeoutMs: 5, run: () => new Promise(() => {}) })).rejects.toThrow(generic);
  });
});
