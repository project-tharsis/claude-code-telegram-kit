import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { createResetController } from "./control.js";
import { createResetScheduler, sendTelegramMessage } from "./runtime.js";
import { createToolHandler, RESET_TOOL } from "./tool.js";
import {
  finalizeTelegramReaction,
  loadRuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const stateDir = process.env.TELEGRAM_STATE_DIR ?? join(configRoot, "channels", "telegram");
const controller = createResetController({
  loadConfig: () => loadRuntimeConfig(stateDir),
  sendMessage: sendTelegramMessage,
  react: finalizeTelegramReaction,
  schedule: createResetScheduler()
});
const handleTool = createToolHandler(controller);

const server = new Server(
  { name: "session-control", version: "0.2.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [RESET_TOOL] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  return handleTool(request.params.name, request.params.arguments);
});
await server.connect(new StdioServerTransport());
