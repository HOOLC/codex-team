import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import type { AccountQuotaSummary } from "../account-store/index.js";
import type { RuntimeQuotaSnapshot } from "../desktop/launcher.js";
import type { CliQuotaSummary } from "./quota-types.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export function computeAvailability(account: AccountQuotaSummary): string | null {
  if (account.status !== "ok") {
    return null;
  }

  const usedPercents = [account.five_hour?.used_percent, account.one_week?.used_percent].filter(
    (value): value is number => typeof value === "number",
  );

  if (usedPercents.length === 0) {
    return null;
  }

  if (usedPercents.some((value) => value >= 100)) {
    return "unavailable";
  }

  return "available";
}

export function toCliQuotaSummary(account: AccountQuotaSummary): CliQuotaSummary {
  const { status, ...rest } = account;
  return {
    ...rest,
    available: computeAvailability(account),
    refresh_status: status,
  };
}

export function toCliQuotaRefreshResult(result: {
  successes: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
  warnings?: string[];
}) {
  return {
    successes: result.successes.map(toCliQuotaSummary),
    failures: result.failures,
    warnings: result.warnings ?? [],
  };
}

export function toCliQuotaSummaryFromRuntimeQuota(quota: RuntimeQuotaSnapshot): CliQuotaSummary {
  const normalizeWindow = (
    window: RuntimeQuotaSnapshot["five_hour"] | RuntimeQuotaSnapshot["one_week"],
  ): AccountQuotaSummary["five_hour"] =>
    window
      ? {
          used_percent: window.used_percent,
          window_seconds: window.window_seconds,
          ...(window.reset_at ? { reset_at: window.reset_at } : {}),
        }
      : null;

  const account: AccountQuotaSummary = {
    name: "__current__",
    account_id: "__current__",
    user_id: null,
    identity: "__current__",
    plan_type: quota.plan_type,
    credits_balance: quota.credits_balance,
    status: "ok",
    fetched_at: quota.fetched_at,
    error_message: null,
    unlimited: quota.unlimited,
    five_hour: normalizeWindow(quota.five_hour),
    one_week: normalizeWindow(quota.one_week),
  };

  return toCliQuotaSummary(account);
}

export function describeCurrentUsageSummary(
  quota: CliQuotaSummary | null,
  unavailableReason: string | null,
  sourceLabel?: string,
): string {
  if (quota === null) {
    return unavailableReason ? `Usage: ${unavailableReason}` : "Usage: unavailable";
  }

  if (quota.refresh_status !== "ok") {
    if (quota.refresh_status === "unsupported") {
      return "Usage: unsupported";
    }

    return `Usage: ${quota.refresh_status}${quota.error_message ? ` | ${quota.error_message}` : ""}`;
  }

  return [
    `Usage: ${quota.available ?? "unknown"}`,
    `5H ${quota.five_hour?.used_percent ?? "-"}% used`,
    `1W ${quota.one_week?.used_percent ?? "-"}% used`,
    sourceLabel ??
      `fetched ${
        quota.fetched_at
          ? dayjs.utc(quota.fetched_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm")
          : "unknown"
      }`,
  ].join(" | ");
}

export function isTerminalWatchQuota(quota: CliQuotaSummary | null): boolean {
  return quota?.refresh_status === "ok" && quota.available === "unavailable";
}
