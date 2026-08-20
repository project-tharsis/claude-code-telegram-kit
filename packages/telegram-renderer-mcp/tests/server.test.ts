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
  test("handshakes and exposes only the internal hook tools", async () => {
    const transport = new StdioClientTransport({
      command: execPath,
      args: ["run", resolve(import.meta.dir, "../src/server.ts")]
    });
    const client = new Client({ name: "renderer-test", version: "0.1.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual([
      "bind_turn",
      "record_tool",
      "record_tool_success",
      "record_tool_failure",
      "finish_turn"
    ]);
    for (const tool of result.tools) {
      expect(tool.description).toContain("Internal Claude Code hook tool");
      expect(tool.inputSchema.properties).not.toHaveProperty("tool_input");
      expect(tool.inputSchema.properties).toHaveProperty("hook_event_name");
    }
  }, 10_000);

  test("rejects a spoofed internal hook call without failing the caller", async () => {
    const transport = new StdioClientTransport({
      command: execPath,
      args: ["run", resolve(import.meta.dir, "../src/server.ts")]
    });
    const client = new Client({ name: "renderer-test", version: "0.1.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({
      name: "record_tool",
      arguments: {
        session_id: "3fcbaf06-4378-4339-b026-8c2e026a65e7",
        prompt_id: "p1",
        tool_use_id: "t1",
        tool_name: "Read",
        hook_event_name: "Stop"
      }
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  }, 10_000);
});
