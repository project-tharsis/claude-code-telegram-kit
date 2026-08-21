import { describe, expect, test } from "bun:test";
import { sanitizeProgressPreview } from "../src/progress-preview-sanitizer.js";

describe("sanitizeProgressPreview", () => {
  test("returns a compact single-line preview for ordinary text", () => {
    expect(sanitizeProgressPreview("Reading the project files")).toBe("Reading the project files");
  });

  test("removes control characters and collapses whitespace", () => {
    expect(sanitizeProgressPreview("  Reading\n\tproject\r\nfiles  ")).toBe("Reading project files");
  });

  test("preserves ordinary URLs and VM paths while redacting sensitive query values", () => {
    expect(
      sanitizeProgressPreview(
        "Fetched https://example.test/a?token=secret&view=full and read /home/USER/project/file.ts plus ~/notes.txt"
      )
    ).toBe("Fetched https://example.test/a?token=REDACTED&view=full and read /home/USER/project/file.ts plus ~/notes.txt");
  });

  test("truncates after the first named secret prefix", () => {
    expect(
      sanitizeProgressPreview("Using api_key=abc123 and Authorization: Bearer eyJsecret.payload.sig")
    ).toBe("Using api_key=[REDACTED]");
  });

  test("fails closed after a prefixed secret assignment", () => {
    expect(sanitizeProgressPreview(
      'OPENAI_API_KEY="abc def" curl --auth-token "secret value" -H "Cookie: sid=abc"'
    )).toBe("OPENAI_API_KEY=[REDACTED]");
  });

  test("redacts escaped quoted secrets and zero-width-obfuscated names", () => {
    expect(sanitizeProgressPreview(String.raw`API_KEY=\"very secret\"`))
      .toBe("API_KEY=[REDACTED]");
    expect(sanitizeProgressPreview("TO\u034fKEN=hidden"))
      .toBe("TOKEN=[REDACTED]");
  });

  test("removes ANSI and bidi controls and redacts common standalone key shapes", () => {
    const jwt = "eyJabcdefgh.ijklmnop.qrstuvwx";
    expect(sanitizeProgressPreview(`\u001b[31mrun\u001b[0m \u202eAKIAABCDEFGHIJKLMNOP ${jwt}`))
      .toBe("run [REDACTED] [REDACTED]");
  });

  test("truncates by Unicode code points and appends an ellipsis", () => {
    const preview = "x".repeat(200);
    expect(sanitizeProgressPreview(preview, { maxLength: 32 })).toBe(`${"x".repeat(31)}…`);
  });

  test("middle truncation preserves a command head and target tail", () => {
    const preview = "sed -n 1,60p packages/telegram-renderer-mcp/src/progress-labels.ts";
    expect(sanitizeProgressPreview(preview, { maxLength: 40, truncation: "middle" }))
      .toBe("sed -n 1,60p package…/progress-labels.ts");
    expect(Array.from(sanitizeProgressPreview(preview, { maxLength: 40, truncation: "middle" })))
      .toHaveLength(40);
    expect(sanitizeProgressPreview("abcdef", { maxLength: 1, truncation: "middle" })).toBe("…");
    expect(sanitizeProgressPreview("abcdef", { maxLength: 2, truncation: "middle" })).toBe("a…");
    expect(sanitizeProgressPreview("abcdef", { maxLength: 3, truncation: "middle" })).toBe("a…f");
  });

  test("removes a simple cd wrapper before fail-closed redaction", () => {
    const preview = 'cd "/tmp/token=secret repo" && curl --auth-token "secret value" /target/file.txt';
    const output = sanitizeProgressPreview(preview, {
      maxLength: 80,
      truncation: "middle",
      stripLeadingCdWrapper: true
    });
    expect(output).toBe("curl --auth-token=[REDACTED]");
    expect(output).not.toContain("secret");
  });

  test("redacts complete shell substitutions in sensitive values", () => {
    expect(sanitizeProgressPreview("--token=$(cat /tmp/secret)"))
      .toBe("--token=[REDACTED]");
    expect(sanitizeProgressPreview("API_KEY=$(printf supersecret)"))
      .toBe("API_KEY=[REDACTED]");
    expect(sanitizeProgressPreview("--token=`cat /tmp/secret`"))
      .toBe("--token=[REDACTED]");
    expect(sanitizeProgressPreview(String.raw`API_KEY=\"$(cat /tmp/secret) supersecret\"`))
      .toBe("API_KEY=[REDACTED]");
    expect(sanitizeProgressPreview(String.raw`--token=\"a\\\"b supersecret\"`))
      .toBe("--token=[REDACTED]");
    expect(sanitizeProgressPreview(String.raw`API_KEY=\'a\\\'b supersecret\'`))
      .toBe("API_KEY=[REDACTED]");
    expect(sanitizeProgressPreview("--token=$(printf $(cat /tmp/secret))"))
      .toBe("--token=[REDACTED]");
    expect(sanitizeProgressPreview("--token=$(cat /tmp/secret"))
      .toBe("--token=[REDACTED]");
    expect(sanitizeProgressPreview("Authorization: Bearer $(cat /tmp/secret)"))
      .toBe("[REDACTED]");
    expect(sanitizeProgressPreview("--token=$((1 + 2))"))
      .toBe("--token=[REDACTED]");
    expect(sanitizeProgressPreview("--token=$(echo (secret) /tmp/path)"))
      .toBe("--token=[REDACTED]");
  });

  test("returns an empty string for nullish or non-string input", () => {
    expect(sanitizeProgressPreview(null)).toBe("");
    expect(sanitizeProgressPreview(undefined)).toBe("");
    expect(sanitizeProgressPreview({ text: "leak" })).toBe("");
    expect(sanitizeProgressPreview(42)).toBe("");
  });

  test("rejects invalid bounds instead of silently changing the contract", () => {
    expect(() => sanitizeProgressPreview("preview", { maxLength: 0 })).toThrow();
    expect(() => sanitizeProgressPreview("preview", { maxLength: 1.5 })).toThrow();
  });
});
