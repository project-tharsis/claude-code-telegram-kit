/**
 * Shared "isolated one-shot Claude CLI runner" building blocks.
 *
 * The session-title generator and the Memory Harness review generator each spawn an isolated,
 * one-shot `claude` CLI process under the exact same untrusted-code-execution isolation
 * contract: a fixed environment-variable allowlist, a hard wall-clock timeout that kills the
 * detached process group, and a bounded stdout/stderr reader that never buffers past a fixed byte cap. This is
 * the actual security boundary for that isolation surface, so it is defined in exactly one
 * place -- a hardening fix here (timeout handling, env allowlist, output bounding) can no
 * longer silently drift out of sync between the two call sites. Callers layer their own
 * domain-specific error types, argv construction, and prompt building on top.
 */

const ISOLATED_CLI_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"
] as const;

/** The fixed environment allowlist forwarded to an isolated one-shot CLI child process. */
export function isolatedCliEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ISOLATED_CLI_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Reads `stream` up to `maxBytes`, decoding as UTF-8 and never buffering past the cap. */
export async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = maxBytes + 1 - size;
      const chunk = part.value.slice(0, remaining);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (part.value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(concat(chunks)).slice(0, maxBytes);
}

export interface IsolatedCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunIsolatedCliOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
}

/** Thrown when the spawned isolated CLI process is killed for exceeding its timeout. */
export class IsolatedCliTimeoutError extends Error {
  constructor() {
    super("isolated CLI process timed out");
    this.name = "IsolatedCliTimeoutError";
  }
}

/**
 * Spawns `argv[0]` in a detached process group with an environment allowlist, bounded output,
 * and a hard timeout. Timeout sends SIGKILL to the whole group and awaits the direct child;
 * descendant reaping remains the operating system's init/subreaper responsibility.
 */
export async function runIsolatedCli(argv: string[], options: RunIsolatedCliOptions): Promise<IsolatedCliResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? "/tmp",
    env: isolatedCliEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const killProcessGroup = (): void => {
    try {
      if (child.pid > 1) process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill(9); } catch { /* already exited */ }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup();
  }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedStream(child.stdout, options.maxOutputBytes),
      readBoundedStream(child.stderr, options.maxOutputBytes)
    ]);
    if (timedOut) throw new IsolatedCliTimeoutError();
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
