import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_NATIVE_MEMORY_FILE_BYTES,
  observeNativeMemory,
  readNativeMemoryReviewContext,
  resolveConfiguredAutoMemoryDirectory
} from "../src/native-memory-observer.js";

const RELEASE_SHA = "a".repeat(40);

function writeMemory(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o644 });
}

describe("Claude native auto-memory observer", () => {
  let root: string;
  let memory: string;
  let settings: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "native-memory-observer-"));
    memory = join(root, "memory");
    mkdirSync(memory, { mode: 0o755 });
    settings = join(root, "settings.json");
    writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: memory }), { mode: 0o600 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("discovers one explicit absolute autoMemoryDirectory from Claude settings", () => {
    expect(resolveConfiguredAutoMemoryDirectory({ settingsPath: settings })).toBe(memory);
  });

  test("fails closed when autoMemoryDirectory is absent, relative, symlinked, or writable by group/other", () => {
    writeFileSync(settings, "{}", { mode: 0o600 });
    expect(() => resolveConfiguredAutoMemoryDirectory({ settingsPath: settings })).toThrow("autoMemoryDirectory");

    writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: "relative/memory" }), { mode: 0o600 });
    expect(() => resolveConfiguredAutoMemoryDirectory({ settingsPath: settings })).toThrow("absolute");

    const real = join(root, "real-settings.json");
    writeFileSync(real, JSON.stringify({ autoMemoryDirectory: memory }), { mode: 0o600 });
    const linked = join(root, "linked-settings.json");
    symlinkSync(real, linked);
    expect(() => resolveConfiguredAutoMemoryDirectory({ settingsPath: linked })).toThrow("unsafe settings");

    chmodSync(settings, 0o600);
    const realSettingsDir = join(root, "real-settings");
    mkdirSync(realSettingsDir, { mode: 0o700 });
    writeFileSync(join(realSettingsDir, "settings.json"), JSON.stringify({ autoMemoryDirectory: memory }), { mode: 0o600 });
    symlinkSync(realSettingsDir, join(root, "settings-link"), "dir");
    expect(() => resolveConfiguredAutoMemoryDirectory({
      settingsPath: join(root, "settings-link", "settings.json")
    })).toThrow(/settings directory/);

    writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: memory }));
    chmodSync(settings, 0o660);
    expect(() => resolveConfiguredAutoMemoryDirectory({ settingsPath: settings })).toThrow("unsafe settings");
  });

  test("returns a sorted, content-free inventory with stable hashes, provenance, and watermark", () => {
    writeMemory(join(memory, "topic-b.md"), "beta\n");
    writeMemory(join(memory, "MEMORY.md"), "# Index\n");
    writeMemory(join(memory, "topic-a.md"), "alpha\n");
    writeFileSync(join(memory, "ignored.txt"), "not memory", { mode: 0o644 });
    const before = readdirSync(memory).sort();

    const first = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, now: 1_000 });
    const second = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, now: 2_000 });

    expect(first.files.map(file => file.path)).toEqual(["MEMORY.md", "topic-a.md", "topic-b.md"]);
    expect(first.files.every(file => file.provenance === "claude_native_auto_memory")).toBe(true);
    expect(first.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    expect(first.files.every(file => !("content" in file))).toBe(true);
    expect(first.directory_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.watermark).toBe(second.watermark);
    expect(first.observed_at).toBe(1_000);
    expect(second.observed_at).toBe(2_000);
    expect(readdirSync(memory).sort()).toEqual(before);
  });

  test("opens files through the pinned directory and fails closed on unsafe Markdown leaves", () => {
    writeMemory(join(memory, "MEMORY.md"), "# Index\n");

    const target = join(root, "outside.md");
    writeMemory(target, "outside\n");
    symlinkSync(target, join(memory, "linked.md"));
    expect(() => observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA })).toThrow("unsafe memory file");
    rmSync(join(memory, "linked.md"));

    const hard = join(memory, "hard.md");
    linkSync(target, hard);
    expect(() => observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA })).toThrow("unsafe memory file");
    rmSync(hard);

    const writable = join(memory, "writable.md");
    writeMemory(writable, "unsafe\n");
    chmodSync(writable, 0o664);
    expect(() => observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA })).toThrow("unsafe memory file");
  });

  test("rejects a missing, symlinked, or writable auto-memory directory", () => {
    const missing = join(root, "missing");
    expect(() => observeNativeMemory({ memoryDirectory: missing, releaseSha: RELEASE_SHA })).toThrow("memory directory");

    const linked = join(root, "linked-memory");
    symlinkSync(memory, linked);
    expect(() => observeNativeMemory({ memoryDirectory: linked, releaseSha: RELEASE_SHA })).toThrow("memory directory");

    chmodSync(memory, 0o775);
    expect(() => observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA })).toThrow("memory directory");
  });

  test("enforces file count and per-file byte caps before returning an inventory", () => {
    writeMemory(join(memory, "MEMORY.md"), "# Index\n");
    writeMemory(join(memory, "topic.md"), "x".repeat(MAX_NATIVE_MEMORY_FILE_BYTES + 1));
    expect(() => observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA })).toThrow("size limit");

    rmSync(join(memory, "topic.md"));
    writeMemory(join(memory, "one.md"), "1");
    writeMemory(join(memory, "two.md"), "2");
    expect(() => observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, maxFiles: 2 })).toThrow("file count");
  });

  test("returns a hash-bound review context with deterministic bounded topics", () => {
    writeMemory(join(memory, "MEMORY.md"), "# Memory\n- [Alpha](alpha.md)\n");
    writeMemory(join(memory, "zeta.md"), "zeta preference\n");
    writeMemory(join(memory, "alpha.md"), "alpha preference\n");
    const observation = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA, now: 1_000 });
    const context = readNativeMemoryReviewContext(observation, { maxTopics: 1 });

    expect(context.currentMemoryIndex).toBe("# Memory\n- [Alpha](alpha.md)\n");
    expect(context.relevantTopics).toEqual([{
      path: "alpha.md",
      contentHash: observation.files.find(file => file.path === "alpha.md")!.sha256,
      excerpt: "alpha preference\n"
    }]);
    expect(observation.files.every(file => !("content" in file))).toBe(true);
  });

  test("rejects stale selected topic bytes, invalid UTF-8, or a missing MEMORY.md index", () => {
    writeMemory(join(memory, "MEMORY.md"), "# Memory\n");
    writeMemory(join(memory, "topic.md"), "before\n");
    const stale = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA });
    writeMemory(join(memory, "topic.md"), "after\n");
    expect(() => readNativeMemoryReviewContext(stale)).toThrow("changed after observation");

    rmSync(join(memory, "topic.md"));
    writeFileSync(join(memory, "invalid.md"), Buffer.from([0xff, 0xfe]), { mode: 0o644 });
    const invalid = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA });
    expect(() => readNativeMemoryReviewContext(invalid)).toThrow("UTF-8");

    rmSync(join(memory, "MEMORY.md"));
    rmSync(join(memory, "invalid.md"));
    writeMemory(join(memory, "only-topic.md"), "topic\n");
    const missing = observeNativeMemory({ memoryDirectory: memory, releaseSha: RELEASE_SHA });
    expect(() => readNativeMemoryReviewContext(missing)).toThrow("MEMORY.md");
  });

  test("rejects invalid release provenance and never changes native memory bytes", () => {
    const index = join(memory, "MEMORY.md");
    writeMemory(index, "# Index\n");
    const before = readFileSync(index);
    const statBefore = lstatSync(index);

    expect(() => observeNativeMemory({ memoryDirectory: memory, releaseSha: "not-a-sha" })).toThrow("release SHA");
    expect(readFileSync(index)).toEqual(before);
    expect(lstatSync(index).ino).toBe(statBefore.ino);
  });
});
