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
  test("handshakes and exposes only schedule_session_reset", async () => {
    const transport = new StdioClientTransport({
      command: execPath,
      args: ["run", resolve(import.meta.dir, "../src/server.ts")]
    });
    const client = new Client({ name: "control-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual(["schedule_session_reset"]);
    expect(result.tools[0]!.inputSchema.properties).toHaveProperty("confirmation");
  }, 10_000);
});
