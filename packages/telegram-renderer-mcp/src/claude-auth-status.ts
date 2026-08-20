import { execFile } from "node:child_process";

export type ClaudeAuthAvailability = "available" | "unavailable" | "unknown";

export interface ClaudeAuthRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ClaudeAuthRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => Promise<ClaudeAuthRunResult>;

export interface ClaudeAuthProbeOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  run?: ClaudeAuthRunner;
}

const MAX_STATUS_BYTES = 16_384;
const ALTERNATE_AUTH_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY"
] as const;

function hasAlternateCredential(env: NodeJS.ProcessEnv): boolean {
  return ALTERNATE_AUTH_ENV.some(name => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function parseClaudeAuthStatus(output: string): ClaudeAuthAvailability {
  if (Buffer.byteLength(output, "utf8") === 0 || Buffer.byteLength(output, "utf8") > MAX_STATUS_BYTES) {
    return "unknown";
  }
  return /(?:^|\n)Login:\s+Expired(?:\s|—|$)/u.test(output) ? "unavailable" : "unknown";
}

function defaultRunner(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ClaudeAuthRunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      env,
      maxBuffer: MAX_STATUS_BYTES,
      timeout: 3_000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : error.code;
      if (typeof exitCode !== "number") {
        reject(error ?? new Error("auth status failed"));
        return;
      }
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

/**
 * One read-only, per-inbound auth preflight. Claude owns all credential issuance and refresh;
 * this probe only prevents an already-unavailable login from becoming a silent Channel turn.
 */
export function createClaudeAuthProbe(options: ClaudeAuthProbeOptions = {}) {
  const env = options.env ?? process.env;
  const command = options.command ?? env.CLAUDE_CODE_CLI ?? "claude";
  const run = options.run ?? defaultRunner;

  return async (): Promise<ClaudeAuthAvailability> => {
    if (env.CLAUDE_CODE_AUTH_PREFLIGHT !== "interactive-login") return "unknown";
    // `claude auth status` only reports the persisted interactive login. Explicit provider
    // credentials may be perfectly valid even when that login is absent, so never block them.
    if (hasAlternateCredential(env)) return "unknown";
    try {
      const result = await run(command, ["auth", "status", "--text"], env);
      if (result.exitCode !== 0 && result.exitCode !== 1) return "unknown";
      return parseClaudeAuthStatus(result.stdout);
    } catch {
      return "unknown";
    }
  };
}
