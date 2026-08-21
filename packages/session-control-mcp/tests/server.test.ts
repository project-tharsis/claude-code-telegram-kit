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
  test("handshakes and exposes only the deterministic router", async () => {
    const transport = new StdioClientTransport({
      command: execPath,
      args: ["run", resolve(import.meta.dir, "../src/server.ts")]
    });
    const client = new Client({ name: "control-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual(["dispatch_command"]);
    const router = result.tools[0]!;
    expect(router.description).toContain("before the LLM");
  }, 20_000);

  test("rejects removed legacy session tools", async () => {
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
    expect(result.content).toEqual([{ type: "text", text: "unknown control tool" }]);
  }, 20_000);
});
