/**
 * Single source of truth for the credential-shaped substring patterns used across the Memory
 * Harness: the bounded snapshot builder redacts them before a reviewer ever sees transcript-
 * derived text, and the strict proposal validator rejects a reviewer output that still
 * contains one. Both call sites previously carried independently hand-copied pattern arrays
 * that had already drifted from each other; this module is the only place they are defined.
 *
 * Each pattern's key/value variant (`password: ...`, `api_key=...`, etc.) also matches the
 * quoted-JSON shape a serialized object produces (`{"password": "value"}`), not just bare
 * prose, by tolerating an optional quote character around the key/value boundary.
 */

interface CredentialPatternSource {
  source: string;
  flags: string;
}

const CREDENTIAL_PATTERN_SOURCES: CredentialPatternSource[] = [
  { source: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----", flags: "" },
  // The bearer-token pattern must run before the generic credential-keyword pattern below: the
  // generic pattern's value match stops at the first whitespace, so on
  // "Authorization: Bearer <token>" it would otherwise consume only the literal word "Bearer"
  // (replacing it with the marker) and leave the actual token untouched -- and, worse, now
  // unmatchable by this pattern since the literal word "bearer" it requires is already gone.
  { source: "\\bbearer\\s+[A-Za-z0-9._~+/=-]{8,}", flags: "i" },
  {
    source: "(?:password|passwd|token|secret|api[_ -]?key|authorization|credential)[\"']?\\s*[:=]\\s*[\"']?[^\\s,;\"']+",
    flags: "i"
  },
  { source: "\\b(?:sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\\b", flags: "" },
  { source: "\\b[A-Fa-f0-9]{32,}\\b", flags: "" },
  { source: "\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b", flags: "" },
  { source: "\\bxox[baprs]-[A-Za-z0-9-]{16,}\\b", flags: "" },
  { source: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b", flags: "" },
  { source: "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b", flags: "" },
  { source: "https?://[^:\\s/@]+:[^@\\s/]+@", flags: "i" }
];

/** Replaces every credential-shaped substring in `value` with `marker`. */
export function redactCredentials(value: string, marker = "[redacted]"): string {
  let result = value;
  for (const pattern of CREDENTIAL_PATTERN_SOURCES) {
    result = result.replace(new RegExp(pattern.source, `${pattern.flags}g`), marker);
  }
  return result;
}

/** True if `value` contains any credential-shaped substring. */
export function containsCredentialShape(value: string): boolean {
  return CREDENTIAL_PATTERN_SOURCES.some(pattern => new RegExp(pattern.source, pattern.flags).test(value));
}
