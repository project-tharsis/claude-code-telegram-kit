import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import { createArtifactDeliverer } from "../src/artifact-delivery.js";

const SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "artifact-delivery-"));
  const root = join(base, "project");
  const scratchpad = join(root, SESSION, "scratchpad");
  mkdirSync(scratchpad, { recursive: true, mode: 0o700 });
  const file = join(scratchpad, "report.html");
  writeFileSync(file, "<h1>Report</h1>", { mode: 0o600 });
  roots.push(base);
  return { base, root, scratchpad, file };
}

function candidate(path: string, description?: string) {
  return { sessionId: SESSION, path, ...(description === undefined ? {} : { description }) };
}

const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };

function ok(messageId: number): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("deterministic Artifact delivery", () => {
  test("sends a trusted file as one silent quoted document", async () => {
    const f = fixture();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const deliver = createArtifactDeliverer({
      root: f.root,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init! });
        return ok(91);
      }
    });

    expect(await deliver(config, "123", "51", [candidate(f.file, "report")]))
      .toEqual({ kind: "success", messageIds: [91] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/sendDocument")).toBe(true);
    expect(calls[0]!.init.redirect).toBe("error");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("chat_id")).toBe("123");
    expect(form.get("reply_parameters")).toBe(JSON.stringify({ message_id: 51 }));
    expect(form.get("disable_notification")).toBe("true");
    const document = form.get("document") as File;
    expect(document.name).toBe("report.html");
    expect(await document.text()).toBe("<h1>Report</h1>");
  });

  test("rejects an unauthorized chat and never reads or sends", async () => {
    const f = fixture();
    let calls = 0;
    const deliver = createArtifactDeliverer({ root: f.root, fetchImpl: async () => { calls += 1; return ok(1); } });
    await expect(deliver(config, "999", "51", [candidate(f.file)])).rejects.toThrow("chat is not authorized");
    expect(calls).toBe(0);
  });

  test("rejects an invalid reply ID before touching an artifact path", async () => {
    const f = fixture();
    let calls = 0;
    const deliver = createArtifactDeliverer({ root: f.root, fetchImpl: async () => { calls += 1; return ok(1); } });
    expect(await deliver(config, "123", "9007199254740993", [candidate(join(f.scratchpad, "missing.txt"))]))
      .toEqual({ kind: "local_rejected", messageIds: [] });
    expect(calls).toBe(0);
  });

  test("does not leak directory descriptors across repeated missing artifacts", async () => {
    const f = fixture();
    const deliver = createArtifactDeliverer({ root: f.root, fetchImpl: async () => ok(1) });
    const before = readdirSync("/proc/self/fd").length;
    for (let index = 0; index < 100; index += 1) {
      expect(await deliver(config, "123", "51", [candidate(join(f.scratchpad, `missing-${index}.txt`))]))
        .toEqual({ kind: "local_rejected", messageIds: [] });
    }
    expect(readdirSync("/proc/self/fd").length).toBe(before);
  });

  test("rejects paths outside the root, nested paths, symlinks, hardlinks, and writable files", async () => {
    const f = fixture();
    const outside = join(f.base, "outside.txt");
    const symlink = join(f.scratchpad, "link.txt");
    const hardlink = join(f.scratchpad, "hard.txt");
    const writable = join(f.scratchpad, "writable.txt");
    const nestedDir = join(f.scratchpad, "nested");
    const nested = join(nestedDir, "nested.txt");
    writeFileSync(outside, "outside", { mode: 0o600 });
    symlinkSync(f.file, symlink);
    linkSync(f.file, hardlink);
    writeFileSync(writable, "writable", { mode: 0o666 });
    chmodSync(writable, 0o666);
    mkdirSync(nestedDir, { mode: 0o700 });
    writeFileSync(nested, "nested", { mode: 0o600 });
    let calls = 0;
    const deliver = createArtifactDeliverer({ root: f.root, fetchImpl: async () => { calls += 1; return ok(1); } });

    for (const path of [outside, nested, symlink, hardlink, writable]) {
      expect(await deliver(config, "123", "51", [candidate(path)]))
        .toEqual({ kind: "local_rejected", messageIds: [] });
    }
    expect(calls).toBe(0);
  });

  test("rejects the aggregate budget before retaining another file", async () => {
    const f = fixture();
    const second = join(f.scratchpad, "second.txt");
    writeFileSync(second, "second", { mode: 0o600 });
    let calls = 0;
    const deliver = createArtifactDeliverer({
      root: f.root,
      maxTotalBytes: 20,
      fetchImpl: async () => { calls += 1; return ok(1); }
    });
    expect(await deliver(config, "123", "51", [candidate(f.file), candidate(second)]))
      .toEqual({ kind: "local_rejected", messageIds: [] });
    expect(calls).toBe(0);
  });

  test("stops after an uncertain later upload without replaying confirmed files", async () => {
    const f = fixture();
    const second = join(f.scratchpad, "second.txt");
    writeFileSync(second, "second", { mode: 0o600 });
    let calls = 0;
    const deliver = createArtifactDeliverer({
      root: f.root,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return ok(101);
        throw new TypeError("connection reset");
      }
    });

    expect(await deliver(config, "123", "51", [candidate(f.file), candidate(second)]))
      .toEqual({ kind: "uncertain", messageIds: [101] });
    expect(calls).toBe(2);
  });

  test("classifies definitive 4xx as permanent and retryable or malformed outcomes as uncertain", async () => {
    const f = fixture();
    const permanent = createArtifactDeliverer({
      root: f.root,
      fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 400 })
    });
    expect(await permanent(config, "123", "51", [candidate(f.file)]))
      .toEqual({ kind: "permanent", messageIds: [] });

    for (const status of [401, 403]) {
      const denied = createArtifactDeliverer({
        root: f.root,
        fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status })
      });
      expect(await denied(config, "123", "51", [candidate(f.file)]))
        .toEqual({ kind: "permanent", messageIds: [] });
    }

    const throttled = createArtifactDeliverer({
      root: f.root,
      fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 429 })
    });
    expect(await throttled(config, "123", "51", [candidate(f.file)]))
      .toEqual({ kind: "uncertain", messageIds: [] });

    const uncertain = createArtifactDeliverer({
      root: f.root,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 0 } }), { status: 200 })
    });
    expect(await uncertain(config, "123", "51", [candidate(f.file)]))
      .toEqual({ kind: "uncertain", messageIds: [] });
  });
});
