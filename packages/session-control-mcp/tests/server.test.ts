import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { execPath } from "node:process";

const clients: Client[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()!.close();
});

describe("control stdio MCP server", () => {
  test("handshakes and exposes the reset, listing, resume, and binder tools", async () => {
    const transport = new StdioClientTransport({
      command: execPath,
      args: ["run", resolve(import.meta.dir, "../src/server.ts")]
    });
    const client = new Client({ name: "control-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual([
      "schedule_session_reset",
      "list_sessions",
      "resume_session",
      "bind_command"
    ]);
    expect(result.tools[0]!.inputSchema.properties).toHaveProperty("confirmation");

    const resume = result.tools.find(tool => tool.name === "resume_session")!;
    expect(Object.keys(resume.inputSchema.properties!).sort()).toEqual(["chat_id", "index"]);
    expect(resume.annotations?.destructiveHint).toBe(true);

    const binder = result.tools.find(tool => tool.name === "bind_command")!;
    expect(binder.description).toContain("Internal Claude Code hook tool");
  }, 20_000);

  test("fails a resume closed when no current command capability exists", async () => {
    const transport = new StdioClientTransport({
      command: execPath,
      args: ["run", resolve(import.meta.dir, "../src/server.ts")]
    });
    const client = new Client({ name: "control-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({
      name: "resume_session",
      arguments: { chat_id: "123", index: 1 }
    });

    expect(result.isError).toBe(true);
  }, 20_000);
});
