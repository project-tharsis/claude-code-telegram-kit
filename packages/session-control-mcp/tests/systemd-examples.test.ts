import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const claudeUnit = readFileSync(resolve(root, "examples/claude-telegram.service"), "utf8");
const socketUnit = readFileSync(resolve(root, "examples/claude-code-control.socket"), "utf8");
const brokerUnit = readFileSync(resolve(root, "examples/claude-code-control@.service"), "utf8");
const hardeningDropIn = readFileSync(resolve(root, "examples/claude-telegram-hardening.conf"), "utf8");
const runtime = readFileSync(resolve(root, "packages/session-control-mcp/src/runtime.ts"), "utf8");
const broker = readFileSync(resolve(root, "packages/session-control-mcp/scripts/claude_code_control_broker.py"), "utf8");

describe("root broker deployment examples", () => {
  test("runs the Claude service without privilege gain and requires the socket", () => {
    expect(claudeUnit).toContain("Requires=claude-code-control.socket");
    expect(claudeUnit).toContain("NoNewPrivileges=yes");
    expect(claudeUnit).toContain("PrivateTmp=yes");
    expect(claudeUnit).toContain("RestrictSUIDSGID=yes");
    expect(hardeningDropIn).toContain("Requires=claude-code-control.socket");
    expect(hardeningDropIn).toContain("After=claude-code-control.socket");
    expect(hardeningDropIn).toContain("NoNewPrivileges=yes");
  });

  test("owns a private accepted socket and a root hardened connection service", () => {
    expect(socketUnit).toContain("SocketMode=0600");
    expect(socketUnit).toContain("SocketUser=USER");
    expect(socketUnit).toContain("Accept=yes");
    expect(socketUnit).toContain("MaxConnections=32");
    expect(brokerUnit).toContain("User=root");
    expect(brokerUnit).toContain("StandardInput=socket");
    expect(brokerUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(brokerUnit).toContain("TasksMax=8");
    expect(brokerUnit).toContain("MemoryMax=128M");
    expect(brokerUnit).toContain("LimitNOFILE=64");
  });

  test("keeps sudo and systemd-run out of the unprivileged runtime", () => {
    expect(runtime).not.toContain("/usr/bin/sudo");
    expect(runtime).not.toContain("systemd-run");
    expect(broker).toContain("/usr/bin/systemd-run");
    expect(broker).not.toContain("/usr/bin/sudo");
  });
});
