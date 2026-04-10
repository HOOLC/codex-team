import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { maskAccountId } from "../auth-snapshot.js";
import type { AccountQuotaSummary } from "../account-store.js";
import type { RuntimeQuotaSnapshot } from "../codex-desktop-launch.js";

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
  remain_5h: number | null;
  remain_5h_in_1w_units: number | null;
  remain_1w: number | null;
  five_hour_windows_per_week: number;
  five_hour_used: number | null;
  one_week_used: number | null;
  five_hour_reset_at: string | null;
  one_week_reset_at: string | null;
}

const AUTO_SWITCH_SCORING = {
  defaultFiveHourWindowsPerWeek: 3,
  fiveHourWindowsPerWeekByPlan: {
    plus: 3,
    team: 8,
  },
} as const;

const AUTO_SWITCH_PROJECTION_HORIZON_SECONDS = 3_600;
const AUTO_SWITCH_CURRENT_SCORE_TIEBREAK_DELTA = 5;

function formatTable(
  rows: Array<Record<string, string>>,
  columns: Array<{ key: string; label: string }>,
): string {
  if (rows.length === 0) {
    return "";
  }

  const widths = columns.map(({ key, label }) =>
    Math.max(label.length, ...rows.map((row) => row[key].length)),
  );

  const renderRow = (row: Record<string, string>) =>
    columns
      .map(({ key }, index) => row[key].padEnd(widths[index]))
      .join("  ")
      .trimEnd();

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

  return `${window.used_percent}%`;
}

function formatResetAt(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window?.reset_at) {
    return "-";
  }

  return dayjs.utc(window.reset_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm");
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

  if (usedPercents.some((value) => 100 - value < 10)) {
    return "almost unavailable";
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
}) {
  return {
    successes: result.successes.map(toCliQuotaSummary),
    failures: result.failures,
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

function resolveFiveHourWindowsPerWeek(planType: string | null): number {
  if (!planType) {
    return AUTO_SWITCH_SCORING.defaultFiveHourWindowsPerWeek;
  }

  return (
    AUTO_SWITCH_SCORING.fiveHourWindowsPerWeekByPlan[
      planType as keyof typeof AUTO_SWITCH_SCORING.fiveHourWindowsPerWeekByPlan
    ] ?? AUTO_SWITCH_SCORING.defaultFiveHourWindowsPerWeek
  );
}

function convertFiveHourPercentToWeeklyEquivalent(
  fiveHourPercent: number | null,
  fiveHourWindowsPerWeek: number,
): number | null {
  if (fiveHourPercent === null) {
    return null;
  }

  return roundScore(fiveHourPercent / fiveHourWindowsPerWeek);
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

  const fiveHourWindowsPerWeek = resolveFiveHourWindowsPerWeek(account.plan_type);
  const remain5h = computeRemainingPercent(account.five_hour?.used_percent);
  const remain1w = computeRemainingPercent(account.one_week?.used_percent);
  if (remain5h === null && remain1w === null) {
    return null;
  }

  const remain5hEq1w = convertFiveHourPercentToWeeklyEquivalent(remain5h, fiveHourWindowsPerWeek);
  const projected5hScore = computeProjectedRemainingPercent(account.fetched_at, account.five_hour);
  const projected5hEq1wScore = convertFiveHourPercentToWeeklyEquivalent(
    projected5hScore,
    fiveHourWindowsPerWeek,
  );
  const projected1wScore = computeProjectedRemainingPercent(account.fetched_at, account.one_week);
  const currentScore = resolveBottleneckScore(remain5hEq1w, remain1w);
  const effectiveScore = resolveBottleneckScore(projected5hEq1wScore, projected1wScore);

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
    remain_5h: remain5h,
    remain_5h_in_1w_units: remain5hEq1w,
    remain_1w: remain1w,
    five_hour_windows_per_week: fiveHourWindowsPerWeek,
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
        left.projected_1w_1h,
        right.projected_1w_1h,
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
        left.remain_1w,
        right.remain_1w,
      );
      if (remain1wOrder !== 0) {
        return remain1wOrder;
      }

      const fiveHourResetOrder = compareNullableDateAscending(
        left.five_hour_reset_at,
        right.five_hour_reset_at,
      );
      if (fiveHourResetOrder !== 0) {
        return fiveHourResetOrder;
      }

      const oneWeekResetOrder = compareNullableDateAscending(
        left.one_week_reset_at,
        right.one_week_reset_at,
      );
      if (oneWeekResetOrder !== 0) {
        return oneWeekResetOrder;
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

function normalizeDisplayedScore(rawScore: number | null, fiveHourWindowsPerWeek: number): number | null {
  if (rawScore === null) {
    return null;
  }

  return roundScore(Math.min(100, rawScore * fiveHourWindowsPerWeek));
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
    `Current score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.current_score, candidate.five_hour_windows_per_week))}`,
    `1H score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.score_1h, candidate.five_hour_windows_per_week))}`,
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
    `Current score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.current_score, candidate.five_hour_windows_per_week))}`,
    `1H score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.score_1h, candidate.five_hour_windows_per_week))}`,
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

function describeQuotaAccounts(
  accounts: AccountQuotaSummary[],
  currentStatus: CurrentListStatusLike,
  warnings: string[],
  options: { verbose?: boolean } = {},
): string {
  if (accounts.length === 0) {
    const lines = [describeCurrentListStatus(currentStatus), "No saved accounts."];
    for (const warning of warnings) {
      lines.push(`Warning: ${warning}`);
    }

    return lines.join("\n");
  }

  const currentAccounts = new Set(currentStatus.matched_accounts);
  const autoSwitchCandidates = new Map(
    rankAutoSwitchCandidates(accounts).map((candidate) => [candidate.name, candidate] as const),
  );
  const rows = accounts.map((account) => {
    const candidate = autoSwitchCandidates.get(account.name);
    const row: Record<string, string> = {
      name: `${currentAccounts.has(account.name) ? "*" : " "} ${account.name}`,
      account_id: maskAccountId(account.identity),
      plan_type: account.plan_type ?? "-",
      available: computeAvailability(account) ?? "-",
      score: candidate
        ? formatRemainingPercent(
            normalizeDisplayedScore(candidate.current_score, candidate.five_hour_windows_per_week),
          )
        : "-",
      five_hour: formatUsagePercent(account.five_hour),
      five_hour_reset: formatResetAt(account.five_hour),
      one_week: formatUsagePercent(account.one_week),
      one_week_reset: formatResetAt(account.one_week),
      refresh_status: account.status,
    };

    if (options.verbose) {
      row.projected_5h_in_1w_units_1h = candidate
        ? formatRawScore(candidate.projected_5h_in_1w_units_1h)
        : "-";
      row.score_1h = candidate
        ? formatRemainingPercent(
            normalizeDisplayedScore(candidate.score_1h, candidate.five_hour_windows_per_week),
          )
        : "-";
      row.projected_1w_1h = candidate ? formatRemainingPercent(candidate.projected_1w_1h) : "-";
      row.five_hour_windows_per_week = candidate ? String(candidate.five_hour_windows_per_week) : "-";
    }

    return row;
  });

  const columns = [
    { key: "name", label: "  NAME" },
    { key: "account_id", label: "IDENTITY" },
    { key: "plan_type", label: "PLAN TYPE" },
    { key: "available", label: "AVAILABLE" },
    { key: "score", label: "CURRENT SCORE" },
    { key: "five_hour", label: "5H USED" },
    { key: "five_hour_reset", label: "5H RESET AT" },
    { key: "one_week", label: "1W USED" },
    { key: "one_week_reset", label: "1W RESET AT" },
    { key: "refresh_status", label: "REFRESH STATUS" },
  ];

  if (options.verbose) {
    columns.splice(
      5,
      0,
      { key: "score_1h", label: "1H SCORE" },
      { key: "projected_5h_in_1w_units_1h", label: "5H->1W 1H RAW" },
      { key: "projected_1w_1h", label: "1W 1H" },
      { key: "five_hour_windows_per_week", label: "1W:5H" },
    );
  }

  const table = formatTable(rows, columns);

  const lines = [describeCurrentListStatus(currentStatus), "Refreshed quotas:", table];
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

export function describeQuotaRefresh(
  result: {
    successes: AccountQuotaSummary[];
    failures: Array<{ name: string; error: string }>;
  },
  currentStatus: CurrentListStatusLike,
  options: { verbose?: boolean } = {},
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

  if (lines.length === 0) {
    lines.push(describeQuotaAccounts([], currentStatus, [], options));
  }

  return lines.join("\n");
}
