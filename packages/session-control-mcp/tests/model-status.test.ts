import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguredModel } from "../src/model-status.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(content?: string) {
  const root = mkdtempSync(join(tmpdir(), "model-status-")); roots.push(root);
  const path = join(root, "model.env");
  if (content !== undefined) writeFileSync(path, content, { mode: 0o644 });
  return { path, uid: process.getuid!() };
}

describe("model env status", () => {
  test("treats a missing file as inherit and reads a fixed alias", () => {
    const f = fixture();
    expect(readConfiguredModel({ path: f.path, expectedUid: f.uid })).toBe("inherit");
    writeFileSync(f.path, "ANTHROPIC_MODEL=sonnet\n", { mode: 0o644 });
    expect(readConfiguredModel({ path: f.path, expectedUid: f.uid })).toBe("sonnet");
  });

  test("rejects unknown values, loose modes, symlinks, and hardlinks", () => {
    const unknown = fixture("ANTHROPIC_MODEL=fable\n");
    expect(() => readConfiguredModel({ path: unknown.path, expectedUid: unknown.uid })).toThrow();
    const loose = fixture("ANTHROPIC_MODEL=opus\n");
    chmodSync(loose.path, 0o600);
    expect(() => readConfiguredModel({ path: loose.path, expectedUid: loose.uid })).toThrow();
    chmodSync(loose.path, 0o666);
    expect(() => readConfiguredModel({ path: loose.path, expectedUid: loose.uid })).toThrow();
    const linked = fixture("ANTHROPIC_MODEL=haiku\n");
    const hard = `${linked.path}.hard`; linkSync(linked.path, hard);
    expect(() => readConfiguredModel({ path: linked.path, expectedUid: linked.uid })).toThrow();
    const symlinked = fixture(); symlinkSync(linked.path, symlinked.path);
    expect(() => readConfiguredModel({ path: symlinked.path, expectedUid: symlinked.uid })).toThrow();
  });
});
