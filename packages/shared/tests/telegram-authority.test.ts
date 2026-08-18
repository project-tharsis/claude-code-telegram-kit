import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAuthorizedChat, loadRuntimeConfig } from "../src/telegram-authority.js";

const TEST_CHAT_ID = "123456789";
const TEST_TOKEN = `123456789:${"A".repeat(32)}`;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function validState(): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-authority-"));
  dirs.push(dir);
  const env = join(dir, ".env");
  const access = join(dir, "access.json");
  writeFileSync(env, `TELEGRAM_BOT_TOKEN=${TEST_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(access, JSON.stringify({
    dmPolicy: "allowlist",
    allowFrom: [TEST_CHAT_ID],
    groups: {},
    pending: {}
  }), { mode: 0o600 });
  chmodSync(env, 0o600);
  chmodSync(access, 0o600);
  return dir;
}

describe("runtime authority", () => {
  test("loads the channel token and exact allowlist", () => {
    const config = loadRuntimeConfig(validState());
    expect(config.token).toBe(TEST_TOKEN);
    expect(config.allowedChatIds).toEqual(new Set([TEST_CHAT_ID]));
  });

  test("rejects channel state that is readable by group or world", () => {
    const dir = validState();
    chmodSync(join(dir, ".env"), 0o644);
    expect(() => loadRuntimeConfig(dir)).toThrow("must have mode 0600");
  });

  test("rejects a channel state directory that is not private", () => {
    const dir = validState();
    chmodSync(dir, 0o755);
    expect(() => loadRuntimeConfig(dir)).toThrow("directory must have mode 0700");
  });

  test("allows only chat IDs from the live allowlist", () => {
    const config = loadRuntimeConfig(validState());
    expect(() => assertAuthorizedChat(config, TEST_CHAT_ID)).not.toThrow();
    expect(() => assertAuthorizedChat(config, "999999999")).toThrow("chat is not authorized");
  });

  test("rejects non-allowlist channel policy", () => {
    const dir = validState();
    const access = join(dir, "access.json");
    writeFileSync(access, JSON.stringify({
      dmPolicy: "pairing",
      allowFrom: [TEST_CHAT_ID],
      groups: {},
      pending: {}
    }));
    chmodSync(access, 0o600);
    expect(() => loadRuntimeConfig(dir)).toThrow("dmPolicy must be allowlist");
  });

  test("requires exactly one allowlisted chat unless explicitly configured", () => {
    const dir = validState();
    const access = join(dir, "access.json");
    writeFileSync(access, JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: [TEST_CHAT_ID, "987654321"],
      groups: {},
      pending: {}
    }));
    chmodSync(access, 0o600);
    expect(() => loadRuntimeConfig(dir)).toThrow("exactly one allowlisted chat");
    expect(loadRuntimeConfig(dir, { allowMultipleChats: true }).allowedChatIds.size).toBe(2);
  });

  test("keeps reading the opened directory when its pathname is replaced", () => {
    const dir = validState();
    const held = `${dir}-held`;
    dirs.push(held);
    const replacementToken = `123456789:${"B".repeat(32)}`;

    const config = loadRuntimeConfig(dir, {
      onDirectoryOpened: () => {
        renameSync(dir, held);
        mkdirSync(dir, { mode: 0o700 });
        writeFileSync(join(dir, ".env"), `TELEGRAM_BOT_TOKEN=${replacementToken}\n`, { mode: 0o600 });
        writeFileSync(join(dir, "access.json"), JSON.stringify({
          dmPolicy: "allowlist",
          allowFrom: [TEST_CHAT_ID],
          groups: {},
          pending: {}
        }), { mode: 0o600 });
      }
    });

    expect(config.token).toBe(TEST_TOKEN);
  });
});
