const MAX_DATE_SECONDS = 8_640_000_000_000;

export const RUNTIME_FAILURE_TYPES = [
  "rate_limit", "overloaded", "authentication_failed", "oauth_org_not_allowed", "billing_error",
  "invalid_request", "model_not_found", "server_error", "max_output_tokens", "unknown"
] as const;

export type RuntimeFailureType = (typeof RUNTIME_FAILURE_TYPES)[number];
export type QuotaWindow = "five_hour" | "seven_day";
export interface RuntimeFailure {
  error: RuntimeFailureType;
  resetsAt?: number;
  quotaWindow?: QuotaWindow;
}

function normalizeQuotaWindow(value: string): QuotaWindow | undefined {
  if (value === "five_hour") return "five_hour";
  if (value === "seven_day" || value.startsWith("seven_day_") || value.startsWith("weekly")) return "seven_day";
  return undefined;
}

export function formatRateLimitNotice(
  resetsAt?: number,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  now = Date.now()
): string {
  const resetMs = resetsAt === undefined ? 0 : resetsAt * 1_000;
  let reset: string | null = null;
  let zone = timeZone;
  if (resetMs > now && resetMs <= now + 7 * 24 * 60 * 60_000) {
    try {
      reset = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(new Date(resetMs));
    } catch {
      zone = "UTC";
      reset = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(new Date(resetMs));
    }
  }
  const retry = reset === null ? "Retry after the limit resets." : `Retry after ${reset} (${zone}).`;
  return `Claude Code hit a usage or rate limit.\n\nCurrent work is paused. ${retry}\nMessages sent before recovery will not replay automatically.`;
}

const RUNTIME_FAILURE_SET = new Set<string>(RUNTIME_FAILURE_TYPES);
const QUOTA_LIMIT_KEYS = new Set([
  "remainingPercentage", "resetsAt", "rateLimitType", "isUsingOverage", "overageStatus",
  "surpassedThreshold", "isPerModel", "isShowingWeeklyRefresh", "isShowingFiveHourRefresh",
  "status", "unifiedRateLimitFallbackAvailable", "overageDisabledReason", "upgradePaths"
]);

export function parseRuntimeFailureRow(value: unknown): RuntimeFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.type !== "assistant" || row.isApiErrorMessage !== true || typeof row.error !== "string") return null;
  if (!RUNTIME_FAILURE_SET.has(row.error)) return null;
  const message = row.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const envelope = message as Record<string, unknown>;
  if (envelope.role !== "assistant" || !Array.isArray(envelope.content)) return null;
  const quota = row.quotaLimits;
  let resetsAt: number | undefined;
  let quotaWindow: QuotaWindow | undefined;
  if (quota !== undefined) {
    if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
    const limits = quota as Record<string, unknown>;
    if (Object.keys(limits).some(key => !QUOTA_LIMIT_KEYS.has(key))) return null;
    const reset = limits.resetsAt;
    if (typeof reset !== "number" || !Number.isSafeInteger(reset)
      || reset <= 0 || reset > MAX_DATE_SECONDS) return null;
    resetsAt = reset;
    const rateLimitType = limits.rateLimitType;
    if (rateLimitType !== undefined) {
      if (typeof rateLimitType !== "string" || rateLimitType.length > 64) return null;
      quotaWindow = normalizeQuotaWindow(rateLimitType);
    }
  }
  return {
    error: row.error as RuntimeFailureType,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(quotaWindow === undefined ? {} : { quotaWindow })
  };
}
