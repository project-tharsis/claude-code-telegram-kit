import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSelectionSnapshot,
  SELECTION_TTL_MS,
  writeSelectionSnapshot
} from "../src/session-selection.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-selection-"));
  roots.push(root);
  return join(root, "selections");
}

function uuid(n: number): string {
  const hex = n.toString(16).padStart(2, "0");
  return `${hex.repeat(4)}-${hex.repeat(2)}-4${hex.repeat(2).slice(1)}-8${hex.repeat(2).slice(1)}-${hex.repeat(6)}`;
}

function entries(count: number) {
  return Array.from({ length: count }, (_value, offset) => ({
    index: offset + 1,
    sessionId: uuid(offset + 1)
  }));
}

describe("session selection snapshots", () => {
  test("creates a private directory and a private single-link file", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(3), now: () => 1_000 });

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    const names = readdirSync(directory);
    expect(names.length).toBe(1);
    const file = lstatSync(join(directory, names[0]!));
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.nlink).toBe(1);
    expect(file.isSymbolicLink()).toBe(false);
  });

  test("round-trips a ten-item snapshot with stable one-based indices", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(10), now: () => 1_000 });

    const snapshot = readSelectionSnapshot({ directory, chatId: "123", now: () => 1_000 });

    expect(snapshot!.entries.length).toBe(10);
    for (let index = 1; index <= 10; index += 1) {
      expect(snapshot!.entries[index - 1]).toEqual({ index, sessionId: uuid(index) });
    }
  });

  test("keeps only the latest snapshot per chat", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(3), now: () => 1_000 });
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(98), entries: entries(1), now: () => 2_000 });

    expect(readdirSync(directory).length).toBe(1);
    const snapshot = readSelectionSnapshot({ directory, chatId: "123", now: () => 2_000 });
    expect(snapshot!.entries.length).toBe(1);
    expect(snapshot!.sessionId).toBe(uuid(98));
  });

  test("separates chats and never returns another chat's snapshot", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(2), now: () => 0 });
    writeSelectionSnapshot({ directory, chatId: "456", sessionId: uuid(98), entries: entries(3), now: () => 0 });

    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => 0 })!.entries.length).toBe(2);
    expect(readSelectionSnapshot({ directory, chatId: "456", now: () => 0 })!.entries.length).toBe(3);
    expect(readSelectionSnapshot({ directory, chatId: "789", now: () => 0 })).toBeNull();
  });

  test("expires exactly at the ten-minute TTL", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(2), now: () => 0 });

    expect(SELECTION_TTL_MS).toBe(10 * 60_000);
    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => SELECTION_TTL_MS - 1 })).not.toBeNull();
    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => SELECTION_TTL_MS })).toBeNull();
  });

  test("rejects a snapshot stamped beyond the clock-skew bound", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(2), now: () => 1_000 });

    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => 500 })).not.toBeNull();
    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => 1_000 - 6 * 60_000 })).toBeNull();
  });

  test("rejects a corrupt, foreign, or tampered snapshot", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(2), now: () => 0 });
    const path = join(directory, readdirSync(directory)[0]!);
    const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

    for (const mutate of [
      (data: Record<string, unknown>) => ({ ...data, version: 2 }),
      (data: Record<string, unknown>) => ({ ...data, chat_id: "999" }),
      (data: Record<string, unknown>) => ({ ...data, entries: [{ index: 1, session_id: "../../etc/passwd" }] }),
      (data: Record<string, unknown>) => ({ ...data, entries: [{ index: 0, session_id: uuid(1) }] }),
      (data: Record<string, unknown>) => ({ ...data, entries: [{ index: 2, session_id: uuid(1) }] }),
      (data: Record<string, unknown>) => ({ ...data, entries: entries(11).map(e => ({ index: e.index, session_id: e.sessionId })) }),
      (data: Record<string, unknown>) => ({ ...data, created_at: "soon" })
    ]) {
      writeFileSync(path, JSON.stringify(mutate(original)));
      chmodSync(path, 0o600);
      expect(readSelectionSnapshot({ directory, chatId: "123", now: () => 0 })).toBeNull();
    }

    writeFileSync(path, "{not json");
    chmodSync(path, 0o600);
    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => 0 })).toBeNull();
  });

  test("rejects a snapshot file with loosened permissions", () => {
    const directory = makeRoot();
    writeSelectionSnapshot({ directory, chatId: "123", sessionId: uuid(99), entries: entries(2), now: () => 0 });
    const path = join(directory, readdirSync(directory)[0]!);
    chmodSync(path, 0o644);

    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => 0 })).toBeNull();
  });

  test("refuses a world-readable or symlinked selection directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "session-selection-"));
    roots.push(parent);
    const loose = join(parent, "loose");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    expect(() => writeSelectionSnapshot({
      directory: loose,
      chatId: "123",
      sessionId: uuid(99),
      entries: entries(1),
      now: () => 0
    })).toThrow();

    const real = join(parent, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(parent, "link");
    symlinkSync(real, link);
    expect(() => writeSelectionSnapshot({
      directory: link,
      chatId: "123",
      sessionId: uuid(99),
      entries: entries(1),
      now: () => 0
    })).toThrow();
  });

  test("refuses to write an out-of-range or non-sequential selection", () => {
    const directory = makeRoot();
    for (const bad of [
      [],
      entries(11),
      [{ index: 2, sessionId: uuid(1) }],
      [{ index: 1, sessionId: "not-a-uuid" }]
    ]) {
      expect(() => writeSelectionSnapshot({
        directory,
        chatId: "123",
        sessionId: uuid(99),
        entries: bad,
        now: () => 0
      })).toThrow();
    }
  });

  test("returns null instead of throwing when no snapshot exists", () => {
    const directory = makeRoot();
    mkdirSync(directory, { mode: 0o700, recursive: true });
    expect(readSelectionSnapshot({ directory, chatId: "123", now: () => 0 })).toBeNull();
    expect(readSelectionSnapshot({ directory: join(directory, "missing"), chatId: "1", now: () => 0 })).toBeNull();
  });
});
