import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCapabilityStore } from "./command-capability.js";
import { createConfirmationChallengeStore } from "./control-command.js";
import { createControlCommandDispatcher } from "./command-dispatch.js";
import {
  CONTROL_COMMAND_TOOL,
  createControlRouterToolHandler
} from "./control-router-tool.js";
import { createResetController } from "./control.js";
import {
  createSessionScheduler,
  probeHelperCapabilities,
  sendTelegramMessage
} from "./runtime.js";
import {
  assertUsableSessionTranscript,
  readLatestSessionModel,
  scanResumableSessions
} from "./session-catalog.js";
import {
  defaultSelectionDirectory,
  readSelectionSnapshot,
  writeSelectionSnapshot
} from "./session-selection.js";
import { createSessionsController } from "./sessions-control.js";
import { createSessionsToolHandler, SESSIONS_TOOLS } from "./sessions-tool.js";
import { createToolHandler, RESET_TOOL } from "./tool.js";
import { DEFAULT_MODEL_ENV_FILE, readConfiguredModel } from "./model-status.js";
import { readSubscriptionUsage } from "./subscription-usage.js";
import { createSessionTitleService } from "./session-title-service.js";
import {
  deleteTelegramCommandMenu,
  syncTelegramCommandMenu
} from "./telegram-menu.js";
import { escapeTelegramHtml } from "./telegram-html.js";
import {
  finalizeTelegramReaction,
  loadRuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const stateDir = process.env.TELEGRAM_STATE_DIR ?? join(configRoot, "channels", "telegram");
/** Fixed server configuration. No sessions path is ever accepted from the model. */
const projectSessionsDir = process.env.CLAUDE_PROJECT_SESSIONS_DIR;
const workspaceDir = process.env.CLAUDE_WORKSPACE_DIR;
const selectionDir = defaultSelectionDirectory();
const loadConfig = () => loadRuntimeConfig(stateDir);

/**
 * A skew between this checkout and the installed root helper disables the privileged actions
 * rather than letting a user be told an action was accepted that the helper cannot perform.
 * Listing stays available because it needs no privileged helper at all.
 */
const PREFLIGHT_TIMEOUT_MS = 5_000;
let helperReady = false;
try {
  helperReady = await Promise.race([
    probeHelperCapabilities().then(() => true),
    new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), PREFLIGHT_TIMEOUT_MS);
      timer.unref?.();
    })
  ]);
} catch {
  helperReady = false;
}

const scheduler = createSessionScheduler();
const capabilities = createCapabilityStore({ loadConfig });
const challenges = createConfirmationChallengeStore();
const titleService = projectSessionsDir !== undefined && workspaceDir !== undefined
  ? createSessionTitleService({ projectSessionsDir, workspaceDir })
  : null;

const controller = createResetController({
  loadConfig,
  sendMessage: (config, chatId, text, replyTo, parseMode) =>
    sendTelegramMessage(config, chatId, text, fetch, replyTo, parseMode),
  react: finalizeTelegramReaction,
  schedule: (chatId, messageId) => {
    if (!helperReady) throw new Error("session reset is unavailable on this host");
    return scheduler.scheduleReset(chatId, messageId);
  }
});
const handleTool = createToolHandler(controller);

const sessionsController = createSessionsController({
  loadConfig,
  capabilities,
  scanSessions: currentSessionId =>
    projectSessionsDir === undefined
      ? []
      : scanResumableSessions({ directory: projectSessionsDir, currentSessionId }),
  readSnapshot: chatId => readSelectionSnapshot({ directory: selectionDir, chatId }),
  writeSnapshot: snapshot => writeSelectionSnapshot({ directory: selectionDir, ...snapshot }),
  verifySelectedSession: sessionId => {
    if (projectSessionsDir === undefined) {
      throw new Error("project sessions directory is not configured");
    }
    assertUsableSessionTranscript({ directory: projectSessionsDir, sessionId });
  },
  sendMessage: (config, chatId, text, replyTo, parseMode) =>
    sendTelegramMessage(config, chatId, text, fetch, replyTo, parseMode),
  react: finalizeTelegramReaction,
  scheduleResume: (chatId, messageId, currentSessionId, sessionId) =>
    scheduler.scheduleResume(chatId, messageId, currentSessionId, sessionId),
  helperReady: () => helperReady,
  now: Date.now
});
const handleSessionsTool = createSessionsToolHandler({
  controller: sessionsController,
  capabilities
});
const dispatchControlCommand = createControlCommandDispatcher({
  loadConfig,
  challenges,
  sendMessage: (config, chatId, text, replyTo, parseMode, replyMarkup) =>
    sendTelegramMessage(config, chatId, text, fetch, replyTo, parseMode, replyMarkup),
  react: finalizeTelegramReaction,
  listSessionsTrusted: request => sessionsController.listSessionsTrusted(request),
  getUsage: () => readSubscriptionUsage(),
  getModelStatus: async sessionId => {
    const actual = projectSessionsDir === undefined
      ? null
      : readLatestSessionModel({ directory: projectSessionsDir, sessionId });
    const configured = readConfiguredModel({ path: DEFAULT_MODEL_ENV_FILE });
    return [
      "<b>Claude model</b>",
      `Current · <code>${escapeTelegramHtml(actual ?? "unknown")}</code>`,
      `Override · <code>${escapeTelegramHtml(configured)}</code>`,
      "",
      "<i>Choose below.</i>"
    ].join("\n");
  },
  switchModel: async request => {
    if (!helperReady) throw new Error("model switch is unavailable on this host");
    return {
      status: "scheduled" as const,
      unit: await scheduler.scheduleModel(request.chatId, request.messageId, request.model)
    };
  },
  renameSessionTitle: async request => {
    if (titleService === null) throw new Error("session title service is unavailable");
    await titleService.renameUserSession(request.sessionId, request.title);
  },

  resumeSessionTrusted: request => sessionsController.resumeSessionTrusted(request),
  resetSession: request => controller(request)
});
const handleControlRouterTool = createControlRouterToolHandler(dispatchControlCommand);

const server = new Server(
  { name: "session-control", version: "0.2.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [CONTROL_COMMAND_TOOL, RESET_TOOL, ...SESSIONS_TOOLS]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const routerResult = await handleControlRouterTool(request.params.name, request.params.arguments);
  if (routerResult !== null) return routerResult;
  const sessionsResult = await handleSessionsTool(request.params.name, request.params.arguments);
  if (sessionsResult !== null) return sessionsResult;
  return handleTool(request.params.name, request.params.arguments);
});
await server.connect(new StdioServerTransport());

const commandMenuMode = process.env.TELEGRAM_COMMAND_MENU_ENABLED;
if (commandMenuMode === "true" || commandMenuMode === "delete") {
  void (async () => {
    try {
      const count = commandMenuMode === "true"
        ? await syncTelegramCommandMenu(loadConfig())
        : await deleteTelegramCommandMenu(loadConfig());
      const action = commandMenuMode === "true" ? "synced" : "deleted";
      process.stderr.write(`telegram command menu: ${action} ${count} private chat scope(s)\n`);
    } catch {
      // Menu state is an optional UI affordance. Command authority and the MCP stay available.
      process.stderr.write("telegram command menu: sync failed\n");
    }
  })();
}
