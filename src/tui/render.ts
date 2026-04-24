import { formatAccountListDisplayName, formatAccountListMarkers } from "../account-list-display.js";
import {
  formatTuiUsageSummaryLine,
  formatTuiUsageTrendLine,
} from "../local-usage/format.js";
import type {
  AccountDashboardAccount,
  AccountDashboardDetailOverride,
  AccountDashboardExternalUpdate,
  AccountDashboardSnapshot,
  AccountDashboardState,
  RenderAccountDashboardScreenOptions,
} from "./types.js";

const ANSI = {
  altOn: "\u001B[?1049h",
  altOff: "\u001B[?1049l",
  bgRed: "\u001B[41m",
  black: "\u001B[30m",
  bold: "\u001B[1m",
  clear: "\u001B[2J",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  hideCursor: "\u001B[?25l",
  home: "\u001B[H",
  inverse: "\u001B[7m",
  red: "\u001B[31m",
  reset: "\u001B[0m",
  showCursor: "\u001B[?25h",
  yellow: "\u001B[33m",
} as const;

const PANEL_MIN_WIDTH = 52;
const PANEL_MIN_HEIGHT = 14;
const MIN_RENDERABLE_WIDTH = 36;
const MIN_RENDERABLE_HEIGHT = 8;
const WIDE_LAYOUT_MIN_WIDTH = 104;
const STACKED_LAYOUT_MIN_WIDTH = 72;
const PANE_GAP = " | ";
const WIDE_LIST_MIN_WIDTH = 72;
const WIDE_LIST_MAX_WIDTH = 88;
const WIDE_DETAIL_MIN_WIDTH = 28;
const WIDE_DETAIL_PREFERRED_WIDTH = 40;
const WIDE_NAME_MIN_WIDTH = 10;
const WIDE_NAME_PREFERRED_WIDTH = 22;
const WIDE_IDENTITY_MIN_WIDTH = 8;
const WIDE_PLAN_MIN_WIDTH = 4;
const WIDE_PLAN_MAX_WIDTH = 7;
const WIDE_SCORE_MIN_WIDTH = 5;
const WIDE_SCORE_MAX_WIDTH = 6;
const WIDE_ETA_WIDTH = 6;
const WIDE_USED_MIN_WIDTH = 4;
const WIDE_USED_MAX_WIDTH = 6;
const WIDE_RESET_MIN_WIDTH = 11;
const WIDE_RESET_MAX_WIDTH = 18;

type LayoutMode = "wide" | "stacked" | "list";

interface PanelFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DashboardLayout {
  frame: PanelFrame;
  innerWidth: number;
  innerHeight: number;
  mode: LayoutMode;
  bodyHeight: number;
  listWidth: number;
  detailWidth: number;
  listRows: number;
  detailRows: number;
}

interface WideColumnWidths {
  nameWidth: number;
  identityWidth: number;
  planWidth: number;
  scoreWidth: number;
  fiveHourWidth: number;
  fiveHourResetWidth: number;
  oneWeekWidth: number;
  oneWeekResetWidth: number;
  minListWidth: number;
  preferredListWidth: number;
}

interface FilteredAccounts {
  all: AccountDashboardAccount[];
  selected: AccountDashboardAccount | null;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

function repeat(char: string, width: number): string {
  return Array.from({ length: Math.max(0, width) }, () => char).join("");
}

function isTerminalTooSmall(width: number, height: number): boolean {
  return width < MIN_RENDERABLE_WIDTH || height < MIN_RENDERABLE_HEIGHT;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width <= 2) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 2)}..`;
}

function compactIdentity(value: string, width: number): string {
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

function displayAccountName(account: AccountDashboardAccount): string {
  return formatAccountListDisplayName({
    name: account.name,
    refreshStatus: account.refreshStatusLabel,
    autoSwitchEligible: account.autoSwitchEligible,
  });
}

function compactDetailLine(line: string, width: number): string {
  const prefixes = ["Identity: ", "Account: ", "User: "];
  for (const prefix of prefixes) {
    if (!line.startsWith(prefix)) {
      continue;
    }

    const value = line.slice(prefix.length);
    const availableWidth = Math.max(0, width - prefix.length);
    return `${prefix}${compactIdentity(value, availableWidth)}`;
  }

  return truncate(line, width);
}

function resolveDynamicColumnWidth(options: {
  header: string;
  values: string[];
  minWidth: number;
  maxWidth: number;
}): { minWidth: number; desiredWidth: number } {
  const minWidth = Math.max(options.minWidth, visibleWidth(options.header));
  const desiredWidth = Math.min(
    options.maxWidth,
    Math.max(
      minWidth,
      ...options.values.map((value) => Math.min(visibleWidth(value), options.maxWidth)),
    ),
  );

  return {
    minWidth,
    desiredWidth,
  };
}

function getWideFixedWidth(
  showEtaColumn: boolean,
  columns: Pick<WideColumnWidths, "planWidth" | "scoreWidth" | "fiveHourWidth" | "fiveHourResetWidth" | "oneWeekWidth" | "oneWeekResetWidth">,
): number {
  return (
    4 +
    1 +
    1 +
    columns.planWidth +
    1 +
    columns.scoreWidth +
    (showEtaColumn ? 1 + WIDE_ETA_WIDTH : 0) +
    1 +
    columns.fiveHourWidth +
    1 +
    columns.fiveHourResetWidth +
    1 +
    columns.oneWeekWidth +
    1 +
    columns.oneWeekResetWidth
  );
}

function getWideColumnWidths(
  width: number,
  showEtaColumn: boolean,
  accounts: AccountDashboardAccount[],
): WideColumnWidths {
  const planWidths = resolveDynamicColumnWidth({
    header: "PLAN",
    values: accounts.map((account) => account.planLabel),
    minWidth: WIDE_PLAN_MIN_WIDTH,
    maxWidth: WIDE_PLAN_MAX_WIDTH,
  });
  const scoreWidths = resolveDynamicColumnWidth({
    header: "SCORE",
    values: accounts.map((account) => account.scoreLabel),
    minWidth: WIDE_SCORE_MIN_WIDTH,
    maxWidth: WIDE_SCORE_MAX_WIDTH,
  });
  const fiveHourWidths = resolveDynamicColumnWidth({
    header: "5H",
    values: accounts.map((account) => account.fiveHourLabel),
    minWidth: WIDE_USED_MIN_WIDTH,
    maxWidth: WIDE_USED_MAX_WIDTH,
  });
  const oneWeekWidths = resolveDynamicColumnWidth({
    header: "1W",
    values: accounts.map((account) => account.oneWeekLabel),
    minWidth: WIDE_USED_MIN_WIDTH,
    maxWidth: WIDE_USED_MAX_WIDTH,
  });
  const fiveHourResetWidths = resolveDynamicColumnWidth({
    header: "RESET",
    values: accounts.map((account) => account.fiveHourResetLabel),
    minWidth: WIDE_RESET_MIN_WIDTH,
    maxWidth: WIDE_RESET_MAX_WIDTH,
  });
  const oneWeekResetWidths = resolveDynamicColumnWidth({
    header: "RESET",
    values: accounts.map((account) => account.oneWeekResetLabel),
    minWidth: WIDE_RESET_MIN_WIDTH,
    maxWidth: WIDE_RESET_MAX_WIDTH,
  });
  const fixedMinWidths = {
    planWidth: planWidths.minWidth,
    scoreWidth: scoreWidths.minWidth,
    fiveHourWidth: fiveHourWidths.minWidth,
    fiveHourResetWidth: fiveHourResetWidths.minWidth,
    oneWeekWidth: oneWeekWidths.minWidth,
    oneWeekResetWidth: oneWeekResetWidths.minWidth,
  };
  const fixedWithoutNameIdentity = getWideFixedWidth(showEtaColumn, fixedMinWidths);
  const desiredNameWidth = Math.min(
    WIDE_NAME_PREFERRED_WIDTH,
    Math.max(
      WIDE_NAME_MIN_WIDTH,
      ...accounts.map((account) => Math.min(visibleWidth(displayAccountName(account)), WIDE_NAME_PREFERRED_WIDTH)),
    ),
  );
  const desiredIdentityWidth = Math.max(
    WIDE_IDENTITY_MIN_WIDTH,
    ...accounts.map((account) => visibleWidth(account.identityLabel)),
  );
  const flexibleWidth = Math.max(
    WIDE_NAME_MIN_WIDTH + WIDE_IDENTITY_MIN_WIDTH,
    width - fixedWithoutNameIdentity,
  );
  const desiredFixedGrowths = {
    planWidth: Math.max(0, planWidths.desiredWidth - planWidths.minWidth),
    scoreWidth: Math.max(0, scoreWidths.desiredWidth - scoreWidths.minWidth),
    fiveHourWidth: Math.max(0, fiveHourWidths.desiredWidth - fiveHourWidths.minWidth),
    fiveHourResetWidth: Math.max(0, fiveHourResetWidths.desiredWidth - fiveHourResetWidths.minWidth),
    oneWeekWidth: Math.max(0, oneWeekWidths.desiredWidth - oneWeekWidths.minWidth),
    oneWeekResetWidth: Math.max(0, oneWeekResetWidths.desiredWidth - oneWeekResetWidths.minWidth),
  };
  let nameWidth = WIDE_NAME_MIN_WIDTH;
  let identityWidth = WIDE_IDENTITY_MIN_WIDTH;
  let planWidth = planWidths.minWidth;
  let scoreWidth = scoreWidths.minWidth;
  let fiveHourWidth = fiveHourWidths.minWidth;
  let fiveHourResetWidth = fiveHourResetWidths.minWidth;
  let oneWeekWidth = oneWeekWidths.minWidth;
  let oneWeekResetWidth = oneWeekResetWidths.minWidth;
  let remainingFlexibleWidth = flexibleWidth - nameWidth - identityWidth;

  const consumeGrowth = (currentWidth: number, desiredGrowth: number): number => {
    const appliedGrowth = Math.min(remainingFlexibleWidth, desiredGrowth);
    remainingFlexibleWidth -= appliedGrowth;
    return currentWidth + appliedGrowth;
  };

  const nameGrowth = Math.max(0, desiredNameWidth - nameWidth);
  const appliedNameGrowth = Math.min(remainingFlexibleWidth, nameGrowth);
  nameWidth += appliedNameGrowth;
  remainingFlexibleWidth -= appliedNameGrowth;

  scoreWidth = consumeGrowth(scoreWidth, desiredFixedGrowths.scoreWidth);
  fiveHourWidth = consumeGrowth(fiveHourWidth, desiredFixedGrowths.fiveHourWidth);
  fiveHourResetWidth = consumeGrowth(fiveHourResetWidth, desiredFixedGrowths.fiveHourResetWidth);
  oneWeekWidth = consumeGrowth(oneWeekWidth, desiredFixedGrowths.oneWeekWidth);
  oneWeekResetWidth = consumeGrowth(oneWeekResetWidth, desiredFixedGrowths.oneWeekResetWidth);
  planWidth = consumeGrowth(planWidth, desiredFixedGrowths.planWidth);

  const identityGrowth = Math.max(0, desiredIdentityWidth - identityWidth);
  const appliedIdentityGrowth = Math.min(remainingFlexibleWidth, identityGrowth);
  identityWidth += appliedIdentityGrowth;
  remainingFlexibleWidth -= appliedIdentityGrowth;

  if (remainingFlexibleWidth > 0) {
    identityWidth += remainingFlexibleWidth;
    remainingFlexibleWidth = 0;
  }

  return {
    nameWidth,
    identityWidth,
    planWidth,
    scoreWidth,
    fiveHourWidth,
    fiveHourResetWidth,
    oneWeekWidth,
    oneWeekResetWidth,
    minListWidth: getWideFixedWidth(showEtaColumn, fixedMinWidths) + WIDE_NAME_MIN_WIDTH + WIDE_IDENTITY_MIN_WIDTH,
    preferredListWidth:
      getWideFixedWidth(showEtaColumn, {
        planWidth: planWidths.desiredWidth,
        scoreWidth: scoreWidths.desiredWidth,
        fiveHourWidth: fiveHourWidths.desiredWidth,
        fiveHourResetWidth: fiveHourResetWidths.desiredWidth,
        oneWeekWidth: oneWeekWidths.desiredWidth,
        oneWeekResetWidth: oneWeekResetWidths.desiredWidth,
      }) + desiredNameWidth + desiredIdentityWidth,
  };
}

function padEndVisible(value: string, width: number): string {
  return `${value}${repeat(" ", Math.max(0, width - visibleWidth(value)))}`;
}

function padStartVisible(value: string, width: number): string {
  return `${repeat(" ", Math.max(0, width - visibleWidth(value)))}${value}`;
}

function padVisibleCenter(value: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(value));
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return `${repeat(" ", left)}${value}${repeat(" ", right)}`;
}

function color(value: string, tone: "green" | "yellow" | "red" | "cyan" | "dim"): string {
  const code =
    tone === "green"
      ? ANSI.green
      : tone === "yellow"
        ? ANSI.yellow
        : tone === "red"
          ? ANSI.red
          : tone === "cyan"
            ? ANSI.cyan
            : ANSI.dim;
  return `${code}${value}${ANSI.reset}`;
}

function emphasize(value: string): string {
  return `${ANSI.bold}${value}${ANSI.reset}`;
}

function invert(value: string): string {
  return `${ANSI.inverse}${value}${ANSI.reset}`;
}

function blockRow(value: string): string {
  return `${ANSI.black}${ANSI.bgRed}${stripAnsi(value)}${ANSI.reset}`;
}

function fitLines(lines: string[], height: number): string[] {
  const trimmed = lines.slice(0, Math.max(0, height));
  while (trimmed.length < height) {
    trimmed.push("");
  }
  return trimmed;
}

function computePanelFrame(width: number, height: number): PanelFrame {
  let horizontalMargin = width >= 120 ? 2 : width >= 96 ? 1 : 0;
  let verticalMargin = height >= 28 ? 1 : 0;

  while (width - (horizontalMargin * 2) < PANEL_MIN_WIDTH && horizontalMargin > 0) {
    horizontalMargin -= 1;
  }
  while (height - (verticalMargin * 2) < PANEL_MIN_HEIGHT && verticalMargin > 0) {
    verticalMargin -= 1;
  }

  return {
    x: horizontalMargin,
    y: verticalMargin,
    width: Math.max(4, width - (horizontalMargin * 2)),
    height: Math.max(4, height - (verticalMargin * 2)),
  };
}

function getLayout(
  width: number,
  height: number,
  accountCount: number,
  headerLineCount: number,
  bannerLineCount = 0,
  filteredAccounts: AccountDashboardAccount[] = [],
  showEtaColumn = true,
): DashboardLayout {
  const frame = computePanelFrame(width, height);
  const innerWidth = Math.max(1, frame.width - 2);
  const innerHeight = Math.max(1, frame.height - 2);
  const bodyHeight = Math.max(4, innerHeight - (headerLineCount + 5 + bannerLineCount));

  if (innerWidth >= WIDE_LAYOUT_MIN_WIDTH && bodyHeight >= 10) {
    const availableWidth = Math.max(1, innerWidth - PANE_GAP.length);
    const wideColumns = getWideColumnWidths(WIDE_LIST_MAX_WIDTH, showEtaColumn, filteredAccounts);
    const minListWidth = Math.max(WIDE_LIST_MIN_WIDTH, wideColumns.minListWidth);
    if (availableWidth >= minListWidth + WIDE_DETAIL_MIN_WIDTH) {
      const preferredDetailWidth = Math.min(
        Math.max(WIDE_DETAIL_MIN_WIDTH, WIDE_DETAIL_PREFERRED_WIDTH),
        Math.max(WIDE_DETAIL_MIN_WIDTH, availableWidth - minListWidth),
      );
      const preferredListWidth = Math.min(
        WIDE_LIST_MAX_WIDTH,
        Math.max(minListWidth, wideColumns.preferredListWidth),
      );
      const listWidth = Math.max(
        minListWidth,
        Math.min(preferredListWidth, availableWidth - preferredDetailWidth),
      );
      const detailWidth = Math.max(WIDE_DETAIL_MIN_WIDTH, innerWidth - listWidth - PANE_GAP.length);
      return {
        frame,
        innerWidth,
        innerHeight,
        mode: "wide",
        bodyHeight,
        listWidth,
        detailWidth,
        listRows: bodyHeight,
        detailRows: bodyHeight,
      };
    }
  }

  if (innerWidth >= STACKED_LAYOUT_MIN_WIDTH && bodyHeight >= 8) {
    const listRows = Math.max(5, Math.min(Math.max(5, accountCount + 1), Math.floor(bodyHeight * 0.45)));
    return {
      frame,
      innerWidth,
      innerHeight,
      mode: "stacked",
      bodyHeight,
      listWidth: innerWidth,
      detailWidth: innerWidth,
      listRows,
      detailRows: Math.max(3, bodyHeight - listRows),
    };
  }

  return {
    frame,
    innerWidth,
    innerHeight,
    mode: "list",
    bodyHeight,
    listWidth: innerWidth,
    detailWidth: 0,
    listRows: bodyHeight,
    detailRows: 0,
  };
}

function renderFramedScreen(width: number, height: number, layout: DashboardLayout, lines: string[]): string {
  const topBorder = `+${repeat("-", layout.innerWidth)}+`;
  const framed = [
    topBorder,
    ...fitLines(lines, layout.innerHeight).map((line) => `|${padEndVisible(truncate(line, layout.innerWidth), layout.innerWidth)}|`),
    topBorder,
  ];

  return [
    ...Array.from({ length: layout.frame.y }, () => ""),
    ...framed.map((line) => `${repeat(" ", layout.frame.x)}${line}`),
  ].slice(0, height).join("\n");
}

export function getFilteredAccounts(snapshot: AccountDashboardSnapshot, query: string): AccountDashboardAccount[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === "") {
    return snapshot.accounts;
  }

  return snapshot.accounts.filter((account) => {
    const haystacks = [
      account.name,
      account.planLabel,
      account.identityLabel,
      account.availabilityLabel,
      account.authModeLabel,
      account.accountIdLabel,
      account.userIdLabel,
      account.joinedAtLabel,
      account.lastSwitchedAtLabel,
      account.fetchedAtLabel,
      account.refreshStatusLabel,
      account.bottleneckLabel,
      account.reasonLabel,
      ...account.detailLines,
    ].map((value) => stripAnsi(value).toLowerCase());

    return haystacks.some((value) => value.includes(normalizedQuery));
  });
}

function formatInteractiveQuery(query: string, cursor: number, active: boolean): string {
  if (!active) {
    return query;
  }
  const safeCursor = clamp(cursor, 0, query.length);
  return `${query.slice(0, safeCursor)}_${query.slice(safeCursor)}`;
}

function normalizeStateForViewport(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  width: number,
  height: number,
  headerLineCount = 3,
  bannerLineCount = 0,
  showEtaColumn = true,
): { state: AccountDashboardState; filtered: FilteredAccounts; layout: DashboardLayout } {
  const filteredAccounts = getFilteredAccounts(snapshot, state.query);
  const layout = getLayout(
    width,
    height,
    filteredAccounts.length,
    headerLineCount,
    bannerLineCount,
    filteredAccounts,
    showEtaColumn,
  );
  const visibleRows = layout.mode === "wide"
    ? Math.max(1, layout.listRows - 3)
    : Math.max(1, Math.floor(layout.listRows / 2));
  const nextState = {
    ...state,
    cursor: clamp(state.cursor, 0, state.query.length),
  };

  if (filteredAccounts.length === 0) {
    nextState.selected = 0;
    nextState.scrollTop = 0;
  } else {
    nextState.selected = clamp(nextState.selected, 0, filteredAccounts.length - 1);
    const maxScrollTop = Math.max(0, filteredAccounts.length - visibleRows);
    nextState.scrollTop = clamp(nextState.scrollTop, 0, maxScrollTop);
    if (nextState.selected < nextState.scrollTop) {
      nextState.scrollTop = nextState.selected;
    }
    if (nextState.selected >= nextState.scrollTop + visibleRows) {
      nextState.scrollTop = nextState.selected - visibleRows + 1;
    }
  }

  return {
    state: nextState,
    filtered: {
      all: filteredAccounts,
      selected: filteredAccounts[nextState.selected] ?? null,
    },
    layout,
  };
}

function styleListLine(line: string, account: AccountDashboardAccount, selected: boolean): string {
  if (selected) {
    return invert(stripAnsi(line));
  }

  if (account.oneWeekBlocked) {
    return blockRow(line);
  }

  return line;
}

export function renderWideListHeader(width: number, showEtaColumn: boolean): string[] {
  return renderWideListHeaderWithColumns(
    getWideColumnWidths(width, showEtaColumn, []),
    showEtaColumn,
  );
}

function renderWideListHeaderWithColumns(
  columns: Pick<WideColumnWidths, "nameWidth" | "identityWidth" | "planWidth" | "scoreWidth" | "fiveHourWidth" | "fiveHourResetWidth" | "oneWeekWidth" | "oneWeekResetWidth">,
  showEtaColumn: boolean,
): string[] {
  const {
    nameWidth,
    identityWidth,
    planWidth,
    scoreWidth,
    fiveHourWidth,
    fiveHourResetWidth,
    oneWeekWidth,
    oneWeekResetWidth,
  } = columns;
  const headerLine = [
    "    ",
    padVisibleCenter("NAME", nameWidth),
    " ",
    padVisibleCenter("IDENTITY", identityWidth),
    " ",
    padVisibleCenter("PLAN", planWidth),
    " ",
    padVisibleCenter("SCORE", scoreWidth),
    showEtaColumn ? ` ${padVisibleCenter("ETA", WIDE_ETA_WIDTH)}` : "",
    " ",
    padVisibleCenter("USED", fiveHourWidth),
    " ",
    padVisibleCenter("RESET", fiveHourResetWidth),
    " ",
    padVisibleCenter("USED", oneWeekWidth),
    " ",
    padVisibleCenter("RESET", oneWeekResetWidth),
  ].join("");
  const groupLineChars = Array.from({ length: headerLine.length }, () => " ");
  const placeGroupLabel = (label: string, usedStart: number, resetStart: number) => {
    if (usedStart < 0 || resetStart < 0) {
      return;
    }
    const usedCenter = usedStart + ("USED".length / 2);
    const resetCenter = resetStart + ("RESET".length / 2);
    const labelStart = Math.max(0, Math.round(((usedCenter + resetCenter) / 2) - (label.length / 2)));
    for (let index = 0; index < label.length && labelStart + index < groupLineChars.length; index += 1) {
      groupLineChars[labelStart + index] = label[index] ?? " ";
    }
  };
  const fiveHourUsedStart = headerLine.indexOf("USED");
  const fiveHourResetStart = headerLine.indexOf("RESET", Math.max(0, fiveHourUsedStart + 1));
  const oneWeekUsedStart = headerLine.indexOf("USED", Math.max(0, fiveHourResetStart + 1));
  const oneWeekResetStart = headerLine.indexOf("RESET", Math.max(0, oneWeekUsedStart + 1));
  placeGroupLabel("5H", fiveHourUsedStart, fiveHourResetStart);
  placeGroupLabel("1W", oneWeekUsedStart, oneWeekResetStart);

  return [
    groupLineChars.join("").trimEnd(),
    headerLine,
    [
      repeat("-", 3),
      " ",
      repeat("-", nameWidth),
      " ",
      repeat("-", identityWidth),
      " ",
      repeat("-", planWidth),
      " ",
      repeat("-", scoreWidth),
      showEtaColumn ? ` ${repeat("-", WIDE_ETA_WIDTH)}` : "",
      " ",
      repeat("-", fiveHourWidth),
      " ",
      repeat("-", fiveHourResetWidth),
      " ",
      repeat("-", oneWeekWidth),
      " ",
      repeat("-", oneWeekResetWidth),
    ].join(""),
  ];
}

function renderWideListRow(
  account: AccountDashboardAccount,
  selected: boolean,
  columns: Pick<WideColumnWidths, "nameWidth" | "identityWidth" | "planWidth" | "scoreWidth" | "fiveHourWidth" | "fiveHourResetWidth" | "oneWeekWidth" | "oneWeekResetWidth">,
  showEtaColumn: boolean,
): string {
  const {
    nameWidth,
    identityWidth,
    planWidth,
    scoreWidth,
    fiveHourWidth,
    fiveHourResetWidth,
    oneWeekWidth,
    oneWeekResetWidth,
  } = columns;
  const displayName = displayAccountName(account);
  const markers = formatAccountListMarkers({
    selected,
    current: account.current,
    proxyUpstreamActive: account.proxyUpstreamActive,
  });
  const line = [
    markers,
    padEndVisible(truncate(displayName, nameWidth), nameWidth),
    " ",
    padEndVisible(compactIdentity(account.identityLabel, identityWidth), identityWidth),
    " ",
    padEndVisible(truncate(account.planLabel, planWidth), planWidth),
    " ",
    padStartVisible(account.scoreLabel, scoreWidth),
    showEtaColumn ? ` ${padStartVisible(account.etaLabel, WIDE_ETA_WIDTH)}` : "",
    " ",
    padStartVisible(account.fiveHourLabel, fiveHourWidth),
    " ",
    padEndVisible(truncate(account.fiveHourResetLabel, fiveHourResetWidth), fiveHourResetWidth),
    " ",
    padStartVisible(account.oneWeekLabel, oneWeekWidth),
    " ",
    padEndVisible(truncate(account.oneWeekResetLabel, oneWeekResetWidth), oneWeekResetWidth),
  ].join("");

  return styleListLine(line, account, selected);
}

function renderCompactListRow(
  account: AccountDashboardAccount,
  selected: boolean,
  width: number,
  showEtaColumn: boolean,
): string[] {
  const markersWidth = formatAccountListMarkers({ selected: false }).length;
  const scoreWidth = visibleWidth(account.scoreLabel);
  const etaWidth = showEtaColumn ? visibleWidth(account.etaLabel) : 0;
  const planWidth = account.planLabel === ""
    ? 0
    : Math.min(WIDE_PLAN_MAX_WIDTH, visibleWidth(account.planLabel));
  const minimumNameWidth = 10;
  const reservedCoreWidth = markersWidth + 1 + scoreWidth + (showEtaColumn ? 1 + etaWidth : 0) + minimumNameWidth;
  const includePlan = account.planLabel !== "" && width - reservedCoreWidth >= 1 + planWidth;
  const nameWidth = Math.max(
    8,
    width - markersWidth - 1 - scoreWidth - (showEtaColumn ? 1 + etaWidth : 0) - (includePlan ? 1 + planWidth : 0),
  );
  const displayName = displayAccountName(account);
  const markers = formatAccountListMarkers({
    selected,
    current: account.current,
    proxyUpstreamActive: account.proxyUpstreamActive,
  });
  const firstLine = [
    markers,
    padEndVisible(truncate(displayName, nameWidth), nameWidth),
    includePlan ? ` ${padEndVisible(truncate(account.planLabel, planWidth), planWidth)}` : "",
    " ",
    padStartVisible(account.scoreLabel, scoreWidth),
    showEtaColumn ? ` ${padStartVisible(account.etaLabel, etaWidth)}` : "",
  ].join("");

  const secondLineIndent = " ".repeat(markersWidth);
  const secondLineWidth = Math.max(0, width - markersWidth);
  const secondSegments = [`5H ${account.fiveHourLabel}`, `1W ${account.oneWeekLabel}`];
  if (
    account.nextResetLabel !== "-"
    && visibleWidth([...secondSegments, account.nextResetLabel].join(" | ")) <= secondLineWidth
  ) {
    secondSegments.push(account.nextResetLabel);
  }
  const identityWidth = Math.min(
    24,
    Math.max(0, secondLineWidth - visibleWidth(secondSegments.join(" | ")) - 3),
  );
  if (account.identityLabel !== "" && identityWidth >= 8) {
    secondSegments.push(compactIdentity(account.identityLabel, identityWidth));
  }
  const secondLine = `${secondLineIndent}${truncate(secondSegments.join(" | "), secondLineWidth)}`;

  return [
    styleListLine(firstLine, account, selected),
    styleListLine(secondLine, account, selected),
  ];
}

function renderListLines(
  filteredAccounts: AccountDashboardAccount[],
  state: AccountDashboardState,
  width: number,
  height: number,
  layoutMode: LayoutMode,
  showEtaColumn: boolean,
): string[] {
  if (layoutMode === "wide") {
    const wideColumns = getWideColumnWidths(width, showEtaColumn, filteredAccounts);
    const headerLines = renderWideListHeaderWithColumns(wideColumns, showEtaColumn);
    if (filteredAccounts.length === 0) {
      return fitLines(headerLines, height);
    }

    const visibleAccounts = Math.max(1, height - headerLines.length);
    const start = clamp(state.scrollTop, 0, Math.max(0, filteredAccounts.length - visibleAccounts));
    const visible = filteredAccounts.slice(start, start + visibleAccounts);
    return fitLines(
      [
        ...headerLines,
        ...visible.map((account, index) => (
          renderWideListRow(account, start + index === state.selected, wideColumns, showEtaColumn)
        )),
      ],
      height,
    );
  }

  if (filteredAccounts.length === 0) {
    return fitLines(["No accounts match current filter."], height);
  }

  const visibleAccounts = Math.max(1, Math.floor(height / 2));
  const start = clamp(state.scrollTop, 0, Math.max(0, filteredAccounts.length - visibleAccounts));
  const visible = filteredAccounts.slice(start, start + visibleAccounts);
  return fitLines(
    visible.flatMap((account, index) => (
      renderCompactListRow(account, start + index === state.selected, width, showEtaColumn)
    )),
    height,
  );
}

function renderDetailLines(
  snapshot: AccountDashboardSnapshot,
  selectedAccount: AccountDashboardAccount | null,
  width: number,
  height: number,
  detailOverride?: AccountDashboardDetailOverride | null,
): string[] {
  if (detailOverride) {
    return fitLines(
      [emphasize(detailOverride.title), ...detailOverride.lines].map((line) => truncate(line, width)),
      height,
    );
  }

  if (!selectedAccount) {
    const lines = snapshot.accounts.length === 0
      ? [
          "No saved accounts.",
          "",
          'Use "codexm add <name>" or "codexm save <name>" to create one.',
        ]
      : [
          "No accounts match current filter.",
          "",
          "Adjust the filter or press Esc to leave filter mode.",
        ];
    return fitLines(lines, height);
  }

  const protectionTag = selectedAccount.autoSwitchEligible ? "" : " [protected]";
  const titleParts = [
    selectedAccount.current
      ? `${selectedAccount.name} [current]${protectionTag}`
      : `${selectedAccount.name}${protectionTag}`,
    ...(selectedAccount.planLabel ? [`[${selectedAccount.planLabel}]`] : []),
    `[${selectedAccount.refreshStatusLabel}]`,
  ];
  const title = titleParts.join(" ");

  return fitLines(
    [emphasize(title), ...selectedAccount.detailLines].map((line) => compactDetailLine(line, width)),
    height,
  );
}

function renderBodyLines(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  width: number,
  height: number,
  headerLineCount: number,
  bannerLineCount: number,
  detailOverride?: AccountDashboardDetailOverride | null,
  showEtaColumn = true,
): string[] {
  const normalized = normalizeStateForViewport(
    snapshot,
    state,
    width,
    height + headerLineCount + 5 + bannerLineCount,
    headerLineCount,
    bannerLineCount,
    showEtaColumn,
  );
  const { layout } = normalized;

  if (layout.mode === "wide") {
    const listLines = renderListLines(
      normalized.filtered.all,
      normalized.state,
      layout.listWidth,
      layout.listRows,
      layout.mode,
      showEtaColumn,
    );
    const detailLines = renderDetailLines(
      snapshot,
      normalized.filtered.selected,
      layout.detailWidth,
      layout.detailRows,
      detailOverride,
    );
    return fitLines(
      Array.from({ length: layout.bodyHeight }, (_, index) =>
        `${padEndVisible(listLines[index] ?? "", layout.listWidth)}${PANE_GAP}${padEndVisible(detailLines[index] ?? "", layout.detailWidth)}`,
      ),
      height,
    );
  }

  if (layout.mode === "stacked") {
    const listLines = renderListLines(
      normalized.filtered.all,
      normalized.state,
      layout.listWidth,
      layout.listRows,
      layout.mode,
      showEtaColumn,
    );
    const detailLines = renderDetailLines(
      snapshot,
      normalized.filtered.selected,
      layout.detailWidth,
      layout.detailRows,
      detailOverride,
    );
    return fitLines([...listLines, ...detailLines], height);
  }

  return fitLines(
    renderListLines(
      normalized.filtered.all,
      normalized.state,
      layout.listWidth,
      layout.listRows,
      layout.mode,
      showEtaColumn,
    ),
    height,
  );
}

function renderDivider(width: number): string {
  return repeat("-", width);
}

function buildCompactSelectionLine(account: AccountDashboardAccount | null): string {
  if (!account) {
    return "No account selected.";
  }

  return [
    account.name,
    account.scoreLabel,
    account.etaLabel,
    `fetched ${account.fetchedAtLabel}`,
  ].join(" | ");
}

function formatStatusLine(options: {
  snapshot: AccountDashboardSnapshot;
  state: AccountDashboardState;
  filteredCount: number;
  selectedAccount: AccountDashboardAccount | null;
  layoutMode: LayoutMode;
  busyMessage: string | null | undefined;
  refreshing: boolean;
}): string {
  if (options.busyMessage) {
    return options.busyMessage;
  }
  if (options.state.statusMessage) {
    return options.state.statusMessage;
  }
  if (options.refreshing) {
    return "Refreshing accounts...";
  }
  if (options.layoutMode === "list") {
    return buildCompactSelectionLine(options.selectedAccount);
  }
  if (options.snapshot.failures.length > 0) {
    if (options.snapshot.accounts.length > 0) {
      const count = options.snapshot.failures.length;
      return `Refresh failures: ${count} account${count === 1 ? "" : "s"}. Showing available data.`;
    }
    const failure = options.snapshot.failures[0];
    return `Failure: ${failure.name}: ${failure.error}`;
  }
  if (options.snapshot.warnings.length > 0) {
    return `Warning: ${options.snapshot.warnings[0]}`;
  }
  if (options.snapshot.accounts.length === 0) {
    return "Ready to add or save an account.";
  }
  return `Showing ${options.filteredCount}/${options.snapshot.accounts.length} accounts.`;
}

function renderFilterLine(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  filteredCount: number,
  width: number,
): string {
  const query = state.query === "" && !state.filterActive
    ? "(press / to filter)"
    : formatInteractiveQuery(state.query, state.cursor, state.filterActive);
  return truncate(`filter: ${query} | showing ${filteredCount}/${snapshot.accounts.length}`, width);
}

function renderHintBar(width: number, selectedAccount: AccountDashboardAccount | null): string {
  const forceLabel = selectedAccount?.current ? "f reload" : "f force";
  const wideForceLabel = selectedAccount?.current ? "f reload" : "f force-switch";
  const proxySelected = selectedAccount?.authModeLabel === "proxy";
  const hint = proxySelected
    ? width < 92
      ? `Enter | a auto | ${forceLabel} | o run | O iso | d desk | D rel | q quit`
      : width < 144
        ? `/ filter | Enter | a auto | ${forceLabel} | o run | O iso | d desk | D rel | i imp | q quit`
        : `j/k move | / filter | Enter toggle proxy | a autoswitch | ${selectedAccount?.current ? "f reapply" : wideForceLabel} | o codex | O isolated | d desktop | D relaunch | i import | r refresh | q quit`
    : width < 92
      ? `Enter | a auto | ${forceLabel} | p prot | o run | O iso | d desk | D rel | q quit`
      : width < 176
        ? `/ filter | Enter | a auto | ${forceLabel} | p prot | o run | O iso | d desk | D rel | e exp | i imp | x del | u undo | q quit`
        : `j/k move | / filter | Enter switch | a autoswitch | ${wideForceLabel} | p protect | o codex | O isolated | d desktop | D relaunch | e export | i import | x delete | u undo | r refresh | q quit`;
  return truncate(color(hint, "dim"), width);
}

export function createInitialAccountDashboardState(initialQuery = ""): AccountDashboardState {
  return {
    selected: 0,
    scrollTop: 0,
    query: initialQuery,
    filterActive: false,
    cursor: initialQuery.length,
    statusMessage: null,
  };
}

export function renderAccountDashboardScreen(
  options: RenderAccountDashboardScreenOptions,
): string {
  if (isTerminalTooSmall(options.width, options.height)) {
    return [
      `${ANSI.clear}${ANSI.home}${ANSI.bold}codexm${ANSI.reset}`,
      "Terminal too small to render the dashboard.",
      `Current: ${options.width}x${options.height} | Need at least: ${MIN_RENDERABLE_WIDTH}x${MIN_RENDERABLE_HEIGHT}`,
      'Resize the terminal, or use "codexm list".',
    ]
      .slice(0, Math.max(1, options.height))
      .map((line) => truncate(line, Math.max(1, options.width)))
      .join("\n");
  }

  const previewFrame = computePanelFrame(options.width, options.height);
  const previewInnerWidth = Math.max(1, previewFrame.width - 2);
  const previewInnerHeight = Math.max(1, previewFrame.height - 2);
  const usageHeaderLines = options.snapshot.usageSummary
    ? [
        formatTuiUsageSummaryLine(options.snapshot.usageSummary, previewInnerWidth),
        formatTuiUsageTrendLine(options.snapshot.usageSummary, previewInnerWidth, previewInnerHeight),
      ].filter((line): line is string => typeof line === "string" && line !== "")
    : [];
  const headerLineCount = 4 + usageHeaderLines.length;
  const bannerLineCount = options.bannerMessage ? 1 : 0;
  const normalized = normalizeStateForViewport(
    options.snapshot,
    options.state,
    options.width,
    options.height,
    headerLineCount,
    bannerLineCount,
    options.snapshot.showEtaColumn ?? true,
  );
  const { layout } = normalized;
  const filteredCount = normalized.filtered.all.length;
  const showEtaColumn = options.snapshot.showEtaColumn ?? true;
  const bannerLine = options.bannerMessage
    ? emphasize(color(options.bannerMessage, "yellow"))
    : "";
  const lines = [
    truncate(options.snapshot.headerLine, layout.innerWidth),
    truncate(options.snapshot.currentStatusLine, layout.innerWidth),
    truncate(options.snapshot.summaryLine, layout.innerWidth),
    truncate(options.snapshot.poolLine, layout.innerWidth),
    ...usageHeaderLines.map((line) => truncate(line, layout.innerWidth)),
    renderDivider(layout.innerWidth),
    ...renderBodyLines(
      options.snapshot,
      normalized.state,
      layout.innerWidth,
      layout.bodyHeight,
      headerLineCount,
      bannerLineCount,
      options.detailOverride,
      showEtaColumn,
    ),
    renderDivider(layout.innerWidth),
    truncate(
      options.footerOverride
        ?? renderFilterLine(options.snapshot, normalized.state, filteredCount, layout.innerWidth),
      layout.innerWidth,
    ),
    ...(bannerLine ? [truncate(bannerLine, layout.innerWidth)] : []),
    truncate(
      options.statusOverride
        ?? formatStatusLine({
          snapshot: options.snapshot,
          state: normalized.state,
          filteredCount,
          selectedAccount: normalized.filtered.selected,
          layoutMode: layout.mode,
          busyMessage: options.busyMessage,
          refreshing: options.refreshing ?? false,
        }),
      layout.innerWidth,
    ),
    truncate(
      options.hintOverride ?? renderHintBar(layout.innerWidth, normalized.filtered.selected),
      layout.innerWidth,
    ),
  ];

  return renderFramedScreen(options.width, options.height, layout, lines);
}

export function resolvePreferredSelection(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  preferredName: string | null,
): AccountDashboardState {
  const filteredAccounts = getFilteredAccounts(snapshot, state.query);
  if (filteredAccounts.length === 0) {
    return {
      ...state,
      selected: 0,
      scrollTop: 0,
    };
  }

  const selectedName = preferredName
    ?? filteredAccounts[state.selected]?.name
    ?? filteredAccounts.find((account) => account.current)?.name
    ?? filteredAccounts[0]?.name
    ?? null;
  const selectedIndex = selectedName
    ? filteredAccounts.findIndex((account) => account.name === selectedName)
    : 0;

  return {
    ...state,
    selected: selectedIndex >= 0 ? selectedIndex : 0,
  };
}

export function updateSnapshotCurrentIndicator(
  snapshot: AccountDashboardSnapshot,
  currentName: string,
): AccountDashboardSnapshot {
  const nextAccounts = snapshot.accounts.map((account) => {
    const nextCurrent = account.name === currentName;
    return account.current === nextCurrent
      ? account
      : {
          ...account,
          current: nextCurrent,
        };
  });
  const nextHeaderLine = snapshot.headerLine.replace(
    /(codexm \| current )(.+?)( \| )/u,
    `$1${currentName}$3`,
  );
  const nextCurrentStatusLine = `Current managed account: ${currentName}`;

  if (
    nextHeaderLine === snapshot.headerLine
    && nextCurrentStatusLine === snapshot.currentStatusLine
    && nextAccounts.every((account, index) => account === snapshot.accounts[index])
  ) {
    return snapshot;
  }

  return {
    ...snapshot,
    headerLine: nextHeaderLine,
    currentStatusLine: nextCurrentStatusLine,
    accounts: nextAccounts,
  };
}

function updateProxyDetailLines(
  detailLines: string[],
  proxyLastUpstreamLabel: string | null,
): string[] {
  const nextLastUpstreamLine = proxyLastUpstreamLabel ? `Last upstream: ${proxyLastUpstreamLabel}` : null;
  const trimmedLines = detailLines.filter((line) => !line.startsWith("Last upstream: "));
  if (!nextLastUpstreamLine) {
    return trimmedLines;
  }

  const poolLineIndex = trimmedLines.findIndex((line) => line.startsWith("Pool: "));
  if (poolLineIndex >= 0) {
    return [
      ...trimmedLines.slice(0, poolLineIndex + 1),
      nextLastUpstreamLine,
      ...trimmedLines.slice(poolLineIndex + 1),
    ];
  }

  const firstBlankIndex = trimmedLines.findIndex((line) => line === "");
  if (firstBlankIndex >= 0) {
    return [
      ...trimmedLines.slice(0, firstBlankIndex),
      nextLastUpstreamLine,
      ...trimmedLines.slice(firstBlankIndex),
    ];
  }

  return [...trimmedLines, nextLastUpstreamLine];
}

export function updateSnapshotProxyRouting(
  snapshot: AccountDashboardSnapshot,
  options: {
    proxyUpstreamName?: string | null;
    proxyLastUpstreamLabel?: string | null;
  },
): AccountDashboardSnapshot {
  if (options.proxyUpstreamName === undefined && options.proxyLastUpstreamLabel === undefined) {
    return snapshot;
  }

  let changed = false;
  const nextAccounts = snapshot.accounts.map((account) => {
    let nextAccount = account;

    if (options.proxyUpstreamName !== undefined && account.authModeLabel !== "proxy") {
      const nextProxyUpstreamActive = options.proxyUpstreamName !== null && account.name === options.proxyUpstreamName;
      if (account.proxyUpstreamActive !== nextProxyUpstreamActive) {
        nextAccount = {
          ...nextAccount,
          proxyUpstreamActive: nextProxyUpstreamActive,
        };
      }
    }

    if (options.proxyLastUpstreamLabel !== undefined && account.authModeLabel === "proxy") {
      const nextDetailLines = updateProxyDetailLines(
        nextAccount.detailLines,
        options.proxyLastUpstreamLabel,
      );
      if (
        account.proxyLastUpstreamLabel !== options.proxyLastUpstreamLabel
        || nextDetailLines !== nextAccount.detailLines
      ) {
        nextAccount = {
          ...nextAccount,
          proxyLastUpstreamLabel: options.proxyLastUpstreamLabel,
          detailLines: nextDetailLines,
        };
      }
    }

    if (nextAccount !== account) {
      changed = true;
    }
    return nextAccount;
  });

  return changed
    ? {
        ...snapshot,
        accounts: nextAccounts,
      }
    : snapshot;
}

export function createPlaceholderSnapshot(): AccountDashboardSnapshot {
  return {
    headerLine: "codexm | current loading | 0/0 usable | updated -",
    currentStatusLine: "Current auth: missing",
    summaryLine: "Accounts: 0/0 usable | blocked: 1W 0, 5H 0",
    poolLine: "Available: bottleneck - | 5H->1W - | 1W - (plus 1W)",
    usageSummary: null,
    warnings: [],
    failures: [],
    accounts: [],
  };
}

export { ANSI };
