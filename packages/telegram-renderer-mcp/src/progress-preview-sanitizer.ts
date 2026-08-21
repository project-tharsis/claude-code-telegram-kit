/**
 * Sanitizes an optional verbose progress preview before it reaches Telegram.
 *
 * This module is intentionally standalone: it accepts text only, never inspects or
 * forwards a tool payload, and has no transport or runtime dependencies.
 */

export const DEFAULT_PROGRESS_PREVIEW_MAX_LENGTH = 160;

export interface ProgressPreviewOptions {
  maxLength?: number;
  truncation?: "end" | "middle";
  stripLeadingCdWrapper?: boolean;
}

const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s<>"'`]+/giu;
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token|cookie|credential)[A-Za-z0-9_]*`;
const SECRET_PREFIX_PATTERN = new RegExp(
  String.raw`(?<![?&])(?:\b(authorization\s*:\s*bearer|bearer)\s+|\b(${SECRET_NAME})\s*[:=]\s*|(--?${SECRET_NAME})(?:=|\s+)|\b(authorization|cookie|set-cookie)\s*:\s*)`,
  "giu"
);
const KEY_SHAPE_PATTERN = /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{16,}\b/gu;
const EXTENDED_KEY_SHAPE_PATTERN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu;
const TELEGRAM_TOKEN_PATTERN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu;
const SENSITIVE_QUERY_KEY = /(?:token|key|secret|password|passwd|auth|authorization|cookie|credential)/iu;
const SIMPLE_CD_WRAPPER = /^\s*cd\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|]+)\s*&&\s*/u;

function redactSensitiveValues(value: string): string {
  SECRET_PREFIX_PATTERN.lastIndex = 0;
  const match = SECRET_PREFIX_PATTERN.exec(value);
  if (match === null) return value;
  const key = match[2] ?? match[3] ?? match[4];
  const marker = match[1] !== undefined ? "[REDACTED]" : `${key}=[REDACTED]`;
  return value.slice(0, match.index) + marker;
}

function sanitizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "REDACTED";
      parsed.password = "";
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "REDACTED");
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function assertMaxLength(maxLength: number): void {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive safe integer");
  }
}

/**
 * Return a bounded, single-line, privacy-safe preview.
 *
 * Non-string values are deliberately treated as absent rather than stringified:
 * stringifying objects is an easy way to leak tool arguments or command output.
 */
export function sanitizeProgressPreview(
  value: unknown,
  options: ProgressPreviewOptions = {}
): string {
  const maxLength = options.maxLength ?? DEFAULT_PROGRESS_PREVIEW_MAX_LENGTH;
  assertMaxLength(maxLength);
  if (typeof value !== "string") return "";

  let sanitized = value
    .normalize("NFKC")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u034f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  if (options.stripLeadingCdWrapper) sanitized = sanitized.replace(SIMPLE_CD_WRAPPER, "");

  // Wrapper content is dropped completely; the retained command is redacted before
  // truncation. Replacement strings contain no input text.
  sanitized = sanitized
    .replace(URL_PATTERN, sanitizeUrl)
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED]");
  sanitized = redactSensitiveValues(sanitized)
    .replace(KEY_SHAPE_PATTERN, "[REDACTED]")
    .replace(EXTENDED_KEY_SHAPE_PATTERN, "[REDACTED]")
    .replace(TELEGRAM_TOKEN_PATTERN, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();

  const codePoints = Array.from(sanitized);
  if (codePoints.length <= maxLength) return sanitized;
  if (options.truncation === "middle") {
    if (maxLength === 1) return "…";
    const available = maxLength - 1;
    const head = Math.ceil(available / 2);
    const tail = available - head;
    return `${codePoints.slice(0, head).join("")}…${tail > 0 ? codePoints.slice(-tail).join("") : ""}`;
  }
  return `${codePoints.slice(0, maxLength - 1).join("")}…`;
}
