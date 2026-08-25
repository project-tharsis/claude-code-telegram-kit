import { IsolatedCliTimeoutError, redactCredentials, runIsolatedCli } from "@project-tharsis/claude-code-telegram-shared";

export interface SessionTitleContext {
  userPrompt: string;
  assistantText: string;
  toolNames: string[];
}

export interface TitleCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type TitleCommandRunner = (argv: string[], options?: { timeoutMs: number }) => Promise<TitleCommandResult>;

export interface SessionTitleOptions {
  run?: TitleCommandRunner;
  claudePath?: string;
  timeoutMs?: number;
}

const MAX_CONTEXT_TEXT = 1200;
const MAX_TOOL_NAMES = 5;
const MAX_TOOL_NAME = 40;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const GENERIC_ERROR = "Session title generation failed";
export type SessionTitleGenerationPhase = "generate" | "parse";
export type SessionTitleGenerationReason = "timeout" | "command_failed" | "invalid_output";
export class SessionTitleGenerationError extends Error {
  constructor(public readonly phase: SessionTitleGenerationPhase, public readonly reason: SessionTitleGenerationReason, public readonly retryable: boolean) {
    super(GENERIC_ERROR);
    this.name = "SessionTitleGenerationError";
  }
}
const GENERIC_TITLES = new Set([
  "session", "new session", "untitled", "untitled conversation", "conversation", "chat", "assistant", "hello", "test"
]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const PATH = /(?:^|\s)(?:[a-zA-Z]:[\\/]|~[\\/]|\\\\|\/(?:home|Users|srv|etc|var|opt|tmp)\/|\.\.?[\\/])/;
const SENSITIVE_OUTPUT = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^:\s/@]+:[^@\s/]+@)/i;

// The credential pattern source lives in @project-tharsis/claude-code-telegram-shared
// (credential-patterns.ts) so this redaction pass can never independently drift from the
// bounded snapshot builder's and the strict proposal validator's copies again.
function redact(value: string): string {
  return redactCredentials(value);
}

function bounded(value: unknown, limit: number): string {
  return redact(typeof value === "string" ? value : "").slice(0, limit);
}

function buildPrompt(context: SessionTitleContext): string {
  const tools = (Array.isArray(context.toolNames) ? context.toolNames : [])
    .slice(0, MAX_TOOL_NAMES)
    .map((name) => bounded(name, MAX_TOOL_NAME).replace(/[\r\n]/g, " "));
  return [
    "Create a concise task-specific session title: 2-6 English words or a short CJK phrase. "
      + "Do not include paths, IDs, credentials, generic words like Session/Conversation, or punctuation wrappers. "
      + "Return only the requested structured title.",
    `User request: ${bounded(context.userPrompt, MAX_CONTEXT_TEXT)}`,
    `Assistant summary: ${bounded(context.assistantText, MAX_CONTEXT_TEXT)}`,
    `Tools used: ${tools.join(", ")}`
  ].join("\n");
}

// The spawn/timeout/env-allowlist/output-bounding logic itself lives in
// @project-tharsis/claude-code-telegram-shared (isolated-cli-runner.ts) so this generator's
// isolated-execution security boundary can never independently drift from the Memory Harness
// review generator's identical one.
async function defaultRunner(argv: string[], options: { timeoutMs: number }): Promise<TitleCommandResult> {
  try {
    return await runIsolatedCli(argv, { timeoutMs: options.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
  } catch (error) {
    if (error instanceof IsolatedCliTimeoutError) throw new SessionTitleGenerationError("generate", "timeout", true);
    throw error;
  }
}

/** Validate a normalized, model-produced session title before it reaches the UI. */
export function isValidSessionTitle(title: string): boolean {
  if (typeof title !== "string" || title.length < 3 || title.length > 60) return false;
  if (/[\r\n\u0000-\u001f\u007f<>]/.test(title) || UUID.test(title) || PATH.test(title)) return false;
  if (/(?:password|passwd|token|secret|api[_ -]?key|authorization|credential)\s*[:=]\s*[^\s,;]+/i.test(title)) return false;
  if (/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(title)) return false;
  if (/(?:\b(?:sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b|\b[A-Fa-f0-9]{32,}\b)/.test(title)) return false;
  if (/^(?:[A-Za-z0-9+/]{20,}={0,2})$/.test(title)) return false;
  if (SENSITIVE_OUTPUT.test(title)) return false;
  if (/^[!?#*_"'\[\]{}<>]|[!?#*_"'\[\]{}<>]$/u.test(title)) return false;
  const normalized = title.trim().toLowerCase();
  if (GENERIC_TITLES.has(normalized)) return false;
  const words = title.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  const hasCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(title);
  if (!hasCjk && (words.length < 2 || words.length > 8)) return false;
  return true;
}

function parseTitle(stdout: string): string | null {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) return null;
  let outer: unknown;
  try { outer = JSON.parse(stdout); } catch { return null; }
  if (typeof outer !== "object" || outer === null) return null;
  const record = outer as Record<string, unknown>;
  let structured: unknown = record.structured_output;
  if (structured === undefined && typeof record.result === "string") {
    try { structured = (JSON.parse(record.result) as Record<string, unknown>).structured_output; } catch { return null; }
  }
  if (typeof structured !== "object" || structured === null || typeof (structured as Record<string, unknown>).title !== "string") return null;
  const rawTitle = (structured as Record<string, unknown>).title;
  if (typeof rawTitle !== "string") return null;
  const title = rawTitle.replace(/\s+/g, " ").trim();
  return isValidSessionTitle(title) ? title : null;
}

export async function generateSessionTitle(
  context: SessionTitleContext,
  options: SessionTitleOptions = {}
): Promise<string> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  const schema = JSON.stringify({ type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false });
  const argv = [
    options.claudePath ?? "claude", "-p", buildPrompt(context),
    "--model", "haiku", "--output-format", "json", "--json-schema", schema,
    "--max-turns", "1", "--no-session-persistence", "--setting-sources", "",
    "--settings", "{}", "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
    "--tools", "", "--permission-mode", "dontAsk"
  ];
  try {
    const run = options.run ?? defaultRunner;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<TitleCommandResult>((_, reject) => {
      timeout = setTimeout(() => reject(new SessionTitleGenerationError("generate", "timeout", true)), timeoutMs);
    });
    const result = await Promise.race([run(argv, { timeoutMs }), timeoutResult])
      .finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    if (result.exitCode !== 0 || typeof result.stdout !== "string") throw new SessionTitleGenerationError("generate", "command_failed", true);
    const title = parseTitle(result.stdout);
    if (!title) throw new SessionTitleGenerationError("parse", "invalid_output", true);
    return title;
  } catch (error) {
    if (error instanceof SessionTitleGenerationError) throw error;
    throw new SessionTitleGenerationError("generate", "command_failed", true);
  }
}
