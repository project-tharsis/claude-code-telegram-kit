import { describe, expect, test } from "bun:test";
import { containsCredentialShape, redactCredentials } from "../src/credential-patterns.js";

describe("shared credential pattern source", () => {
  test("redacts a quoted-JSON-style password key:value pair, not just bare prose", () => {
    const value = '{"password": "hunter2value"}';
    const redacted = redactCredentials(value);
    expect(redacted).not.toContain("hunter2value");
    expect(containsCredentialShape(value)).toBe(true);
  });

  test("redacts a quoted-JSON-style api_key key:value pair with no space after the colon", () => {
    const value = '{"api_key":"abcdefghij1234567890zzzz"}';
    const redacted = redactCredentials(value);
    expect(redacted).not.toContain("abcdefghij1234567890zzzz");
    expect(containsCredentialShape(value)).toBe(true);
  });

  test("still redacts ordinary bare key: value prose (no regression)", () => {
    const value = "password: hunter2value and token=abcdefghijklmnopqrstuvwx";
    expect(redactCredentials(value)).not.toContain("hunter2value");
    expect(containsCredentialShape(value)).toBe(true);
  });

  test("containsCredentialShape is stateless across repeated calls (no global-flag lastIndex bug)", () => {
    const value = "sk-live-abcdefghijklmnop";
    expect(containsCredentialShape(value)).toBe(true);
    expect(containsCredentialShape(value)).toBe(true);
    expect(containsCredentialShape(value)).toBe(true);
  });

  test("redacts the actual bearer token, not just the literal word Bearer, in an Authorization header", () => {
    const value = "Authorization: Bearer abcdef1234567890secret";
    const redacted = redactCredentials(value);
    expect(redacted).not.toContain("abcdef1234567890secret");
    expect(containsCredentialShape(value)).toBe(true);
  });

  test("leaves ordinary text untouched", () => {
    const value = "please remember I prefer concise answers";
    expect(redactCredentials(value)).toBe(value);
    expect(containsCredentialShape(value)).toBe(false);
  });
});
