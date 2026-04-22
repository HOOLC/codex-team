const MAX_SIGNAL_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const QUOTA_EXHAUSTION_ERROR_CODES = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "rate_limit_exceeded",
  "usageLimitExceeded",
  "usage_limit_reached",
  "usage_limit_exceeded",
]);

export const QUOTA_EXHAUSTION_MESSAGE_PHRASES = [
  "insufficient quota",
  "quota exceeded",
  "usage limit has been reached",
  "usage limit exceeded",
  "hit your usage limit",
  "rate limit exceeded",
];

export function hasQuotaExhaustionSignal(value: unknown, depth = 0): boolean {
  if (depth > MAX_SIGNAL_DEPTH) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasQuotaExhaustionSignal(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.codex_error_info === "usage_limit_exceeded" || value.codexErrorInfo === "usageLimitExceeded") {
    return true;
  }

  const exactCandidates = [
    value.code,
    value.errorCode,
    value.error_code,
    value.type,
  ];
  if (exactCandidates.some((entry) => typeof entry === "string" && QUOTA_EXHAUSTION_ERROR_CODES.has(entry))) {
    return true;
  }

  const messageCandidates = [
    value.message,
    value.error_message,
    value.detail,
  ];
  if (
    messageCandidates.some((entry) =>
      typeof entry === "string"
      && QUOTA_EXHAUSTION_MESSAGE_PHRASES.some((phrase) => entry.toLowerCase().includes(phrase))
    )
  ) {
    return true;
  }

  return Object.values(value).some((entry) => hasQuotaExhaustionSignal(entry, depth + 1));
}

export function hasExhaustedRateLimitSignal(value: unknown, depth = 0): boolean {
  if (depth > MAX_SIGNAL_DEPTH) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasExhaustedRateLimitSignal(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return false;
  }

  const usedPercent = value.usedPercent ?? value.used_percent;
  if (typeof usedPercent === "number" && usedPercent >= 100) {
    return true;
  }

  return Object.values(value).some((entry) => hasExhaustedRateLimitSignal(entry, depth + 1));
}
