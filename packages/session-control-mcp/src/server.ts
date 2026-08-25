import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";

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
import { DEFAULT_MODEL_ENV_FILE, readConfiguredModel } from "./model-status.js";
import { createOAuthUsageReader } from "./oauth-usage.js";
import {
  formatUnavailableUsage,
  formatUsageSnapshot,
  readSubscriptionUsage,
  type ActiveUsageQuota
} from "./subscription-usage.js";
import { createSessionTitleService } from "./session-title-service.js";
import {
  deleteTelegramCommandMenu,
  syncTelegramCommandMenu
} from "./telegram-menu.js";
import { escapeTelegramHtml } from "./telegram-html.js";
import {
  createControlMessageClaims,
  isAttestedUsageQueueRuntime,
  mergeActiveQuotaState,
  watchQueuedUsageControls
} from "./usage-queue-watcher.js";
import {
  assertAuthorizedChat,
  finalizeTelegramReaction,
  formatRateLimitNotice,
  loadRuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";

const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const stateDir = process.env.TELEGRAM_STATE_DIR ?? join(configRoot, "channels", "telegram");
/** Fixed server configuration. No sessions path is ever accepted from the model. */
const projectSessionsDir = process.env.CLAUDE_PROJECT_SESSIONS_DIR;
const workspaceDir = process.env.CLAUDE_WORKSPACE_DIR;
const selectionDir = defaultSelectionDirectory();
const loadConfig = () => loadRuntimeConfig(stateDir);
const usageQueueAttested = isAttestedUsageQueueRuntime(process.env);
let activeQuota: ActiveUsageQuota | undefined;
const observeQuotaState = (state: ActiveUsageQuota): void => {
  activeQuota = mergeActiveQuotaState(activeQuota, state, Date.now());
};
const oauthUsageEnabled = process.env.CLAUDE_OAUTH_USAGE_ENABLED === "true";
const oauthUserAgent = process.env.CLAUDE_OAUTH_USAGE_USER_AGENT;
if (oauthUsageEnabled && oauthUserAgent === undefined) {
  throw new Error("CLAUDE_OAUTH_USAGE_USER_AGENT is required when OAuth usage is enabled");
}
const readOAuthUsage = oauthUsageEnabled
  ? createOAuthUsageReader({ userAgent: oauthUserAgent as string })
  : async () => null;

const scheduler = createSessionScheduler();
const helperReady = async (): Promise<boolean> => {
  try {
    await probeHelperCapabilities();
    return true;
  } catch {
    return false;
  }
};
const challenges = createConfirmationChallengeStore();
const titleService = projectSessionsDir !== undefined && workspaceDir !== undefined
  ? createSessionTitleService({ projectSessionsDir, workspaceDir })
  : null;

const controller = createResetController({
  loadConfig,
  helperReady,
  sendMessage: (config, chatId, text, replyTo, parseMode) =>
    sendTelegramMessage(config, chatId, text, fetch, replyTo, parseMode),
  react: finalizeTelegramReaction,
  schedule: (chatId, messageId, currentSessionId) => scheduler.scheduleReset(chatId, messageId, currentSessionId)
});
const sessionsController = createSessionsController({
  loadConfig,
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
  helperReady,
  now: Date.now
});

const controlClaims = createControlMessageClaims();
const dispatchControlCommand = createControlCommandDispatcher({
  claimControlMessage: controlClaims.claim,
  usageQueueAttested,
  now: Date.now,
  loadConfig,
  challenges,
  sendMessage: (config, chatId, text, replyTo, parseMode, replyMarkup) =>
    sendTelegramMessage(config, chatId, text, fetch, replyTo, parseMode, replyMarkup),
  react: finalizeTelegramReaction,
  listSessionsTrusted: request => sessionsController.listSessionsTrusted(request),
  getUsage: async () => {
    const now = Date.now();
    if (oauthUsageEnabled) {
      const live = await readOAuthUsage();
      if (live !== null) return formatUsageSnapshot(live, now, activeQuota, true);
    }
    try {
      return await readSubscriptionUsage(activeQuota === undefined ? {} : { activeQuota });
    } catch {
      return formatUnavailableUsage(activeQuota, now);
    }
  },
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
    if (!await helperReady()) throw new Error("model switch is unavailable on this host");
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

if (usageQueueAttested) {
  if (projectSessionsDir === undefined) throw new Error("project sessions directory is not configured");
  const watcher = watchQueuedUsageControls({
    directory: projectSessionsDir,
    dispatch: input => dispatchControlCommand(input, "queue"),
    onQuotaState: observeQuotaState,
    sendQuotaNotice: async ({ chatId, messageId, resetsAt }) => {
      const config = loadConfig();
      assertAuthorizedChat(config, chatId);
      await sendTelegramMessage(config, chatId, formatRateLimitNotice(resetsAt), fetch, messageId);
      try { await finalizeTelegramReaction(config, chatId, messageId, "success"); } catch { /* reply is authoritative */ }
    }
  });
  process.once("exit", watcher.close);
}

const server = new Server(
  { name: "session-control", version: "0.4.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [CONTROL_COMMAND_TOOL]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const routerResult = await handleControlRouterTool(request.params.name, request.params.arguments);
  if (routerResult !== null) return routerResult;
  return { isError: true, content: [{ type: "text", text: "unknown control tool" }] };
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
