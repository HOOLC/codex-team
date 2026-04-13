import type {
  RuntimeAccountSnapshot,
  RuntimeQuotaSnapshot,
} from "./types.js";
import {
  isRecord,
  normalizeBodySnippet,
} from "./shared.js";

function epochSecondsToIsoString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function normalizeManagedQuotaWindow(
  value: unknown,
  fallbackWindowSeconds: number,
): RuntimeQuotaSnapshot["five_hour"] {
  if (!isRecord(value) || typeof value.usedPercent !== "number") {
    return null;
  }

  const windowDurationMins =
    typeof value.windowDurationMins === "number" && Number.isFinite(value.windowDurationMins)
      ? value.windowDurationMins
      : null;

  return {
    used_percent: value.usedPercent,
    window_seconds: windowDurationMins === null ? fallbackWindowSeconds : windowDurationMins * 60,
    reset_at: epochSecondsToIsoString(value.resetsAt),
  };
}

export function normalizeRuntimeQuotaSnapshot(value: unknown): RuntimeQuotaSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const rateLimits = isRecord(value.rateLimits) ? value.rateLimits : null;
  if (!rateLimits) {
    return null;
  }

  const credits = isRecord(rateLimits.credits) ? rateLimits.credits : null;
  const balanceValue = credits?.balance;
  const creditsBalance =
    typeof balanceValue === "string" && balanceValue.trim() !== ""
      ? Number(balanceValue)
      : typeof balanceValue === "number"
        ? balanceValue
        : null;

  return {
    plan_type: typeof rateLimits.planType === "string" ? rateLimits.planType : null,
    credits_balance: Number.isFinite(creditsBalance) ? creditsBalance : null,
    unlimited: credits?.unlimited === true,
    five_hour: normalizeManagedQuotaWindow(rateLimits.primary ?? rateLimits.primaryWindow, 18_000),
    one_week: normalizeManagedQuotaWindow(
      rateLimits.secondary ?? rateLimits.secondaryWindow,
      604_800,
    ),
    fetched_at: new Date().toISOString(),
  };
}

export function normalizeRuntimeAccountSnapshot(value: unknown): RuntimeAccountSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const account = isRecord(value.account) ? value.account : null;
  const accountType = account?.type;
  const authMode =
    accountType === "apiKey"
      ? "apikey"
      : accountType === "chatgpt"
        ? "chatgpt"
        : null;

  return {
    auth_mode: authMode,
    email: typeof account?.email === "string" ? account.email : null,
    plan_type: typeof account?.planType === "string" ? account.planType : null,
    requires_openai_auth:
      typeof value.requiresOpenaiAuth === "boolean" ? value.requiresOpenaiAuth : null,
  };
}

export function extractRuntimeConsoleText(payload: Record<string, unknown>): string | null {
  const args = Array.isArray(payload.args) ? payload.args : [];
  const parts = args
    .map((arg) => {
      if (!isRecord(arg)) {
        return null;
      }

      if (typeof arg.value === "string") {
        return arg.value;
      }
      if (typeof arg.unserializableValue === "string") {
        return arg.unserializableValue;
      }
      if (typeof arg.description === "string") {
        return arg.description;
      }

      return null;
    })
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");

  if (parts.length === 0) {
    return null;
  }

  return parts.join(" ");
}

export function stringifySnippet(value: unknown): string | null {
  try {
    return normalizeBodySnippet(JSON.stringify(value));
  } catch {
    return null;
  }
}
