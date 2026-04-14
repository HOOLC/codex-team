import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { maskAccountId } from "../auth-snapshot.js";
import type { AccountQuotaSummary } from "../account-store/index.js";
import { normalizeDisplayedScore } from "../plan-quota-profile.js";
import type { WatchHistoryEtaContext } from "../watch/history.js";
import { buildListSummary } from "./quota-summary.js";
import { rankListCandidates, selectCurrentNextResetWindow, toAutoSwitchCandidate } from "./quota-ranking.js";
import type {
  AutoSwitchCandidate,
  CurrentListStatusLike,
  QuotaEtaSummary,
} from "./quota-types.js";

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

  const renderRow = (row: Record<string, string>) => {
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
      return "-";
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
    `Score: ${formatRemainingPercent(normalizePlusScore(candidate.current_score))}`,
    `1H score: ${formatRemainingPercent(normalizePlusScore(candidate.score_1h))}`,
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
    `Score: ${formatRemainingPercent(normalizePlusScore(candidate.current_score))}`,
    `1H score: ${formatRemainingPercent(normalizePlusScore(candidate.score_1h))}`,
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
    { key: "score", label: "SCORE" },
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
      { key: "score_1h", label: "1H SCORE" },
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
