import { maskAccountId } from "../auth-snapshot.js";
import type { AccountQuotaSummary } from "../account-store/index.js";
import type { WatchHistoryEtaContext } from "../watch/history.js";
import {
  colorizeBlockedRow,
  colorizeRecovery,
  colorizeScore,
  compactIdentity,
  formatEtaSummary,
  formatRawScore,
  formatRemainingPercent,
  formatResetAt,
  formatUsagePercent,
  isAccountFullyUnavailable,
  normalizePlusScore,
  stripAnsi,
  toQuotaEtaSummary,
  visibleWidth,
} from "./quota-display.js";
import { buildListSummary } from "./quota-summary.js";
import { rankListCandidates, selectCurrentNextResetWindow, toAutoSwitchCandidate } from "./quota-ranking.js";
import { PROXY_ACCOUNT_ID, PROXY_ACCOUNT_NAME } from "../proxy/constants.js";
import type {
  AutoSwitchCandidate,
  CurrentListStatusLike,
  QuotaEtaSummary,
} from "./quota-types.js";

function padVisibleEnd(value: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(value));
  return `${value}${" ".repeat(padding)}`;
}

function padVisibleStart(value: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(value));
  return `${" ".repeat(padding)}${value}`;
}

function padVisibleCenter(value: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(value));
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
}

interface TableColumn {
  key: string;
  label: string;
  groupLabel?: string;
  align?: "left" | "right" | "center";
  headerAlign?: "left" | "right" | "center";
}

function padAligned(
  value: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  if (align === "right") {
    return padVisibleStart(value, width);
  }

  if (align === "center") {
    return padVisibleCenter(value, width);
  }

  return padVisibleEnd(value, width);
}

function formatTable(
  rows: Array<Record<string, string>>,
  columns: TableColumn[],
): string {
  if (rows.length === 0) {
    return "";
  }

  const widths = columns.map(({ key, label }) =>
    Math.max(visibleWidth(label), ...rows.map((row) => visibleWidth(row[key]))),
  );

  const renderRow = (row: Record<string, string>, kind: "header" | "body") => {
    const rendered = columns
      .map(({ key, align, headerAlign }, index) =>
        padAligned(
          row[key],
          widths[index] ?? 0,
          kind === "header" ? (headerAlign ?? align ?? "left") : (align ?? "left"),
        ),
      )
      .join("  ")
      .trimEnd();

    return row.__row_style === "red-bg" ? colorizeBlockedRow(rendered) : rendered;
  };

  const header = renderRow(
    Object.fromEntries(columns.map(({ key, label }) => [key, label])),
    "header",
  );
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const groupHeader = renderGroupedHeader(columns, widths);

  return [
    ...(groupHeader ? [groupHeader] : []),
    header,
    separator,
    ...rows.map((row) => renderRow(row, "body")),
  ].join("\n");
}

function renderGroupedHeader(
  columns: TableColumn[],
  widths: number[],
): string | null {
  const groups = new Map<string, { start: number; end: number }>();
  const starts: number[] = [];
  let cursor = 0;

  for (let index = 0; index < columns.length; index += 1) {
    starts.push(cursor);
    const groupLabel = columns[index]?.groupLabel;
    if (groupLabel) {
      const existing = groups.get(groupLabel);
      const start = starts[index] ?? 0;
      const end = start + (widths[index] ?? 0);
      if (existing) {
        existing.end = end;
      } else {
        groups.set(groupLabel, { start, end });
      }
    }
    cursor += (widths[index] ?? 0) + 2;
  }

  if (groups.size === 0) {
    return null;
  }

  const row = Array.from({ length: Math.max(0, cursor - 2) }, () => " ");
  for (const [label, span] of groups.entries()) {
    const spanWidth = span.end - span.start;
    const offset = span.start + Math.max(0, Math.floor((spanWidth - label.length) / 2));
    for (let index = 0; index < label.length; index += 1) {
      row[offset + index] = label[index] ?? " ";
    }
  }

  return row.join("").trimEnd();
}

function compactTableIdentity(value: string, width: number): string {
  return compactIdentity(value, width);
}

function describeCurrentListStatus(status: CurrentListStatusLike): string {
  if (!status.exists) {
    return "Current auth: missing";
  }

  if (status.account_id === PROXY_ACCOUNT_ID) {
    return "Current proxy account: proxy";
  }

  if (status.matched_accounts.length === 0) {
    return "Current auth: unmanaged";
  }

  if (status.matched_accounts.length === 1) {
    return `Current managed account: ${status.matched_accounts[0]}`;
  }

  return `Current managed account: multiple (${status.matched_accounts.join(", ")})`;
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
    `Score: ${formatRemainingPercent(normalizePlusScore(candidate.current_score, candidate.plan_type))}`,
    `1H score: ${formatRemainingPercent(normalizePlusScore(candidate.score_1h, candidate.plan_type))}`,
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
    `Score: ${formatRemainingPercent(normalizePlusScore(candidate.current_score, candidate.plan_type))}`,
    `1H score: ${formatRemainingPercent(normalizePlusScore(candidate.score_1h, candidate.plan_type))}`,
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
    usageLine?: string | null;
    daemonFeatureLine?: string | null;
    proxyLastUpstreamLine?: string | null;
    proxyLastUpstreamAccountName?: string | null;
    summaryAccounts?: AccountQuotaSummary[];
  } = {},
): string {
  if (accounts.length === 0) {
    const lines = [
      describeCurrentListStatus(currentStatus),
      ...(options.daemonFeatureLine ? [options.daemonFeatureLine] : []),
      ...(options.proxyLastUpstreamLine ? [options.proxyLastUpstreamLine] : []),
      ...(options.usageLine ? [options.usageLine] : []),
      "No saved accounts.",
    ];
    for (const warning of warnings) {
      lines.push(`Warning: ${warning}`);
    }

    return lines.join("\n");
  }

  const currentAccounts = new Set(currentStatus.matched_accounts);
  if (currentStatus.account_id === PROXY_ACCOUNT_ID) {
    currentAccounts.add(PROXY_ACCOUNT_NAME);
  }
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
    const currentScore = candidate ? normalizePlusScore(candidate.current_score, account.plan_type) : null;
    const nextResetAt = candidate
      ? formatResetAt(selectCurrentNextResetWindow(account, candidate))
      : "-";
    const displayName = account.status === "stale"
      ? `${account.name} [stale]`
      : account.name;
    const proxyMarker = options.proxyLastUpstreamAccountName === account.name ? "@" : " ";
    const row: Record<string, string> = {
      name: `${currentAccounts.has(account.name) ? "*" : " "}${proxyMarker} ${displayName}`,
      account_id: compactTableIdentity(maskAccountId(account.identity), "IDENTITY".length),
      plan_type: account.account_id === PROXY_ACCOUNT_ID ? "" : (account.plan_type ?? "-"),
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
      const score1h = candidate ? normalizePlusScore(candidate.score_1h, account.plan_type) : null;
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

    if (isAccountFullyUnavailable(account)) {
      row.__row_style = "red-bg";
    }

    return row;
  });

  const showEtaColumn = rows.some((row) => row.eta !== "-");
  const showVerboseEtaColumns = options.verbose
    ? rows.some((row) => row.eta_5h_eq_1w !== "-" || row.eta_1w !== "-")
    : false;

  const columns: TableColumn[] = [
    { key: "name", label: "   NAME" },
    { key: "account_id", label: "IDENTITY" },
    { key: "plan_type", label: "PLAN" },
    { key: "score", label: "SCORE", align: "right", headerAlign: "right" },
    { key: "five_hour", label: "5H", groupLabel: "USED", align: "right", headerAlign: "center" },
    { key: "one_week", label: "1W", groupLabel: "USED", align: "right", headerAlign: "center" },
    { key: "next_reset", label: "NEXT RESET" },
  ];

  if (showEtaColumn) {
    columns.splice(4, 0, {
      key: "eta",
      label: "ETA",
      align: "right",
      headerAlign: "right",
    });
  }

  if (options.verbose) {
    const verboseInsertColumns: TableColumn[] = [];
    if (showVerboseEtaColumns) {
      verboseInsertColumns.push(
        { key: "eta_5h_eq_1w", label: "ETA 5H->1W", align: "right", headerAlign: "right" },
        { key: "eta_1w", label: "ETA 1W", align: "right", headerAlign: "right" },
      );
    }
    verboseInsertColumns.push(
      { key: "rate_1w_units", label: "RATE 1W UNITS", align: "right", headerAlign: "right" },
      { key: "remaining_5h_eq_1w", label: "5H REMAIN->1W", align: "right", headerAlign: "right" },
      { key: "score_1h", label: "1H SCORE", align: "right", headerAlign: "right" },
      { key: "projected_5h_in_1w_units_1h", label: "5H->1W 1H", align: "right", headerAlign: "right" },
      { key: "projected_1w_1h", label: "1W 1H", align: "right", headerAlign: "right" },
      { key: "five_hour_to_one_week_ratio", label: "5H:1W", align: "right", headerAlign: "right" },
    );
    columns.splice(showEtaColumn ? 5 : 4, 0, ...verboseInsertColumns);
    columns.push(
      { key: "five_hour_reset", label: "5H RESET AT" },
      { key: "one_week_reset", label: "1W RESET AT" },
    );
  }

  const table = formatTable(rows, columns);
  const { summaryLine, poolLine } = buildListSummary(options.summaryAccounts ?? accounts);

  const lines = [
    describeCurrentListStatus(currentStatus),
    ...(options.daemonFeatureLine ? [options.daemonFeatureLine] : []),
    summaryLine,
    poolLine,
    ...(options.proxyLastUpstreamLine ? [options.proxyLastUpstreamLine] : []),
    ...(options.usageLine ? [options.usageLine] : []),
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
    usageLine?: string | null;
    daemonFeatureLine?: string | null;
    proxyLastUpstreamLine?: string | null;
    proxyLastUpstreamAccountName?: string | null;
    summaryAccounts?: AccountQuotaSummary[];
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
