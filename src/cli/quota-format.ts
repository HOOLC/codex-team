import { formatAccountListDisplayName, formatAccountListMarkers } from "../account-list-display.js";
import { maskAccountId } from "../auth-snapshot.js";
import type { AccountQuotaSummary } from "../account-store/index.js";
import type { ProxyQuotaAggregate } from "../proxy/quota.js";
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
  normalizeAccountScore,
  normalizePlusScore,
  stripAnsi,
  toQuotaEtaSummary,
  visibleWidth,
} from "./quota-display.js";
import { buildListSummary } from "./quota-summary.js";
import { rankListCandidates, selectCurrentNextResetWindow, toDisplayAutoSwitchCandidate } from "./quota-ranking.js";
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
  widthsOverride?: number[],
): string {
  if (rows.length === 0) {
    return "";
  }

  const widths = widthsOverride
    ? widthsOverride
    : columns.map(({ key, label }) =>
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
  const groups = new Map<string, { firstCenter: number; lastCenter: number }>();
  let cursor = 0;

  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const groupLabel = column?.groupLabel;
    if (groupLabel) {
      const width = widths[index] ?? 0;
      const labelWidth = visibleWidth(column?.label ?? "");
      const align = column?.headerAlign ?? column?.align ?? "left";
      const labelStart = align === "right"
        ? cursor + Math.max(0, width - labelWidth)
        : align === "center"
          ? cursor + Math.max(0, Math.floor((width - labelWidth) / 2))
          : cursor;
      const labelCenter = labelStart + (labelWidth / 2);
      const existing = groups.get(groupLabel);
      if (existing) {
        existing.lastCenter = labelCenter;
      } else {
        groups.set(groupLabel, { firstCenter: labelCenter, lastCenter: labelCenter });
      }
    }
    cursor += (widths[index] ?? 0) + 2;
  }

  if (groups.size === 0) {
    return null;
  }

  const row = Array.from({ length: Math.max(0, cursor - 2) }, () => " ");
  for (const [label, span] of groups.entries()) {
    const labelWidth = visibleWidth(label);
    const offset = Math.max(0, Math.round(((span.firstCenter + span.lastCenter) / 2) - (labelWidth / 2)));
    for (let index = 0; index < label.length; index += 1) {
      row[offset + index] = label[index] ?? " ";
    }
  }

  return row.join("").trimEnd();
}

function compactTableIdentity(value: string, width: number): string {
  return compactIdentity(value, width);
}

function truncateVisible(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (visibleWidth(value) <= width) {
    return value;
  }

  const plain = stripAnsi(value);
  if (width <= 2) {
    return plain.slice(0, width);
  }

  return `${plain.slice(0, width - 2)}..`;
}

interface QuotaDisplayRow {
  rowStyle?: "red-bg";
  markers: string;
  displayName: string;
  accountId: string;
  planType: string;
  eta: string;
  score: string;
  fiveHour: string;
  nextReset: string;
  fiveHourReset: string;
  oneWeek: string;
  oneWeekReset: string;
  eta5hEq1w?: string;
  eta1w?: string;
  rate1wUnits?: string;
  remaining5hEq1w?: string;
  projected5hIn1wUnits1h?: string;
  score1h?: string;
  projected1w1h?: string;
  fiveHourToOneWeekRatio?: string;
}

interface BudgetedQuotaTableWidths {
  nameWidth: number;
  accountIdWidth: number;
  planWidth: number;
  scoreWidth: number;
  etaWidth: number;
  fiveHourWidth: number;
  fiveHourResetWidth: number;
  oneWeekWidth: number;
  oneWeekResetWidth: number;
  nextResetWidth: number;
  splitResetColumns: boolean;
}

function getQuotaTableSeparatorWidth(columnCount: number): number {
  return Math.max(0, columnCount - 1) * 2;
}

function resolveQuotaDisplayWidth(options: {
  header: string;
  values: string[];
  minWidth?: number;
}): { minWidth: number; desiredWidth: number } {
  const minWidth = Math.max(options.minWidth ?? 0, visibleWidth(options.header));
  const desiredWidth = Math.max(
    minWidth,
    ...options.values.map((value) => visibleWidth(value)),
  );

  return {
    minWidth,
    desiredWidth,
  };
}

function computeBudgetedQuotaTableWidths(
  rows: QuotaDisplayRow[],
  terminalWidth: number,
  showEtaColumn: boolean,
): BudgetedQuotaTableWidths | null {
  const nameWidths = resolveQuotaDisplayWidth({
    header: `${formatAccountListMarkers({})}NAME`,
    values: rows.map((row) => `${row.markers}${row.displayName}`),
    minWidth: 10,
  });
  const accountIdWidths = resolveQuotaDisplayWidth({
    header: "IDENTITY",
    values: rows.map(() => "IDENTITY"),
  });
  const planWidths = resolveQuotaDisplayWidth({
    header: "PLAN",
    values: rows.map((row) => row.planType),
  });
  const scoreWidths = resolveQuotaDisplayWidth({
    header: "SCORE",
    values: rows.map((row) => row.score),
    minWidth: 5,
  });
  const etaWidths = resolveQuotaDisplayWidth({
    header: "ETA",
    values: rows.map((row) => row.eta),
    minWidth: 3,
  });
  const fiveHourWidths = resolveQuotaDisplayWidth({
    header: "5H",
    values: rows.map((row) => row.fiveHour),
  });
  const oneWeekWidths = resolveQuotaDisplayWidth({
    header: "1W",
    values: rows.map((row) => row.oneWeek),
  });
  const fiveHourResetWidths = resolveQuotaDisplayWidth({
    header: "RESET",
    values: rows.map((row) => row.fiveHourReset),
  });
  const oneWeekResetWidths = resolveQuotaDisplayWidth({
    header: "RESET",
    values: rows.map((row) => row.oneWeekReset),
  });
  const nextResetWidths = resolveQuotaDisplayWidth({
    header: "NEXT RESET",
    values: rows.map((row) => row.nextReset),
  });

  const collapsedColumnCount = showEtaColumn ? 8 : 7;
  const collapsedFixedMinWidth =
    nameWidths.minWidth
    + accountIdWidths.minWidth
    + planWidths.minWidth
    + scoreWidths.minWidth
    + (showEtaColumn ? etaWidths.minWidth : 0)
    + fiveHourWidths.minWidth
    + oneWeekWidths.minWidth
    + nextResetWidths.minWidth
    + getQuotaTableSeparatorWidth(collapsedColumnCount);

  if (terminalWidth < collapsedFixedMinWidth) {
    return null;
  }

  const splitColumnCount = showEtaColumn ? 9 : 8;
  const splitFixedMinWidth =
    nameWidths.minWidth
    + accountIdWidths.minWidth
    + planWidths.minWidth
    + scoreWidths.minWidth
    + (showEtaColumn ? etaWidths.minWidth : 0)
    + fiveHourWidths.minWidth
    + fiveHourResetWidths.minWidth
    + oneWeekWidths.minWidth
    + oneWeekResetWidths.minWidth
    + getQuotaTableSeparatorWidth(splitColumnCount);
  const splitResetColumns = terminalWidth >= Math.max(splitFixedMinWidth, 80);

  let nameWidth = nameWidths.minWidth;
  let accountIdWidth = accountIdWidths.minWidth;
  let planWidth = planWidths.minWidth;
  let scoreWidth = scoreWidths.minWidth;
  let etaWidth = showEtaColumn ? etaWidths.minWidth : 0;
  let fiveHourWidth = fiveHourWidths.minWidth;
  let fiveHourResetWidth = splitResetColumns ? fiveHourResetWidths.minWidth : 0;
  let oneWeekWidth = oneWeekWidths.minWidth;
  let oneWeekResetWidth = splitResetColumns ? oneWeekResetWidths.minWidth : 0;
  let nextResetWidth = nextResetWidths.minWidth;
  let remainingWidth = terminalWidth - (splitResetColumns ? splitFixedMinWidth : collapsedFixedMinWidth);

  const consumeGrowth = (
    currentWidth: number,
    desiredWidth: number,
    minWidth: number,
  ): number => {
    const desiredGrowth = Math.max(0, desiredWidth - minWidth);
    const appliedGrowth = Math.min(remainingWidth, desiredGrowth);
    remainingWidth -= appliedGrowth;
    return currentWidth + appliedGrowth;
  };

  nameWidth = consumeGrowth(nameWidth, nameWidths.desiredWidth, nameWidths.minWidth);
  scoreWidth = consumeGrowth(scoreWidth, scoreWidths.desiredWidth, scoreWidths.minWidth);
  fiveHourWidth = consumeGrowth(fiveHourWidth, fiveHourWidths.desiredWidth, fiveHourWidths.minWidth);
  oneWeekWidth = consumeGrowth(oneWeekWidth, oneWeekWidths.desiredWidth, oneWeekWidths.minWidth);
  if (splitResetColumns) {
    fiveHourResetWidth = consumeGrowth(
      fiveHourResetWidth,
      fiveHourResetWidths.desiredWidth,
      fiveHourResetWidths.minWidth,
    );
    oneWeekResetWidth = consumeGrowth(
      oneWeekResetWidth,
      oneWeekResetWidths.desiredWidth,
      oneWeekResetWidths.minWidth,
    );
  } else {
    nextResetWidth = consumeGrowth(nextResetWidth, nextResetWidths.desiredWidth, nextResetWidths.minWidth);
  }
  if (showEtaColumn) {
    etaWidth = consumeGrowth(etaWidth, etaWidths.desiredWidth, etaWidths.minWidth);
  }
  planWidth = consumeGrowth(planWidth, planWidths.desiredWidth, planWidths.minWidth);

  return {
    nameWidth,
    accountIdWidth,
    planWidth,
    scoreWidth,
    etaWidth,
    fiveHourWidth,
    fiveHourResetWidth,
    oneWeekWidth,
    oneWeekResetWidth,
    nextResetWidth,
    splitResetColumns,
  };
}

function renderCompactQuotaRows(
  rows: QuotaDisplayRow[],
  terminalWidth: number,
  showEtaColumn: boolean,
): string {
  return rows.flatMap((row) => {
    const scoreWidth = visibleWidth(row.score);
    const etaBlockWidth = showEtaColumn ? 1 + visibleWidth(row.eta) : 0;
    const planWidth = row.planType !== "" ? 1 + visibleWidth(row.planType) : 0;
    const minimumNameWidth = 10;
    const reservedCoreWidth =
      visibleWidth(row.markers) + 1 + scoreWidth + etaBlockWidth + minimumNameWidth;
    const includePlan = row.planType !== ""
      && terminalWidth - reservedCoreWidth >= planWidth;
    const firstLineNameWidth = Math.max(
      8,
      terminalWidth
        - visibleWidth(row.markers)
        - 1
        - scoreWidth
        - etaBlockWidth
        - (includePlan ? planWidth : 0),
    );
    const firstLine = [
      row.markers,
      padVisibleEnd(truncateVisible(row.displayName, firstLineNameWidth), firstLineNameWidth),
      includePlan ? ` ${truncateVisible(row.planType, visibleWidth(row.planType))}` : "",
      " ",
      padVisibleStart(row.score, scoreWidth),
      showEtaColumn ? ` ${padVisibleStart(row.eta, visibleWidth(row.eta))}` : "",
    ].join("");

    const secondLineIndent = " ".repeat(visibleWidth(row.markers));
    const secondLineWidth = Math.max(0, terminalWidth - visibleWidth(secondLineIndent));
    const segments = [`5H ${row.fiveHour}`, `1W ${row.oneWeek}`];
    if (
      row.nextReset !== "-"
      && visibleWidth([...segments, row.nextReset].join(" | ")) <= secondLineWidth
    ) {
      segments.push(row.nextReset);
    }
    const identityWidth = Math.min(
      18,
      Math.max(0, secondLineWidth - visibleWidth(segments.join(" | ")) - 3),
    );
    if (row.accountId !== "-" && identityWidth >= 8) {
      segments.push(compactTableIdentity(row.accountId, identityWidth));
    }

    const secondLine = `${secondLineIndent}${truncateVisible(segments.join(" | "), secondLineWidth)}`;
    const lines = [firstLine, secondLine];
    return row.rowStyle === "red-bg" ? lines.map((line) => colorizeBlockedRow(line)) : lines;
  }).join("\n");
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
    terminalWidth?: number | null;
    etaByName?: Map<string, WatchHistoryEtaContext>;
    usageLine?: string | null;
    daemonFeatureLine?: string | null;
    proxyLastUpstreamLine?: string | null;
    proxyLastUpstreamAccountName?: string | null;
    proxyAggregate?: ProxyQuotaAggregate | null;
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
      .map((account) => toDisplayAutoSwitchCandidate(account, options.proxyAggregate))
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

  const displayRows = orderedAccounts.map((account) => {
    const candidate = autoSwitchCandidates.get(account.name);
    const eta = toQuotaEtaSummary(options.etaByName?.get(account.name));
    const currentScore = candidate ? normalizeAccountScore(candidate.current_score, account, options.proxyAggregate) : null;
    const nextResetAt = candidate
      ? formatResetAt(selectCurrentNextResetWindow(account, candidate))
      : "-";
    const displayName = formatAccountListDisplayName({
      name: account.name,
      refreshStatus: account.status,
      autoSwitchEligible: account.auto_switch_eligible,
    });
    const proxyUpstreamActive = options.proxyLastUpstreamAccountName === account.name;
    const row: QuotaDisplayRow = {
      markers: formatAccountListMarkers({
        current: currentAccounts.has(account.name),
        proxyUpstreamActive,
      }),
      displayName,
      accountId: maskAccountId(account.identity),
      planType: account.account_id === PROXY_ACCOUNT_ID ? "" : (account.plan_type ?? "-"),
      eta: formatEtaSummary(eta),
      score: colorizeScore(formatRemainingPercent(currentScore), currentScore),
      fiveHour: formatUsagePercent(account.five_hour),
      nextReset: nextResetAt,
      fiveHourReset: formatResetAt(account.five_hour),
      oneWeek: formatUsagePercent(account.one_week),
      oneWeekReset: formatResetAt(account.one_week),
    };

    if (options.verbose) {
      row.eta5hEq1w = eta ? formatEtaSummary({ ...eta, hours: eta.eta_5h_eq_1w_hours }) : "-";
      row.eta1w = eta ? formatEtaSummary({ ...eta, hours: eta.eta_1w_hours }) : "-";
      row.rate1wUnits =
        eta && eta.rate_1w_units_per_hour !== null ? String(eta.rate_1w_units_per_hour) : "-";
      row.remaining5hEq1w =
        eta && eta.remaining_5h_eq_1w !== null ? String(eta.remaining_5h_eq_1w) : "-";
      row.projected5hIn1wUnits1h = candidate
        ? formatRawScore(candidate.projected_5h_in_1w_units_1h)
        : "-";
      const score1h = candidate ? normalizeAccountScore(candidate.score_1h, account, options.proxyAggregate) : null;
      row.score1h = candidate
        ? colorizeScore(formatRemainingPercent(score1h), score1h)
        : "-";
      row.projected1w1h = candidate
        ? colorizeScore(
            formatRemainingPercent(candidate.projected_1w_1h),
            candidate.projected_1w_1h,
          )
        : "-";
      row.fiveHourToOneWeekRatio = candidate
        ? String(candidate.five_hour_to_one_week_ratio)
        : "-";
    }

    if (isAccountFullyUnavailable(account)) {
      row.rowStyle = "red-bg";
    }

    return row;
  });

  const showEtaColumn = displayRows.some((row) => row.eta !== "-");
  const showVerboseEtaColumns = options.verbose
    ? displayRows.some((row) => row.eta5hEq1w !== "-" || row.eta1w !== "-")
    : false;

  const budgetedTableWidths =
    options.terminalWidth && !options.verbose
      ? computeBudgetedQuotaTableWidths(displayRows, options.terminalWidth, showEtaColumn)
      : null;
  const splitResetColumns = budgetedTableWidths?.splitResetColumns === true;
  const columns: TableColumn[] = [
    { key: "name", label: "NAME", headerAlign: "center" },
    { key: "account_id", label: "IDENTITY", headerAlign: "center" },
    { key: "plan_type", label: "PLAN", headerAlign: "center" },
    { key: "score", label: "SCORE", align: "right", headerAlign: "center" },
    ...(splitResetColumns
      ? [
          {
            key: "five_hour",
            label: "USED",
            groupLabel: "5H",
            align: "right" as const,
            headerAlign: "center" as const,
          },
          { key: "five_hour_reset", label: "RESET", groupLabel: "5H", headerAlign: "center" as const },
          {
            key: "one_week",
            label: "USED",
            groupLabel: "1W",
            align: "right" as const,
            headerAlign: "center" as const,
          },
          { key: "one_week_reset", label: "RESET", groupLabel: "1W", headerAlign: "center" as const },
        ]
      : [
          { key: "five_hour", label: "5H", align: "right" as const, headerAlign: "center" as const },
          { key: "one_week", label: "1W", align: "right" as const, headerAlign: "center" as const },
          { key: "next_reset", label: "NEXT RESET", headerAlign: "center" as const },
        ]),
  ];

  const rows = displayRows.map((row) => ({
    name: budgetedTableWidths
      ? `${row.markers}${truncateVisible(row.displayName, Math.max(0, budgetedTableWidths.nameWidth - visibleWidth(row.markers)))}`
      : `${row.markers}${row.displayName}`,
    account_id: budgetedTableWidths
      ? compactTableIdentity(row.accountId, budgetedTableWidths.accountIdWidth)
      : compactTableIdentity(row.accountId, "IDENTITY".length),
    plan_type: budgetedTableWidths
      ? truncateVisible(row.planType, budgetedTableWidths.planWidth)
      : row.planType,
    eta: budgetedTableWidths
      ? truncateVisible(row.eta, budgetedTableWidths.etaWidth)
      : row.eta,
    score: budgetedTableWidths
      ? truncateVisible(row.score, budgetedTableWidths.scoreWidth)
      : row.score,
    five_hour: budgetedTableWidths
      ? truncateVisible(row.fiveHour, budgetedTableWidths.fiveHourWidth)
      : row.fiveHour,
    next_reset: budgetedTableWidths
      ? truncateVisible(row.nextReset, budgetedTableWidths.nextResetWidth)
      : row.nextReset,
    five_hour_reset: budgetedTableWidths && splitResetColumns
      ? truncateVisible(row.fiveHourReset, budgetedTableWidths.fiveHourResetWidth)
      : row.fiveHourReset,
    one_week: budgetedTableWidths
      ? truncateVisible(row.oneWeek, budgetedTableWidths.oneWeekWidth)
      : row.oneWeek,
    one_week_reset: budgetedTableWidths && splitResetColumns
      ? truncateVisible(row.oneWeekReset, budgetedTableWidths.oneWeekResetWidth)
      : row.oneWeekReset,
    ...(row.eta5hEq1w !== undefined ? { eta_5h_eq_1w: row.eta5hEq1w } : {}),
    ...(row.eta1w !== undefined ? { eta_1w: row.eta1w } : {}),
    ...(row.rate1wUnits !== undefined ? { rate_1w_units: row.rate1wUnits } : {}),
    ...(row.remaining5hEq1w !== undefined ? { remaining_5h_eq_1w: row.remaining5hEq1w } : {}),
    ...(row.projected5hIn1wUnits1h !== undefined ? { projected_5h_in_1w_units_1h: row.projected5hIn1wUnits1h } : {}),
    ...(row.score1h !== undefined ? { score_1h: row.score1h } : {}),
    ...(row.projected1w1h !== undefined ? { projected_1w_1h: row.projected1w1h } : {}),
    ...(row.fiveHourToOneWeekRatio !== undefined ? { five_hour_to_one_week_ratio: row.fiveHourToOneWeekRatio } : {}),
    ...(row.rowStyle ? { __row_style: row.rowStyle } : {}),
  }));

  if (showEtaColumn) {
    columns.splice(4, 0, {
      key: "eta",
      label: "ETA",
      align: "right",
      headerAlign: "center",
    });
  }

  if (options.verbose) {
    const verboseInsertColumns: TableColumn[] = [];
    if (showVerboseEtaColumns) {
      verboseInsertColumns.push(
        { key: "eta_5h_eq_1w", label: "ETA 5H->1W", align: "right", headerAlign: "center" },
        { key: "eta_1w", label: "ETA 1W", align: "right", headerAlign: "center" },
      );
    }
    verboseInsertColumns.push(
      { key: "rate_1w_units", label: "RATE 1W UNITS", align: "right", headerAlign: "center" },
      { key: "remaining_5h_eq_1w", label: "5H REMAIN->1W", align: "right", headerAlign: "center" },
      { key: "score_1h", label: "1H SCORE", align: "right", headerAlign: "center" },
      { key: "projected_5h_in_1w_units_1h", label: "5H->1W 1H", align: "right", headerAlign: "center" },
      { key: "projected_1w_1h", label: "1W 1H", align: "right", headerAlign: "center" },
      { key: "five_hour_to_one_week_ratio", label: "5H:1W", align: "right", headerAlign: "center" },
    );
    columns.splice(showEtaColumn ? 5 : 4, 0, ...verboseInsertColumns);
    columns.push(
      { key: "five_hour_reset", label: "5H RESET AT", headerAlign: "center" },
      { key: "one_week_reset", label: "1W RESET AT", headerAlign: "center" },
    );
  }

  const table = budgetedTableWidths && !options.verbose
    ? formatTable(rows, columns, [
        budgetedTableWidths.nameWidth,
        budgetedTableWidths.accountIdWidth,
        budgetedTableWidths.planWidth,
        budgetedTableWidths.scoreWidth,
        ...(showEtaColumn ? [budgetedTableWidths.etaWidth] : []),
        budgetedTableWidths.fiveHourWidth,
        ...(splitResetColumns
          ? [
              budgetedTableWidths.fiveHourResetWidth,
              budgetedTableWidths.oneWeekWidth,
              budgetedTableWidths.oneWeekResetWidth,
            ]
          : [
              budgetedTableWidths.oneWeekWidth,
              budgetedTableWidths.nextResetWidth,
            ]),
      ])
    : formatTable(rows, columns);
  const compactRows = options.terminalWidth && !options.verbose && !budgetedTableWidths
    ? renderCompactQuotaRows(displayRows, options.terminalWidth, showEtaColumn)
    : null;
  const { summaryLine, poolLine } = buildListSummary(options.summaryAccounts ?? accounts);

  const lines = [
    describeCurrentListStatus(currentStatus),
    ...(options.daemonFeatureLine ? [options.daemonFeatureLine] : []),
    summaryLine,
    poolLine,
    ...(options.proxyLastUpstreamLine ? [options.proxyLastUpstreamLine] : []),
    ...(options.usageLine ? [options.usageLine] : []),
    "Refreshed quotas:",
    compactRows ?? table,
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
    terminalWidth?: number | null;
    etaByName?: Map<string, WatchHistoryEtaContext>;
    usageLine?: string | null;
    daemonFeatureLine?: string | null;
    proxyLastUpstreamLine?: string | null;
    proxyLastUpstreamAccountName?: string | null;
    proxyAggregate?: ProxyQuotaAggregate | null;
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
