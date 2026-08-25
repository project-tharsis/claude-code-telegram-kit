import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedCliTimeoutError, runIsolatedCli } from "../src/isolated-cli-runner.js";

describe("isolated CLI process-tree timeout", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "isolated-cli-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("returns bounded output for a normal one-shot process", async () => {
    const result = await runIsolatedCli([process.execPath, "-e", "console.log('ok')"], {
      timeoutMs: 2_000,
      maxOutputBytes: 64,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  test("kills descendants in the detached process group on timeout", async () => {
    const helper = join(directory, "spawn-child.ts");
    const pidFile = join(directory, "grandchild.pid");
    writeFileSync(helper, [
      "const child = Bun.spawn(['/bin/sleep', '60']);",
      "await Bun.write(process.argv[2]!, String(child.pid));",
      "await new Promise(() => undefined);",
    ].join("\n"));

    await expect(runIsolatedCli([process.execPath, helper, pidFile], {
      timeoutMs: 150,
      maxOutputBytes: 64,
      cwd: directory,
    })).rejects.toBeInstanceOf(IsolatedCliTimeoutError);

    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = raw.lastIndexOf(")");
        const state = close < 0 ? "?" : raw.slice(close + 2).trim().split(/\s+/)[0];
        alive = state !== "Z";
      } catch {
        alive = false;
      }
      if (alive) await Bun.sleep(25);
    }
    expect(alive).toBe(false);
  });
});
