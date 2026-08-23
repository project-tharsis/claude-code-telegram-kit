import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  finalizeTelegramReaction,
  loadRuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import { createHookToolHandler, INTERNAL_HOOK_TOOLS } from "./hook-tools.js";
import { createArtifactDeliverer } from "./artifact-delivery.js";
import { startArtifactTranscriptTracker } from "./artifact-transcript.js";
import { watchAuthFailureTranscript } from "./auth-failure-watcher.js";
import { createTurnDisclosure } from "./progress-disclosure.js";
import { parseToolDisclosureMode } from "./progress-preview.js";
import { editProgressBubble, sendProgressBubble, sendTypingAction } from "./progress-transport.js";
import { createTypingHeartbeatManager } from "./typing-heartbeat.js";
import {
  createUnifiedDeliverer,
  TelegramContentTooLargeError,
  TelegramUncertainOutcomeError
} from "./unified-delivery.js";

const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const stateDir = process.env.TELEGRAM_STATE_DIR ?? join(configRoot, "channels", "telegram");
const projectSessionsDir = process.env.CLAUDE_PROJECT_SESSIONS_DIR;
const serviceUid = process.getuid?.();
const artifactRoot = projectSessionsDir === undefined || serviceUid === undefined
  ? undefined
  : join("/tmp", `claude-${serviceUid}`, basename(projectSessionsDir));
const loadConfig = () => loadRuntimeConfig(stateDir);
const disclosureMode = parseToolDisclosureMode(process.env.TELEGRAM_TOOL_DISCLOSURE_MODE);
const deliver = createUnifiedDeliverer();
const deliverBackground = createUnifiedDeliverer(fetch, Date.now, false);
const deliverArtifacts = artifactRoot === undefined
  ? null
  : createArtifactDeliverer({ root: artifactRoot });
const AUTH_FAILURE_MESSAGE =
  "Claude Code authentication failed.\n\nRe-authenticate Claude Code on the host, then resend this message.";

const typing = createTypingHeartbeatManager({
  sendChatAction: (chatId, signal) => sendTypingAction(loadConfig(), chatId, fetch, signal)
});

// One long-lived process per Claude Code session owns all ephemeral per-turn disclosure state.
const disclosure = createTurnDisclosure({
  loadConfig,
  mode: disclosureMode,
  startTyping: chatId => typing.start(chatId),
  startArtifactTracking: input => projectSessionsDir === undefined
    ? null
    : startArtifactTranscriptTracker(input, { expectedRoot: projectSessionsDir }),
  startAuthFailureWatch: (input, onFailure) => {
    if (projectSessionsDir === undefined || input.transcript_path === undefined) return () => undefined;
    return watchAuthFailureTranscript({
      session_id: input.session_id,
      transcript_path: input.transcript_path
    }, {
      expectedRoot: projectSessionsDir,
      onAuthFailure: () => { void onFailure().catch(() => undefined); }
    });
  },
  sendAuthFailure: async (config, chatId, messageId) => {
    await deliver({
      chat_id: chatId,
      message_id: messageId,
      content: AUTH_FAILURE_MESSAGE,
      disable_notification: false
    }, config);
  },
  deliverFinal: async (config, chatId, messageId, content, artifacts, background = false) => {
    const deliverText = background ? deliverBackground : deliver;
    try {
      await deliverText({
        chat_id: chatId,
        message_id: messageId,
        content,
        disable_notification: false
      }, config);
      if (!background && artifacts.length > 0) {
        if (deliverArtifacts === null) {
          process.stderr.write("artifact delivery: root is not configured\n");
          try {
            await deliver({
              chat_id: chatId,
              message_id: messageId,
              content: "One or more artifacts could not be attached.",
              disable_notification: false
            }, config);
          } catch {
            // The canonical final text is already delivered.
          }
        } else {
          const result = await deliverArtifacts(config, chatId, messageId, artifacts);
          if (result.kind === "local_rejected" || result.kind === "permanent") {
            process.stderr.write(`artifact delivery: ${result.kind}\n`);
            try {
              await deliver({
                chat_id: chatId,
                message_id: messageId,
                content: "One or more artifacts could not be attached.",
                disable_notification: false
              }, config);
            } catch {
              // The canonical final text is already delivered.
            }
          } else if (result.kind === "uncertain") {
            process.stderr.write("artifact delivery: outcome uncertain; no retry\n");
          }
        }
      }
      return "delivered";
    } catch (error) {
      if (error instanceof TelegramContentTooLargeError) return "too_large";
      if (error instanceof TelegramUncertainOutcomeError) return "uncertain";
      if (!background) {
        try {
          await finalizeTelegramReaction(config, chatId, messageId, "failure");
        } catch {
          // Reaction UX never changes the proven final-delivery result.
        }
      }
      return "rejected";
    }
  },
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
  { name: "telegram-renderer", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...INTERNAL_HOOK_TOOLS]
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const hookResult = await handleHookTool(request.params.name, request.params.arguments);
  if (hookResult !== null) return hookResult;
  return { isError: true, content: [{ type: "text", text: "unknown renderer tool" }] };
});

await server.connect(new StdioServerTransport());
