import { describe, expect, test } from "bun:test";
import { sanitizeCommentary } from "../src/commentary-sanitizer.js";

describe("commentary sanitizer", () => {
  test("redacts credentials and sensitive URL data while preserving Markdown", () => {
    const value = sanitizeCommentary("**Keep**\nBearer super-secret-value\nhttps://example.test/?token=abc&ok=1\n`code`");
    expect(value).toContain("**Keep**");
    expect(value).toContain("[REDACTED]");
    expect(value).not.toContain("abc");
    expect(value).toContain("\n");
  });
  test("redacts provider keys, JWTs, Telegram tokens and private keys", () => {
    const github = ["ghp", "_", "a".repeat(24)].join("");
    const jwt = ["eyJ", "a".repeat(12), ".", "b".repeat(12), ".", "c".repeat(12)].join("");
    const telegram = ["123456", ":", "d".repeat(24)].join("");
    const privateKey = ["-----BEGIN ", "PRIVATE KEY-----\n", "e".repeat(32), "\n-----END ", "PRIVATE KEY-----"].join("");
    const value = sanitizeCommentary([github, jwt, telegram, privateKey].join("\n"));
    expect(value).not.toContain("ghp_");
    expect(value).not.toContain("eyJ");
    expect(value).not.toContain("123456:");
    expect(value).not.toContain("PRIVATE KEY");
    expect(value.match(/\[REDACTED\]/g)?.length).toBe(4);
  });
  test("bounds code points and rendered MarkdownV2", () => {
    const value = sanitizeCommentary("😀".repeat(10_000));
    expect(Array.from(value).length).toBeLessThanOrEqual(2_000);
  });
});
