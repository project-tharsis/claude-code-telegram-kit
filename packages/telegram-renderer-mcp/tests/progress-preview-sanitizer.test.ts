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

  test("redacts credential-like assignments and bearer tokens", () => {
    expect(
      sanitizeProgressPreview("Using api_key=abc123 and Authorization: Bearer eyJsecret.payload.sig")
    ).toBe("Using api_key=[REDACTED] and [REDACTED]");
  });

  test("redacts prefixed env names, quoted flag values, and credential headers", () => {
    expect(sanitizeProgressPreview(
      'OPENAI_API_KEY="abc def" curl --auth-token "secret value" -H "Cookie: sid=abc"'
    )).toBe('OPENAI_API_KEY=[REDACTED] curl --auth-token=[REDACTED] -H "Cookie=[REDACTED]"');
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
