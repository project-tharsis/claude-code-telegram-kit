import { toMarkdownV2 } from "./markdown.js";

export const MAX_COMMENTARY_CODE_POINTS = 2_000;
export const MAX_COMMENTARY_MARKDOWN_V2 = 4_096;
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token|cookie|credential)[A-Za-z0-9_]*`;
const SECRET_PREFIX = new RegExp(String.raw`(?:\b(?:authorization\s*:\s*bearer|bearer)\s+|\b(${SECRET_NAME})\s*[:=]\s*|\b(cookie|set-cookie)\s*:\s*)[^\s,;]+`, "giu");
const KEY_SHAPES = /\b(?:sk|pk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{16,}\b|\b(?:github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|\d{6,}:[A-Za-z0-9_-]{20,})\b/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const SENSITIVE_QUERY = /(?:token|key|secret|password|passwd|auth|authorization|cookie|credential)/iu;

function safeUrl(raw: string): string {
  try {
    const url = new globalThis.URL(raw);
    if (url.username || url.password) { url.username = "REDACTED"; url.password = ""; }
    for (const key of Array.from(url.searchParams.keys())) if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, "REDACTED");
    return url.toString();
  } catch { return "[redacted-url]"; }
}

export function sanitizeCommentary(input: string): string {
  if (typeof input !== "string") return "";
  let text = input.normalize("NFKC")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .replace(/[\u034f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff]/gu, "");
  text = text.replace(PRIVATE_KEY, "[REDACTED]").replace(URL_PATTERN, safeUrl).replace(SECRET_PREFIX, "[REDACTED]").replace(KEY_SHAPES, "[REDACTED]").replace(JWT, "[REDACTED]");
  text = Array.from(text).slice(0, MAX_COMMENTARY_CODE_POINTS).join("").trim();
  if (!text) return "";
  try {
    if (toMarkdownV2(text).length > MAX_COMMENTARY_MARKDOWN_V2) {
      const bounded = Array.from(text).slice(0, 1_500).join("").trim();
      return toMarkdownV2(bounded).length <= MAX_COMMENTARY_MARKDOWN_V2 ? bounded : "";
    }
  } catch { return ""; }
  return text;
}
