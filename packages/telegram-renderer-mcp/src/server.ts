import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";
import { createUnifiedDeliverer } from "./unified-delivery.js";
import { createUnifiedToolHandler, SEND_REPLY_TOOL } from "./unified-tool.js";

const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const stateDir = process.env.TELEGRAM_STATE_DIR ?? join(configRoot, "channels", "telegram");
const deliver = createUnifiedDeliverer();
const handleTool = createUnifiedToolHandler({
  loadConfig: () => loadRuntimeConfig(stateDir),
  deliver
});

const server = new Server(
  { name: "telegram-renderer", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SEND_REPLY_TOOL]
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  return handleTool(request.params.name, request.params.arguments);
});

await server.connect(new StdioServerTransport());
