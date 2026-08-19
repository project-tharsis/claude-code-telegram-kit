import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  finalizeTelegramReaction,
  loadRuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import { createHookToolHandler, INTERNAL_HOOK_TOOLS } from "./hook-tools.js";
import { createTurnDisclosure } from "./progress-disclosure.js";
import { editProgressBubble, sendProgressBubble } from "./progress-transport.js";
import { createUnifiedDeliverer } from "./unified-delivery.js";
import { createUnifiedToolHandler, SEND_REPLY_TOOL } from "./unified-tool.js";

const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const stateDir = process.env.TELEGRAM_STATE_DIR ?? join(configRoot, "channels", "telegram");
const loadConfig = () => loadRuntimeConfig(stateDir);
const deliver = createUnifiedDeliverer();
const handleTool = createUnifiedToolHandler({
  loadConfig,
  deliver,
  react: finalizeTelegramReaction
});

// One long-lived process per Claude Code session owns all ephemeral per-turn disclosure state.
const disclosure = createTurnDisclosure({
  loadConfig,
  send: (config, chatId, replyToMessageId, text) =>
    sendProgressBubble(config, chatId, replyToMessageId, text),
  edit: (config, chatId, messageId, text) =>
    editProgressBubble(config, chatId, messageId, text),
  schedule: (run, delayMs) => {
    const timer = setTimeout(() => {
      void run();
    }, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  }
});
const handleHookTool = createHookToolHandler(disclosure);

const server = new Server(
  { name: "telegram-renderer", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SEND_REPLY_TOOL, ...INTERNAL_HOOK_TOOLS]
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const hookResult = await handleHookTool(request.params.name, request.params.arguments);
  if (hookResult !== null) return hookResult;
  return handleTool(request.params.name, request.params.arguments);
});

await server.connect(new StdioServerTransport());
