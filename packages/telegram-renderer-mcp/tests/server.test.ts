import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { execPath } from "node:process";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
});

describe("stdio MCP server", () => {
  test("handshakes and exposes only send_reply", async () => {
    const transport = new StdioClientTransport({
      command: execPath,
      args: ["run", resolve(import.meta.dir, "../src/server.ts")]
    });
    const client = new Client({ name: "renderer-test", version: "0.1.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual(["send_reply"]);
    expect(result.tools[0]!.inputSchema.properties).toHaveProperty("content");
  }, 10_000);
});
