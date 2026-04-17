import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import type { AccountQuotaSummary } from "../account-store/index.js";
import { normalizeDisplayedScore } from "../plan-quota-profile.js";
import type { WatchHistoryEtaContext } from "../watch/history.js";
import { computeAvailability } from "./quota-core.js";
import { rankListCandidates } from "./quota-ranking.js";
import type { QuotaEtaSummary } from "./quota-types.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RED = "\u001b[31m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_BRIGHT_YELLOW = "\u001b[93m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_BLACK = "\u001b[30m";
const ANSI_BG_RED = "\u001b[41m";

function styleText(
  value: string,
  ...codes: Array<
    | typeof ANSI_BOLD
    | typeof ANSI_RED
    | typeof ANSI_GREEN
    | typeof ANSI_BRIGHT_YELLOW
    | typeof ANSI_CYAN
    | typeof ANSI_BLACK
    | typeof ANSI_BG_RED
  >
): string {
  return `${codes.join("")}${value}${ANSI_RESET}`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

export function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

export function colorizeBlockedRow(value: string): string {
  return styleText(value, ANSI_BLACK, ANSI_BG_RED);
}

export function colorizeScore(value: string, remainingPercent: number | null): string {
  if (remainingPercent === null) {
    return value;
  }

  if (remainingPercent === 0) {
    return styleText(value, ANSI_BOLD, ANSI_RED);
  }

  if (remainingPercent < 20) {
    return styleText(value, ANSI_BOLD, ANSI_BRIGHT_YELLOW);
  }

  if (remainingPercent >= 100) {
    return styleText(value, ANSI_BOLD, ANSI_GREEN);
  }

  if (remainingPercent >= 80) {
    return styleText(value, ANSI_GREEN);
  }

  return value;
}

export function colorizeUsagePercent(value: string, usedPercent: number | null): string {
  if (usedPercent === null) {
    return value;
  }

  if (usedPercent >= 100) {
    return styleText(value, ANSI_BOLD, ANSI_RED);
  }

  if (usedPercent >= 80) {
    return styleText(value, ANSI_BOLD, ANSI_BRIGHT_YELLOW);
  }

  return value;
}

export function colorizeRecovery(value: string, bold = false): string {
  return bold ? styleText(value, ANSI_BOLD, ANSI_CYAN) : styleText(value, ANSI_CYAN);
}

export function colorizeRefreshStatus(value: string, status: AccountQuotaSummary["status"]): string {
  if (status === "error") {
    return styleText(value, ANSI_BOLD, ANSI_RED);
  }

  if (status === "stale") {
    return styleText(value, ANSI_BOLD, ANSI_BRIGHT_YELLOW);
  }

  return value;
}

export function colorizeReason(value: string, status: AccountQuotaSummary["status"]): string {
  return colorizeRefreshStatus(value, status);
}

export function compactIdentity(value: string, width: number): string {
  if (visibleWidth(value) <= width) {
    return value;
  }

  if (width <= 4) {
    return value.slice(0, width);
  }

  const marker = "..";
  const suffixWidth = Math.min(3, Math.max(1, Math.floor((width - marker.length) / 2)));
  const prefixWidth = Math.max(1, width - marker.length - suffixWidth);
  return `${value.slice(0, prefixWidth)}${marker}${value.slice(-suffixWidth)}`;
}

export function formatResetCountdown(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  const resetAfterSeconds = window?.reset_after_seconds;
  if (typeof resetAfterSeconds !== "number" || resetAfterSeconds < 0 || resetAfterSeconds > 3_600) {
    return "";
  }

  const remainingMinutes = Math.max(1, Math.ceil(resetAfterSeconds / 60));
  const suffix = ` (${remainingMinutes}m)`;
  return colorizeRecovery(suffix, resetAfterSeconds <= 900);
}

export function formatResetAt(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window?.reset_at) {
    return "-";
  }

  const absolute = dayjs.utc(window.reset_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm");
  return `${absolute}${formatResetCountdown(window)}`;
}

export function formatUsagePercent(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window) {
    return "-";
  }

  const raw = `${window.used_percent}%`;
  return colorizeUsagePercent(raw, window.used_percent);
}

export function formatRemainingPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

export function formatRawScore(value: number | null): string {
  return value === null ? "-" : String(value);
}

export function normalizePlusScore(value: number | null): number | null {
  return normalizeDisplayedScore(value, "plus", { clamp: false });
}

export function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

export function toQuotaEtaSummary(eta: WatchHistoryEtaContext | undefined): QuotaEtaSummary | null {
  if (!eta) {
    return null;
  }

  const rate = eta.rate_1w_units_per_hour;
  const eta5hEq1wHours =
    eta.status === "ok" && rate !== null && rate > 0 && eta.remaining_5h_eq_1w !== null
      ? roundToTwo(eta.remaining_5h_eq_1w / rate)
      : null;
  const eta1wHours =
    eta.status === "ok" && rate !== null && rate > 0 && eta.remaining_1w !== null
      ? roundToTwo(eta.remaining_1w / rate)
      : null;

  return {
    status: eta.status,
    hours: eta.etaHours,
    bottleneck: eta.bottleneck,
    eta_5h_eq_1w_hours: eta5hEq1wHours,
    eta_1w_hours: eta1wHours,
    rate_1w_units_per_hour: eta.rate_1w_units_per_hour,
    remaining_5h_eq_1w: eta.remaining_5h_eq_1w,
    remaining_1w: eta.remaining_1w,
  };
}

function formatEtaHours(hours: number | null): string {
  if (hours === null) {
    return "-";
  }
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  }
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  return `${(hours / 24).toFixed(1)}d`;
}

export function formatEtaSummary(eta: QuotaEtaSummary | null): string {
  if (!eta) {
    return "-";
  }

  switch (eta.status) {
    case "ok":
      return formatEtaHours(eta.hours);
    case "idle":
      return "idle";
    case "unavailable":
      return "-";
    case "insufficient_history":
    default:
      return "-";
  }
}

export function formatEtaLabel(eta: WatchHistoryEtaContext | undefined): string {
  return formatEtaSummary(toQuotaEtaSummary(eta));
}

export function deriveAvailability(account: AccountQuotaSummary): string {
  const computed = computeAvailability(account);
  if (computed) {
    return computed;
  }

  const usedPercents = [account.five_hour?.used_percent, account.one_week?.used_percent].filter(
    (value): value is number => typeof value === "number",
  );

  if (usedPercents.length === 0) {
    return account.status === "error" ? "error" : "unknown";
  }

  if (usedPercents.some((value) => value >= 100)) {
    return "unavailable";
  }

  return "available";
}

export function formatBottleneck(eta: WatchHistoryEtaContext | undefined): string {
  if (!eta?.bottleneck) {
    return "-";
  }

  return eta.bottleneck === "five_hour" ? "5H" : "1W";
}

export function buildReasonLabel(account: AccountQuotaSummary, eta: WatchHistoryEtaContext | undefined): string {
  if (account.status === "error") {
    return account.error_message ?? "quota refresh failed";
  }

  if (account.status === "stale") {
    return account.error_message
      ? `cached quota after ${account.error_message}`
      : "using cached quota";
  }

  const exhaustedWindows = [
    typeof account.five_hour?.used_percent === "number" && account.five_hour.used_percent >= 100 ? "5H" : null,
    typeof account.one_week?.used_percent === "number" && account.one_week.used_percent >= 100 ? "1W" : null,
  ].filter((value): value is string => value !== null);

  if (exhaustedWindows.length > 0) {
    return `exhausted ${exhaustedWindows.join(" + ")}`;
  }

  if (eta?.status === "idle") {
    return "idle watch history";
  }

  if (eta?.status === "ok" && eta.bottleneck) {
    return `${formatBottleneck(eta)} is the bottleneck`;
  }

  return "available";
}

export function orderListAccounts(accounts: AccountQuotaSummary[]): AccountQuotaSummary[] {
  const rankedCandidates = rankListCandidates(accounts);
  const originalOrder = new Map(accounts.map((account, index) => [account.name, index] as const));
  const rankedOrder = new Map(rankedCandidates.map((candidate, index) => [candidate.name, index] as const));

  return [...accounts].sort((left, right) => {
    const leftRank = rankedOrder.get(left.name);
    const rightRank = rankedOrder.get(right.name);

    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }
    if (leftRank !== undefined) {
      return -1;
    }
    if (rightRank !== undefined) {
      return 1;
    }

    return (originalOrder.get(left.name) ?? 0) - (originalOrder.get(right.name) ?? 0);
  });
}

export function isWindowUnavailable(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): boolean {
  return typeof window?.used_percent === "number" && window.used_percent >= 100;
}
