export interface RenameCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface RenameCommandOptions {
  run?: (argv: string[], options: { timeoutMs: number; cwd: string; env: Record<string, string> }) => Promise<RenameCommandResult>;
  claudePath?: string;
  workspaceDir: string;
  timeoutMs?: number;
}

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_OUTPUT_BYTES = 32 * 1024;
const GENERIC_ERROR = "Session rename failed";

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= MAX_OUTPUT_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = MAX_OUTPUT_BYTES + 1 - size;
      chunks.push(part.value.slice(0, remaining));
      size += Math.min(part.value.byteLength, remaining);
      if (part.value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged).slice(0, MAX_OUTPUT_BYTES);
}

async function defaultRunner(
  argv: string[],
  options: { timeoutMs: number; cwd: string; env: Record<string, string> }
): Promise<RenameCommandResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe"
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout),
      readBounded(child.stderr)
    ]);
    if (timedOut) throw new Error(GENERIC_ERROR);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function renameSessionWithClaude(
  sessionId: string,
  title: string,
  options: RenameCommandOptions
): Promise<void> {
  if (!SESSION_UUID.test(sessionId) || !title || /[\r\n\u0000-\u001f\u007f]/u.test(title)) {
    throw new Error(GENERIC_ERROR);
  }
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 30_000));
  const argv = [
    options.claudePath ?? "claude",
    "-p",
    `/rename ${title}`,
    "--resume",
    sessionId,
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--settings",
    "{}",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk"
  ];
  const env: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "CLAUDE_CONFIG_DIR"
  ]) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  // Fixed /rename is a local command. A fake token ensures accidental model fallback fails closed.
  env.CLAUDE_CODE_OAUTH_TOKEN = "local-rename-command-only";
  try {
    const result = await (options.run ?? defaultRunner)(argv, {
      timeoutMs,
      cwd: options.workspaceDir,
      env
    });
    if (result.exitCode !== 0 || typeof result.stdout !== "string" ||
        Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES) throw new Error(GENERIC_ERROR);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    if (payload.is_error !== false || payload.num_turns !== 0 || payload.duration_api_ms !== 0 ||
        payload.result !== `Session renamed to: ${title}`) throw new Error(GENERIC_ERROR);
  } catch {
    throw new Error(GENERIC_ERROR);
  }
}
