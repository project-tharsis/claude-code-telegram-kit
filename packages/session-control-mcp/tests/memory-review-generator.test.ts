import { describe, expect, test } from "bun:test";
import { generateMemoryReviewProposal, MemoryReviewGenerationError } from "../src/memory-review-generator.js";
import { buildMemoryReviewSnapshot } from "../src/memory-review-snapshot.js";

const snapshot = buildMemoryReviewSnapshot({
  sessionId: "22222222-2222-4222-8222-222222222222",
  promptId: "prompt-1",
  assistantMessageSha256: "a".repeat(64),
  userMessage: "please stop using em dashes",
  assistantFinal: "Understood, no more em dashes.",
  currentMemoryIndex: "- no-em-dash.md",
  nativeMemoryWatermark: "f".repeat(64),
  releaseSha: "d".repeat(40),
  packageVersion: "0.3.0"
});

function structuredOutput(proposal: Record<string, unknown>) {
  return JSON.stringify({ structured_output: proposal });
}

const VALID_PROPOSAL = {
  decision: "no_op",
  target: "managed_memory",
  topic: "no-op",
  evidence: [],
  content: "",
  reason: "already captured",
  freshness: "standing"
};

describe("isolated memory review generator argv contract", () => {
  test("never passes --resume, --channels, or a Bash/Read/Edit/Write tool allowance", async () => {
    let capturedArgv: string[] = [];
    await generateMemoryReviewProposal(snapshot, {
      run: async argv => {
        capturedArgv = argv;
        return { exitCode: 0, stdout: structuredOutput(VALID_PROPOSAL) };
      }
    });
    expect(capturedArgv).not.toContain("--resume");
    expect(capturedArgv).not.toContain("--channels");
    expect(capturedArgv).not.toContain("--fork-session");
    expect(capturedArgv).toContain("--no-session-persistence");
    const settingSourcesIndex = capturedArgv.indexOf("--setting-sources");
    expect(capturedArgv[settingSourcesIndex + 1]).toBe("");
    const mcpConfigIndex = capturedArgv.indexOf("--mcp-config");
    expect(capturedArgv[mcpConfigIndex + 1]).toBe('{"mcpServers":{}}');
    expect(capturedArgv).toContain("--strict-mcp-config");
    const toolsIndex = capturedArgv.indexOf("--tools");
    expect(capturedArgv[toolsIndex + 1]).toBe("");
    expect(capturedArgv).toContain("--max-turns");
    expect(capturedArgv[capturedArgv.indexOf("--max-turns") + 1]).toBe("1");
  });

  test("returns a validated proposal for well-formed model output", async () => {
    const proposal = await generateMemoryReviewProposal(snapshot, {
      run: async () => ({ exitCode: 0, stdout: structuredOutput(VALID_PROPOSAL) })
    });
    expect(proposal.decision).toBe("no_op");
  });

  test("classifies a non-zero exit as a retryable command failure", async () => {
    await expect(generateMemoryReviewProposal(snapshot, {
      run: async () => ({ exitCode: 1, stdout: "", stderr: "boom" })
    })).rejects.toMatchObject({ phase: "generate", reason: "command_failed", retryable: true });
  });

  test("classifies a 429-shaped stderr as rate_limited", async () => {
    await expect(generateMemoryReviewProposal(snapshot, {
      run: async () => ({ exitCode: 1, stdout: "", stderr: "upstream returned 429 Too Many Requests" })
    })).rejects.toMatchObject({ phase: "generate", reason: "rate_limited" });
  });

  test("classifies malformed JSON output as a non-retryable invalid_output failure", async () => {
    await expect(generateMemoryReviewProposal(snapshot, {
      run: async () => ({ exitCode: 0, stdout: "not json at all" })
    })).rejects.toMatchObject({ phase: "parse", reason: "invalid_output", retryable: false });
  });

  test("classifies a schema-violating structured_output as invalid_output, never a partial pass-through", async () => {
    await expect(generateMemoryReviewProposal(snapshot, {
      run: async () => ({ exitCode: 0, stdout: structuredOutput({ ...VALID_PROPOSAL, target: "claude_md" }) })
    })).rejects.toMatchObject({ phase: "parse", reason: "invalid_output" });
  });

  test("a hung run is aborted at the timeout boundary and reported as a timeout", async () => {
    await expect(generateMemoryReviewProposal(snapshot, {
      timeoutMs: 5,
      run: () => new Promise(() => {})
    })).rejects.toMatchObject({ phase: "generate", reason: "timeout", retryable: true });
  });

  test("MemoryReviewGenerationError instances are recognizable by type", async () => {
    try {
      await generateMemoryReviewProposal(snapshot, { run: async () => ({ exitCode: 0, stdout: "garbage" }) });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryReviewGenerationError);
    }
  });
});
