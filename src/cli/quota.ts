import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { maskAccountId } from "../auth-snapshot.js";
import type { AccountQuotaSummary } from "../account-store/index.js";
import type { RuntimeQuotaSnapshot } from "../desktop/launcher.js";
import {
  convertFiveHourPercentToPlusWeeklyUnits,
  convertOneWeekPercentToPlusWeeklyUnits,
  normalizeDisplayedScore,
  resolveFiveHourToOneWeekRawRatio,
} from "../plan-quota-profile.js";
import type { WatchHistoryEtaContext } from "../watch/history.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface CurrentListStatusLike {
  exists: boolean;
  matched_accounts: string[];
}

export interface CliQuotaSummary extends Omit<AccountQuotaSummary, "status"> {
  available: string | null;
  refresh_status: AccountQuotaSummary["status"];
}

export interface AutoSwitchCandidate {
  name: string;
  account_id: string;
  identity: string;
  plan_type: string | null;
  available: string | null;
  refresh_status: "ok";
  current_score: number;
  score_1h: number;
  projected_5h_1h: number | null;
  projected_5h_in_1w_units_1h: number | null;
  projected_1w_1h: number | null;
  projected_1w_in_plus_units_1h: number | null;
  remain_5h: number | null;
  remain_5h_in_1w_units: number | null;
  remain_1w: number | null;
  remain_1w_in_plus_units: number | null;
  five_hour_to_one_week_ratio: number;
  five_hour_used: number | null;
  one_week_used: number | null;
  five_hour_reset_at: string | null;
  one_week_reset_at: string | null;
}

export interface QuotaEtaSummary {
  status: WatchHistoryEtaContext["status"];
  hours: number | null;
  bottleneck: WatchHistoryEtaContext["bottleneck"];
  eta_5h_eq_1w_hours: number | null;
  eta_1w_hours: number | null;
  rate_1w_units_per_hour: number | null;
  remaining_5h_eq_1w: number | null;
  remaining_1w: number | null;
}

type QuotaWindowKey = "five_hour" | "one_week";

const AUTO_SWITCH_PROJECTION_HORIZON_SECONDS = 3_600;
const AUTO_SWITCH_CURRENT_SCORE_TIEBREAK_DELTA = 5;
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RED = "\u001b[31m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_BRIGHT_YELLOW = "\u001b[93m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_BLACK = "\u001b[30m";
const ANSI_BG_RED = "\u001b[41m";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

function padVisibleEnd(value: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(value));
  return `${value}${" ".repeat(padding)}`;
}

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

function colorizeRow(value: string, background: typeof ANSI_BG_RED): string {
  return styleText(value, ANSI_BLACK, background);
}

function colorize(
  value: string,
  color: typeof ANSI_RED | typeof ANSI_GREEN | typeof ANSI_BRIGHT_YELLOW,
): string {
  return styleText(value, color);
}

function colorizeWarning(
  value: string,
  color: typeof ANSI_RED | typeof ANSI_GREEN | typeof ANSI_BRIGHT_YELLOW,
): string {
  return styleText(value, ANSI_BOLD, color);
}

function colorizeRecovery(value: string, bold = false): string {
  return bold ? styleText(value, ANSI_BOLD, ANSI_CYAN) : styleText(value, ANSI_CYAN);
}

function colorizeScore(value: string, remainingPercent: number | null): string {
  if (remainingPercent === null) {
    return value;
  }

  if (remainingPercent === 0) {
    return colorizeWarning(value, ANSI_RED);
  }

  if (remainingPercent < 20) {
    return colorizeWarning(value, ANSI_BRIGHT_YELLOW);
  }

  if (remainingPercent >= 100) {
    return colorizeWarning(value, ANSI_GREEN);
  }

  if (remainingPercent >= 80) {
    return colorize(value, ANSI_GREEN);
  }

  return value;
}

function colorizeUsagePercent(value: string, usedPercent: number | null): string {
  if (usedPercent === null) {
    return value;
  }

  if (usedPercent >= 100) {
    return colorizeWarning(value, ANSI_RED);
  }

  if (usedPercent >= 80) {
    return colorizeWarning(value, ANSI_BRIGHT_YELLOW);
  }

  return value;
}

function formatTable(
  rows: Array<Record<string, string>>,
  columns: Array<{ key: string; label: string }>,
): string {
  if (rows.length === 0) {
    return "";
  }

  const widths = columns.map(({ key, label }) =>
    Math.max(visibleWidth(label), ...rows.map((row) => visibleWidth(row[key]))),
  );

  const renderRow = (row: Record<string, string>) =>
    {
      const rendered = columns
      .map(({ key }, index) => padVisibleEnd(row[key], widths[index]))
      .join("  ")
      .trimEnd();

      return row.__row_style === "red-bg" ? colorizeRow(rendered, ANSI_BG_RED) : rendered;
    };

  const header = renderRow(
    Object.fromEntries(columns.map(({ key, label }) => [key, label])),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("  ");

  return [header, separator, ...rows.map(renderRow)].join("\n");
}

function describeCurrentListStatus(status: CurrentListStatusLike): string {
  if (!status.exists) {
    return "Current auth: missing";
  }

  if (status.matched_accounts.length === 0) {
    return "Current auth: unmanaged";
  }

  if (status.matched_accounts.length === 1) {
    return `Current managed account: ${status.matched_accounts[0]}`;
  }

  return `Current managed account: multiple (${status.matched_accounts.join(", ")})`;
}

function formatUsagePercent(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window) {
    return "-";
  }

  const raw = `${window.used_percent}%`;
  return colorizeUsagePercent(raw, window.used_percent);
}

function formatResetCountdown(
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

function formatResetAt(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window?.reset_at) {
    return "-";
  }

  const absolute = dayjs.utc(window.reset_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm");
  return `${absolute}${formatResetCountdown(window)}`;
}

function isWindowUnavailable(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): boolean {
  return typeof window?.used_percent === "number" && window.used_percent >= 100;
}

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

function computeRemainingPercent(usedPercent: number | undefined): number | null {
  if (typeof usedPercent !== "number") {
    return null;
  }

  return Math.max(0, 100 - usedPercent);
}

function roundScore(value: number): number {
  return Number(value.toFixed(2));
}

function computeProjectedRemainingPercent(
  fetchedAt: string | null,
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): number | null {
  if (!window || typeof window.used_percent !== "number") {
    return null;
  }

  const remaining = computeRemainingPercent(window.used_percent);
  if (remaining === null) {
    return null;
  }

  if (!fetchedAt || !window.reset_at) {
    return remaining;
  }

  const fetchedAtMs = Date.parse(fetchedAt);
  const resetAtMs = Date.parse(window.reset_at);
  if (Number.isNaN(fetchedAtMs) || Number.isNaN(resetAtMs)) {
    return remaining;
  }

  const horizonSeconds = AUTO_SWITCH_PROJECTION_HORIZON_SECONDS;
  const timeUntilResetSeconds = Math.max(0, (resetAtMs - fetchedAtMs) / 1000);
  if (timeUntilResetSeconds >= horizonSeconds) {
    return remaining;
  }

  const beforeResetSeconds = Math.min(horizonSeconds, timeUntilResetSeconds);
  const afterResetSeconds = horizonSeconds - beforeResetSeconds;
  return roundScore((remaining * beforeResetSeconds + 100 * afterResetSeconds) / horizonSeconds);
}

function compareNullableNumberDescending(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return right - left;
}

function resolveBottleneckScore(left: number | null, right: number | null): number | null {
  if (left !== null && right !== null) {
    return Math.min(left, right);
  }

  return left ?? right;
}

function toAutoSwitchCandidate(account: AccountQuotaSummary): AutoSwitchCandidate | null {
  if (account.status !== "ok") {
    return null;
  }

  const fiveHourToOneWeekRatio = resolveFiveHourToOneWeekRawRatio(account.plan_type);
  const remain5h = computeRemainingPercent(account.five_hour?.used_percent);
  const remain1w = computeRemainingPercent(account.one_week?.used_percent);
  if (remain5h === null && remain1w === null) {
    return null;
  }

  const remain5hEq1w = convertFiveHourPercentToPlusWeeklyUnits(remain5h, account.plan_type);
  const remain1wEq = convertOneWeekPercentToPlusWeeklyUnits(remain1w, account.plan_type);
  const projected5hScore = computeProjectedRemainingPercent(account.fetched_at, account.five_hour);
  const projected5hEq1wScore = convertFiveHourPercentToPlusWeeklyUnits(
    projected5hScore,
    account.plan_type,
  );
  const projected1wScore = computeProjectedRemainingPercent(account.fetched_at, account.one_week);
  const projected1wEqScore = convertOneWeekPercentToPlusWeeklyUnits(
    projected1wScore,
    account.plan_type,
  );
  const currentScore = resolveBottleneckScore(remain5hEq1w, remain1wEq);
  const effectiveScore = resolveBottleneckScore(projected5hEq1wScore, projected1wEqScore);

  if (currentScore === null || effectiveScore === null) {
    return null;
  }

  return {
    name: account.name,
    account_id: account.account_id,
    identity: account.identity,
    plan_type: account.plan_type,
    available: computeAvailability(account),
    refresh_status: "ok",
    current_score: currentScore,
    score_1h: effectiveScore,
    projected_5h_1h: projected5hScore,
    projected_5h_in_1w_units_1h: projected5hEq1wScore,
    projected_1w_1h: projected1wScore,
    projected_1w_in_plus_units_1h: projected1wEqScore,
    remain_5h: remain5h,
    remain_5h_in_1w_units: remain5hEq1w,
    remain_1w: remain1w,
    remain_1w_in_plus_units: remain1wEq,
    five_hour_to_one_week_ratio: fiveHourToOneWeekRatio,
    five_hour_used: account.five_hour?.used_percent ?? null,
    one_week_used: account.one_week?.used_percent ?? null,
    five_hour_reset_at: account.five_hour?.reset_at ?? null,
    one_week_reset_at: account.one_week?.reset_at ?? null,
  };
}

function compareNullableDateAscending(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left.localeCompare(right);
}

function resolveBottleneckWindows(
  fiveHourScore: number | null,
  oneWeekScore: number | null,
): QuotaWindowKey[] {
  if (fiveHourScore !== null && oneWeekScore !== null) {
    if (fiveHourScore < oneWeekScore) {
      return ["five_hour"];
    }
    if (oneWeekScore < fiveHourScore) {
      return ["one_week"];
    }
    return ["five_hour", "one_week"];
  }

  if (fiveHourScore !== null) {
    return ["five_hour"];
  }

  if (oneWeekScore !== null) {
    return ["one_week"];
  }

  return [];
}

function getCandidateResetAt(candidate: AutoSwitchCandidate, window: QuotaWindowKey): string | null {
  return window === "five_hour" ? candidate.five_hour_reset_at : candidate.one_week_reset_at;
}

function getEarliestResetAt(
  candidate: AutoSwitchCandidate,
  windows: QuotaWindowKey[],
): string | null {
  return windows
    .map((window) => getCandidateResetAt(candidate, window))
    .filter((resetAt): resetAt is string => resetAt !== null)
    .sort((left, right) => left.localeCompare(right))[0] ?? null;
}

function getLatestResetAt(
  candidate: AutoSwitchCandidate,
  windows: QuotaWindowKey[],
): string | null {
  return windows
    .map((window) => getCandidateResetAt(candidate, window))
    .filter((resetAt): resetAt is string => resetAt !== null)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;
}

function resolveExhaustedWindows(candidate: AutoSwitchCandidate): QuotaWindowKey[] {
  const windows: QuotaWindowKey[] = [];

  if (candidate.remain_5h === 0) {
    windows.push("five_hour");
  }

  if (candidate.remain_1w === 0) {
    windows.push("one_week");
  }

  return windows;
}

function getRecoveryResetAt(candidate: AutoSwitchCandidate): string | null {
  return getLatestResetAt(candidate, resolveExhaustedWindows(candidate));
}

function getCurrentNextResetAt(candidate: AutoSwitchCandidate): string | null {
  const recoveryResetAt = getRecoveryResetAt(candidate);
  if (recoveryResetAt !== null) {
    return recoveryResetAt;
  }

  return getEarliestResetAt(
    candidate,
    resolveBottleneckWindows(candidate.remain_5h_in_1w_units, candidate.remain_1w_in_plus_units),
  );
}

function selectCurrentNextResetWindow(
  account: AccountQuotaSummary,
  candidate: AutoSwitchCandidate,
): AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"] {
  const nextResetAt = getCurrentNextResetAt(candidate);
  if (!nextResetAt) {
    return null;
  }

  const candidateWindows = [account.five_hour, account.one_week].filter(
    (window): window is NonNullable<AccountQuotaSummary["five_hour"]> =>
      window !== null && window.reset_at === nextResetAt,
  );

  return candidateWindows[0] ?? null;
}

function compareCandidateResets(
  left: AutoSwitchCandidate,
  right: AutoSwitchCandidate,
  options: {
    fiveHourScore: (candidate: AutoSwitchCandidate) => number | null;
    oneWeekScore: (candidate: AutoSwitchCandidate) => number | null;
  },
): number {
  const leftRecoveryResetAt = getRecoveryResetAt(left);
  const rightRecoveryResetAt = getRecoveryResetAt(right);
  const recoveryResetOrder = compareNullableDateAscending(leftRecoveryResetAt, rightRecoveryResetAt);
  if (leftRecoveryResetAt !== null || rightRecoveryResetAt !== null) {
    if (recoveryResetOrder !== 0) {
      return recoveryResetOrder;
    }
  }

  const leftBottleneckWindows = resolveBottleneckWindows(
    options.fiveHourScore(left),
    options.oneWeekScore(left),
  );
  const rightBottleneckWindows = resolveBottleneckWindows(
    options.fiveHourScore(right),
    options.oneWeekScore(right),
  );

  const primaryResetOrder = compareNullableDateAscending(
    getEarliestResetAt(left, leftBottleneckWindows),
    getEarliestResetAt(right, rightBottleneckWindows),
  );
  if (primaryResetOrder !== 0) {
    return primaryResetOrder;
  }

  const leftSecondaryWindows = (["five_hour", "one_week"] as QuotaWindowKey[]).filter(
    (window) => !leftBottleneckWindows.includes(window),
  );
  const rightSecondaryWindows = (["five_hour", "one_week"] as QuotaWindowKey[]).filter(
    (window) => !rightBottleneckWindows.includes(window),
  );

  return compareNullableDateAscending(
    getEarliestResetAt(left, leftSecondaryWindows),
    getEarliestResetAt(right, rightSecondaryWindows),
  );
}

export function rankAutoSwitchCandidates(accounts: AccountQuotaSummary[]): AutoSwitchCandidate[] {
  return accounts
    .map(toAutoSwitchCandidate)
    .filter((candidate): candidate is AutoSwitchCandidate => candidate !== null)
    .sort((left, right) => {
      const currentScoreGap = Math.abs(right.current_score - left.current_score);
      if (currentScoreGap > AUTO_SWITCH_CURRENT_SCORE_TIEBREAK_DELTA) {
        return right.current_score - left.current_score;
      }
      if (right.score_1h !== left.score_1h) {
        return right.score_1h - left.score_1h;
      }
      if (right.current_score !== left.current_score) {
        return right.current_score - left.current_score;
      }
      const projected5hOrder = compareNullableNumberDescending(
        left.projected_5h_in_1w_units_1h,
        right.projected_5h_in_1w_units_1h,
      );
      if (projected5hOrder !== 0) {
        return projected5hOrder;
      }
      const projected1wOrder = compareNullableNumberDescending(
        left.projected_1w_in_plus_units_1h,
        right.projected_1w_in_plus_units_1h,
      );
      if (projected1wOrder !== 0) {
        return projected1wOrder;
      }
      const remain5hOrder = compareNullableNumberDescending(
        left.remain_5h_in_1w_units,
        right.remain_5h_in_1w_units,
      );
      if (remain5hOrder !== 0) {
        return remain5hOrder;
      }
      const remain1wOrder = compareNullableNumberDescending(
        left.remain_1w_in_plus_units,
        right.remain_1w_in_plus_units,
      );
      if (remain1wOrder !== 0) {
        return remain1wOrder;
      }

      const resetOrder = compareCandidateResets(left, right, {
        fiveHourScore: (candidate) => candidate.projected_5h_in_1w_units_1h,
        oneWeekScore: (candidate) => candidate.projected_1w_in_plus_units_1h,
      });
      if (resetOrder !== 0) {
        return resetOrder;
      }

      return left.name.localeCompare(right.name);
    });
}

function rankListCandidates(accounts: AccountQuotaSummary[]): AutoSwitchCandidate[] {
  return accounts
    .map(toAutoSwitchCandidate)
    .filter((candidate): candidate is AutoSwitchCandidate => candidate !== null)
    .sort((left, right) => {
      if (right.current_score !== left.current_score) {
        return right.current_score - left.current_score;
      }

      if (left.current_score === 0 && right.current_score === 0) {
        const resetOrder = compareCandidateResets(left, right, {
          fiveHourScore: (candidate) => candidate.remain_5h_in_1w_units,
          oneWeekScore: (candidate) => candidate.remain_1w_in_plus_units,
        });
        if (resetOrder !== 0) {
          return resetOrder;
        }

        if (right.score_1h !== left.score_1h) {
          return right.score_1h - left.score_1h;
        }
      }

      const remain5hOrder = compareNullableNumberDescending(
        left.remain_5h_in_1w_units,
        right.remain_5h_in_1w_units,
      );
      if (remain5hOrder !== 0) {
        return remain5hOrder;
      }

      const remain1wOrder = compareNullableNumberDescending(
        left.remain_1w_in_plus_units,
        right.remain_1w_in_plus_units,
      );
      if (remain1wOrder !== 0) {
        return remain1wOrder;
      }

      const resetOrder = compareCandidateResets(left, right, {
        fiveHourScore: (candidate) => candidate.remain_5h_in_1w_units,
        oneWeekScore: (candidate) => candidate.remain_1w_in_plus_units,
      });
      if (resetOrder !== 0) {
        return resetOrder;
      }

      return left.name.localeCompare(right.name);
    });
}

function formatRemainingPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

function formatRawScore(value: number | null): string {
  return value === null ? "-" : String(value);
}

function normalizePlusScore(value: number | null): number | null {
  return normalizeDisplayedScore(value, "plus", { clamp: false });
}

function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

function toQuotaEtaSummary(eta: WatchHistoryEtaContext | undefined): QuotaEtaSummary | null {
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

function formatEtaSummary(eta: QuotaEtaSummary | null): string {
  if (!eta) {
    return "-";
  }

  switch (eta.status) {
    case "ok":
      return formatEtaHours(eta.hours);
    case "idle":
      return "idle";
    case "unavailable":
      return "unavailable";
    case "insufficient_history":
    default:
      return "-";
  }
}

export function describeAutoSwitchSelection(
  candidate: AutoSwitchCandidate,
  dryRun: boolean,
  backupPath: string | null,
  warnings: string[],
): string {
  const lines = [
    dryRun
      ? `Best account: "${candidate.name}" (${maskAccountId(candidate.identity)}).`
      : `Auto-switched to "${candidate.name}" (${maskAccountId(candidate.identity)}).`,
    `Plus score: ${formatRemainingPercent(normalizePlusScore(candidate.current_score))}`,
    `1H plus score: ${formatRemainingPercent(normalizePlusScore(candidate.score_1h))}`,
    `5H remaining: ${formatRemainingPercent(candidate.remain_5h)}`,
    `5H remaining (1W units): ${formatRawScore(candidate.remain_5h_in_1w_units)}`,
    `1W remaining: ${formatRemainingPercent(candidate.remain_1w)}`,
    `5H 1H projected score: ${formatRemainingPercent(candidate.projected_5h_1h)}`,
    `5H 1H projected score (1W units): ${formatRawScore(candidate.projected_5h_in_1w_units_1h)}`,
    `1W 1H projected score: ${formatRemainingPercent(candidate.projected_1w_1h)}`,
  ];

  if (backupPath) {
    lines.push(`Backup: ${backupPath}`);
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

export function describeAutoSwitchNoop(candidate: AutoSwitchCandidate, warnings: string[]): string {
  const lines = [
    `Current account "${candidate.name}" (${maskAccountId(candidate.identity)}) is already the best available account.`,
    `Plus score: ${formatRemainingPercent(normalizePlusScore(candidate.current_score))}`,
    `1H plus score: ${formatRemainingPercent(normalizePlusScore(candidate.score_1h))}`,
    `5H remaining: ${formatRemainingPercent(candidate.remain_5h)}`,
    `5H remaining (1W units): ${formatRawScore(candidate.remain_5h_in_1w_units)}`,
    `1W remaining: ${formatRemainingPercent(candidate.remain_1w)}`,
    `5H 1H projected score: ${formatRemainingPercent(candidate.projected_5h_1h)}`,
    `5H 1H projected score (1W units): ${formatRawScore(candidate.projected_5h_in_1w_units_1h)}`,
    `1W 1H projected score: ${formatRemainingPercent(candidate.projected_1w_1h)}`,
  ];

  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

function formatPoolValue(value: number | null): string {
  return value === null ? "-" : String(roundToTwo(value));
}

function buildListSummary(accounts: AccountQuotaSummary[]): {
  summaryLine: string;
  poolLine: string;
} {
  const planCounts = new Map<string, number>();
  let usableCount = 0;
  let oneWeekBlockedCount = 0;
  let fiveHourBlockedCount = 0;
  let poolFiveHour = 0;
  let poolOneWeek = 0;
  let hasPoolFiveHour = false;
  let hasPoolOneWeek = false;

  for (const account of accounts) {
    const plan = account.plan_type ?? "unknown";
    planCounts.set(plan, (planCounts.get(plan) ?? 0) + 1);

    const availability = computeAvailability(account);
    if (availability === "available") {
      usableCount += 1;
    }

    const oneWeekBlocked = isWindowUnavailable(account.one_week);
    const fiveHourBlocked = isWindowUnavailable(account.five_hour);
    if (oneWeekBlocked) {
      oneWeekBlockedCount += 1;
    } else if (fiveHourBlocked) {
      fiveHourBlockedCount += 1;
    }

    const candidate = toAutoSwitchCandidate(account);
    if (!candidate) {
      continue;
    }

    if (candidate.remain_5h_in_1w_units !== null) {
      poolFiveHour += candidate.remain_5h_in_1w_units;
      hasPoolFiveHour = true;
    }
    if (candidate.remain_1w_in_plus_units !== null) {
      poolOneWeek += candidate.remain_1w_in_plus_units;
      hasPoolOneWeek = true;
    }
  }

  const plansSegment = [...planCounts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([plan, count]) => `${plan} x${count}`)
    .join(", ");

  const summaryLine = `Accounts: ${usableCount}/${accounts.length} usable | ${oneWeekBlockedCount} blocked by 1W | ${fiveHourBlockedCount} blocked by 5H${
    plansSegment ? ` | ${plansSegment}` : ""
  }`;

  const fiveHourPool = hasPoolFiveHour ? roundToTwo(poolFiveHour) : null;
  const oneWeekPool = hasPoolOneWeek ? roundToTwo(poolOneWeek) : null;
  const bottleneckPool =
    fiveHourPool !== null && oneWeekPool !== null
      ? roundToTwo(Math.min(fiveHourPool, oneWeekPool))
      : fiveHourPool ?? oneWeekPool;

  const poolLine =
    `Total: bottleneck ${formatPoolValue(bottleneckPool)} | ` +
    `5H->1W ${formatPoolValue(fiveHourPool)} | ` +
    `1W ${formatPoolValue(oneWeekPool)} (plus 1W units)`;

  return {
    summaryLine,
    poolLine,
  };
}

function describeQuotaAccounts(
  accounts: AccountQuotaSummary[],
  currentStatus: CurrentListStatusLike,
  warnings: string[],
  options: {
    verbose?: boolean;
    etaByName?: Map<string, WatchHistoryEtaContext>;
  } = {},
): string {
  if (accounts.length === 0) {
    const lines = [describeCurrentListStatus(currentStatus), "No saved accounts."];
    for (const warning of warnings) {
      lines.push(`Warning: ${warning}`);
    }

    return lines.join("\n");
  }

  const currentAccounts = new Set(currentStatus.matched_accounts);
  const rankedCandidates = rankListCandidates(accounts);
  const autoSwitchCandidates = new Map(
    accounts
      .map(toAutoSwitchCandidate)
      .filter((candidate): candidate is AutoSwitchCandidate => candidate !== null)
      .map((candidate) => [candidate.name, candidate] as const),
  );
  const originalOrder = new Map(accounts.map((account, index) => [account.name, index] as const));
  const rankedOrder = new Map(
    rankedCandidates.map((candidate, index) => [candidate.name, index] as const),
  );
  const orderedAccounts = [...accounts].sort((left, right) => {
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

  const rows = orderedAccounts.map((account) => {
    const candidate = autoSwitchCandidates.get(account.name);
    const eta = toQuotaEtaSummary(options.etaByName?.get(account.name));
    const currentScore = candidate ? normalizePlusScore(candidate.current_score) : null;
    const nextResetAt = candidate
      ? formatResetAt(selectCurrentNextResetWindow(account, candidate))
      : "-";
    const row: Record<string, string> = {
      name: `${currentAccounts.has(account.name) ? "*" : " "} ${account.name}`,
      account_id: maskAccountId(account.identity),
      plan_type: account.plan_type ?? "-",
      eta: formatEtaSummary(eta),
      score: colorizeScore(formatRemainingPercent(currentScore), currentScore),
      five_hour: formatUsagePercent(account.five_hour),
      next_reset: nextResetAt,
      five_hour_reset: formatResetAt(account.five_hour),
      one_week: formatUsagePercent(account.one_week),
      one_week_reset: formatResetAt(account.one_week),
    };

    if (options.verbose) {
      row.eta_5h_eq_1w = eta ? formatEtaSummary({ ...eta, hours: eta.eta_5h_eq_1w_hours }) : "-";
      row.eta_1w = eta ? formatEtaSummary({ ...eta, hours: eta.eta_1w_hours }) : "-";
      row.rate_1w_units =
        eta && eta.rate_1w_units_per_hour !== null ? String(eta.rate_1w_units_per_hour) : "-";
      row.remaining_5h_eq_1w =
        eta && eta.remaining_5h_eq_1w !== null ? String(eta.remaining_5h_eq_1w) : "-";
      row.projected_5h_in_1w_units_1h = candidate
        ? formatRawScore(candidate.projected_5h_in_1w_units_1h)
        : "-";
      const score1h = candidate ? normalizePlusScore(candidate.score_1h) : null;
      row.score_1h = candidate
        ? colorizeScore(formatRemainingPercent(score1h), score1h)
        : "-";
      row.projected_1w_1h = candidate
        ? colorizeScore(
            formatRemainingPercent(candidate.projected_1w_1h),
            candidate.projected_1w_1h,
          )
        : "-";
      row.five_hour_to_one_week_ratio = candidate
        ? String(candidate.five_hour_to_one_week_ratio)
        : "-";
    }

    if (isWindowUnavailable(account.one_week)) {
      for (const key of Object.keys(row)) {
        row[key] = stripAnsi(row[key]);
      }
      row.__row_style = "red-bg";
    }

    return row;
  });

  const columns = [
    { key: "name", label: "  NAME" },
    { key: "account_id", label: "IDENTITY" },
    { key: "plan_type", label: "PLAN" },
    { key: "score", label: "PLUS SCORE" },
    { key: "eta", label: "ETA" },
    { key: "five_hour", label: "5H USED" },
    { key: "one_week", label: "1W USED" },
    { key: "next_reset", label: "NEXT RESET" },
  ];

  if (options.verbose) {
    columns.splice(
      5,
      0,
      { key: "eta_5h_eq_1w", label: "ETA 5H->1W" },
      { key: "eta_1w", label: "ETA 1W" },
      { key: "rate_1w_units", label: "RATE 1W UNITS" },
      { key: "remaining_5h_eq_1w", label: "5H REMAIN->1W" },
      { key: "score_1h", label: "1H PLUS SCORE" },
      { key: "projected_5h_in_1w_units_1h", label: "5H->1W 1H" },
      { key: "projected_1w_1h", label: "1W 1H" },
      { key: "five_hour_to_one_week_ratio", label: "5H:1W" },
    );
    columns.push(
      { key: "five_hour_reset", label: "5H RESET AT" },
      { key: "one_week_reset", label: "1W RESET AT" },
    );
  }

  const table = formatTable(rows, columns);
  const { summaryLine, poolLine } = buildListSummary(accounts);

  const lines = [
    describeCurrentListStatus(currentStatus),
    summaryLine,
    poolLine,
    "Refreshed quotas:",
    table,
  ];
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

export function describeQuotaRefresh(
  result: {
    successes: AccountQuotaSummary[];
    failures: Array<{ name: string; error: string }>;
    warnings?: string[];
  },
  currentStatus: CurrentListStatusLike,
  options: {
    verbose?: boolean;
    etaByName?: Map<string, WatchHistoryEtaContext>;
  } = {},
): string {
  const lines: string[] = [];

  if (result.successes.length > 0) {
    lines.push(describeQuotaAccounts(result.successes, currentStatus, [], options));
  } else {
    lines.push(describeQuotaAccounts([], currentStatus, [], options));
  }

  for (const failure of result.failures) {
    lines.push(`Failure: ${failure.name}: ${failure.error}`);
  }

  for (const warning of result.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }

  if (lines.length === 0) {
    lines.push(describeQuotaAccounts([], currentStatus, [], options));
  }

  return lines.join("\n");
}
