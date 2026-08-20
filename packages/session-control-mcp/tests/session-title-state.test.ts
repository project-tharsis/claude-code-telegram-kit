import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimAutoTitle,
  completeAutoTitle,
  defaultSessionTitleStateDirectory,
  failAutoTitle,
  lockUserTitle,
  readSessionTitleState,
  withSessionTitleLock
} from "../src/session-title-state.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "session-title-state-"));
  chmodSync(value, 0o700);
  roots.push(value);
  return value;
}
function id(n = 1): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
function options(directory: string, sessionId = id()): { directory: string; sessionId: string } {
  return { directory, sessionId };
}

 describe("persistent session title state", () => {
  test("uses the documented default directory", () => {
    expect(defaultSessionTitleStateDirectory()).toMatch(/\.local\/state\/claude-code-telegram-kit\/session-titles$/);
  });

  test("claims exactly once under duplicate concurrent claims", async () => {
    const directory = root();
    const results = await Promise.all(Array.from({ length: 16 }, () => Promise.resolve().then(() => claimAutoTitle(options(directory)))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(readSessionTitleState(options(directory))).toMatchObject({ version: 1, sessionId: id(), status: "claimed", attempts: 1 });
  });

  test("allows only claimed -> applied or failed", () => {
    const directory = root();
    const state = options(directory);
    expect(completeAutoTitle({ ...state, title: "Build a secure store" })).toBe(false);
    expect(claimAutoTitle(state)).toBe(true);
    expect(completeAutoTitle({ ...state, title: "Build a secure store" })).toBe(true);
    expect(failAutoTitle(state)).toBe(false);
    expect(readSessionTitleState(state)).toMatchObject({ status: "auto_applied", title: "Build a secure store" });
  });

  test("persists failure without a title", () => {
    const directory = root();
    const state = options(directory);
    claimAutoTitle(state);
    expect(failAutoTitle(state)).toBe(true);
    const saved = readSessionTitleState(state)!;
    expect(saved).toMatchObject({ status: "failed", attempts: 1 });
    expect("title" in saved).toBe(false);
  });

  test("user lock atomically overwrites any valid prior state", () => {
    const directory = root();
    const state = options(directory);
    claimAutoTitle(state);
    expect(lockUserTitle({ ...state, title: "User chosen title" })).toBe(true);
    expect(lockUserTitle({ ...state, title: "Renamed again" })).toBe(true);
    expect(readSessionTitleState(state)).toMatchObject({ status: "user_locked", title: "Renamed again", attempts: 1 });
  });

  test("rejects invalid titles and never persists prompt/body fields", () => {
    const directory = root();
    const state = options(directory);
    expect(() => completeAutoTitle({ ...state, title: "line\nbody" })).toThrow();
    expect(() => completeAutoTitle({ ...state, title: "x".repeat(61) })).toThrow();
    claimAutoTitle(state);
    completeAutoTitle({ ...state, title: "Safe title" });
    const raw = readFileSync(join(directory, `${id()}.json`), "utf8");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["attempts", "sessionId", "status", "title", "updatedAt", "version"]);
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("body");
  });

  test("rejects unsafe directory and leaf forms", () => {
    const directory = root();
    const state = options(directory);
    claimAutoTitle(state);
    const path = join(directory, `${id()}.json`);
    chmodSync(directory, 0o755);
    expect(() => readSessionTitleState(state)).toThrow();
    chmodSync(directory, 0o700);

    const symlinked = root();
    symlinkSync(path, join(symlinked, `${id()}.json`));
    expect(() => readSessionTitleState(options(symlinked))).toThrow();

    const linked = root();
    linkSync(path, join(linked, `${id()}.json`));
    expect(() => readSessionTitleState(options(linked))).toThrow();
  });

  test("rejects wrong owner and malformed schema", () => {
    const directory = root();
    const state = options(directory);
    claimAutoTitle(state);
    expect(() => readSessionTitleState({ ...state, expectedUid: 999999 })).toThrow();
    writeFileSync(join(directory, `${id()}.json`), JSON.stringify({ version: 1, sessionId: id(), status: "claimed", attempts: 2, updatedAt: 1 }));
    expect(() => readSessionTitleState(state)).toThrow();
  });

  test("rejects non-v4 and traversal session identifiers before touching the directory", () => {
    const directory = root();
    for (const sessionId of ["../../etc/passwd", "00000000-0000-1000-8000-000000000001", ""] ) {
      expect(() => claimAutoTitle(options(directory, sessionId))).toThrow("invalid session UUID");
    }
  });

  test("rejects a symlinked ancestor in the state path", () => {
    const parent = root();
    const target = root();
    symlinkSync(target, join(parent, "redirect"));
    expect(() => claimAutoTitle(options(join(parent, "redirect", "state")))).toThrow();
  });

  test("keeps a stable private lock inode across actions", async () => {
    const directory = root();
    const sessionId = id();
    await expect(withSessionTitleLock(options(directory, sessionId), async () => "done", 500)).resolves.toBe("done");
    const info = lstatSync(join(directory, `${sessionId}.lock`));
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o7777).toBe(0o600);
  });

  test("serializes concurrent actions through the kernel lock", async () => {
    const directory = root();
    const sessionId = id();
    const state = options(directory, sessionId);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const hold = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = withSessionTitleLock(state, async () => {
      order.push("first");
      markEntered();
      await hold;
      order.push("first-done");
    }, 1_000);
    await entered;
    const second = withSessionTitleLock(state, async () => { order.push("second"); }, 1_000);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(order).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "first-done", "second"]);
  });

  test("closes the lock descriptor when lock-file validation fails", async () => {
    const directory = root();
    const sessionId = id();
    writeFileSync(join(directory, `${sessionId}.lock`), "", { mode: 0o644 });
    const before = readdirSync("/proc/self/fd").length;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(withSessionTitleLock(options(directory, sessionId), async () => undefined, 100)).rejects.toThrow();
    }
    const after = readdirSync("/proc/self/fd").length;
    expect(after).toBeLessThanOrEqual(before + 1);
  });

  test("creates a missing directory safely", () => {
    const parent = root();
    const directory = join(parent, "nested", "state");
    mkdirSync(join(parent, "nested"), 0o700);
    const state = options(directory);
    expect(claimAutoTitle(state)).toBe(true);
    expect(readSessionTitleState(state)?.status).toBe("claimed");
  });
});
