import type { LocalUsageSummary } from "../local-usage/types.js";
import {
  formatTuiUsageSummaryLine,
  formatTuiUsageTrendLine,
} from "../local-usage/format.js";
import {
  StaleDaemonProcessError,
  type StaleDaemonPortConflict,
} from "../daemon/process.js";

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
const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 75_000;
const PANE_GAP = " | ";
const WIDE_LIST_MIN_WIDTH = 72;
const WIDE_LIST_MAX_WIDTH = 88;
const WIDE_DETAIL_MIN_WIDTH = 28;
const WIDE_DETAIL_PREFERRED_WIDTH = 40;
const WIDE_NAME_MIN_WIDTH = 10;
const WIDE_NAME_PREFERRED_WIDTH = 22;
const WIDE_IDENTITY_MIN_WIDTH = 8;
const WIDE_PLAN_MIN_WIDTH = 4;
const WIDE_PLAN_MAX_WIDTH = 6;
const WIDE_SCORE_MIN_WIDTH = 5;
const WIDE_SCORE_MAX_WIDTH = 6;
const WIDE_ETA_WIDTH = 6;
const WIDE_USED_MIN_WIDTH = 4;
const WIDE_USED_MAX_WIDTH = 6;
const WIDE_RESET_MIN_WIDTH = 11;
const WIDE_RESET_MAX_WIDTH = 18;
const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
type SignalSource = {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
};

type LayoutMode = "wide" | "stacked" | "list";
type ExitAction = "quit" | "open-codex" | "open-isolated-codex";

export interface AccountDashboardDetailOverride {
  title: string;
  lines: string[];
}

export interface AccountDashboardUndoAction {
  label: string;
  run: () => Promise<AccountDashboardActionResult>;
  discard?: () => Promise<void>;
}

export interface AccountDashboardActionResult {
  statusMessage?: string;
  warningMessages?: string[];
  preferredName?: string | null;
  undo?: AccountDashboardUndoAction;
}

export interface AccountDashboardImportPreview {
  bundlePath: string;
  suggestedName: string | null;
  title: string;
  lines: string[];
}

export interface AccountDashboardExportSource {
  type: "current" | "managed";
  name: string | null;
}

export interface AccountDashboardAccount {
  name: string;
  autoSwitchEligible: boolean;
  planLabel: string;
  identityLabel: string;
  availabilityLabel: string;
  current: boolean;
  score: number | null;
  scoreLabel: string;
  etaLabel: string;
  nextResetLabel: string;
  fiveHourLabel: string;
  oneWeekLabel: string;
  authModeLabel: string;
  emailLabel: string;
  accountIdLabel: string;
  userIdLabel: string;
  joinedAtLabel: string;
  lastSwitchedAtLabel: string;
  fetchedAtLabel: string;
  refreshStatusLabel: string;
  bottleneckLabel: string;
  reasonLabel: string;
  proxyUpstreamActive?: boolean;
  proxyLastUpstreamLabel?: string | null;
  oneWeekBlocked?: boolean;
  detailLines: string[];
}

export interface AccountDashboardSnapshot {
  headerLine: string;
  currentStatusLine: string;
  summaryLine: string;
  poolLine: string;
  usageSummary: LocalUsageSummary | null;
  showEtaColumn?: boolean;
  warnings: string[];
  failures: Array<{ name: string; error: string }>;
  accounts: AccountDashboardAccount[];
}

export interface AccountDashboardState {
  selected: number;
  scrollTop: number;
  query: string;
  filterActive: boolean;
  cursor: number;
  statusMessage: string | null;
}

export interface RenderAccountDashboardScreenOptions {
  snapshot: AccountDashboardSnapshot;
  state: AccountDashboardState;
  width: number;
  height: number;
  busyMessage?: string | null;
  refreshing?: boolean;
  bannerMessage?: string | null;
  detailOverride?: AccountDashboardDetailOverride | null;
  footerOverride?: string | null;
  hintOverride?: string | null;
  statusOverride?: string | null;
}

export interface RunAccountDashboardTuiOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  signalSource?: SignalSource;
  initialQuery?: string;
  initialSnapshot?: AccountDashboardSnapshot;
  autoRefreshIntervalMs?: number | null;
  subscribeExternalUpdates?: (
    listener: (update: AccountDashboardExternalUpdate) => void,
  ) => (() => void);
  loadSnapshot: () => Promise<AccountDashboardSnapshot>;
  switchAccount: (
    name: string,
    options: {
      force: boolean;
      signal?: AbortSignal;
      onStatusMessage?: (message: string) => void;
    },
  ) => Promise<{
    statusMessage?: string;
    warningMessages?: string[];
    currentName?: string | null;
    proxyUpstreamName?: string | null;
    proxyLastUpstreamLabel?: string | null;
  }>;
  openDesktop?: (
    name: string,
    options?: { forceRelaunch?: boolean },
  ) => Promise<{
    statusMessage?: string;
    warningMessages?: string[];
  }>;
  exportAccount?: (
    source: AccountDashboardExportSource,
    outputPath: string,
  ) => Promise<AccountDashboardActionResult>;
  inspectImportBundle?: (
    bundlePath: string,
  ) => Promise<AccountDashboardImportPreview>;
  importBundle?: (
    bundlePath: string,
    localName: string,
  ) => Promise<AccountDashboardActionResult>;
  deleteAccount?: (
    name: string,
  ) => Promise<AccountDashboardActionResult>;
  toggleAutoSwitchProtection?: (
    name: string,
    eligible: boolean,
  ) => Promise<AccountDashboardActionResult>;
  toggleAutoswitch?: () => Promise<AccountDashboardActionResult>;
  triggerBackgroundRefresh?: (options: {
    ensureDaemon: boolean;
    source: string;
  }) => Promise<void>;
  cleanupStaleDaemonProcess?: (
    conflict: StaleDaemonPortConflict,
  ) => Promise<void>;
}

export interface AccountDashboardExitResult {
  code: number;
  action: ExitAction;
  preferredName?: string | null;
}

export interface AccountDashboardExternalUpdate {
  statusMessage?: string;
  preferredName?: string | null;
  refresh?: boolean;
}

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
  oneWeekWidth: number;
  resetWidth: number;
  minListWidth: number;
  preferredListWidth: number;
}

interface FilteredAccounts {
  all: AccountDashboardAccount[];
  selected: AccountDashboardAccount | null;
}

interface InputEvent {
  value: string;
  name: string;
  ctrl?: boolean;
}

type PromptState =
  | {
      kind: "export";
      label: string;
      value: string;
      cursor: number;
      source: AccountDashboardExportSource;
    }
  | {
      kind: "import-path";
      label: string;
      value: string;
      cursor: number;
    }
  | {
      kind: "import-name";
      label: string;
      value: string;
      cursor: number;
      bundlePath: string;
      preview: AccountDashboardImportPreview;
    };

type ConfirmState = {
  kind: "delete";
  accountName: string;
} | {
  kind: "desktop-relaunch";
  accountName: string;
} | {
  kind: "cleanup-stale-daemon";
  accountName: string;
  conflict: StaleDaemonPortConflict;
  retry: {
    force: boolean;
    after: ExitAction | "desktop" | "desktop-force" | null;
  };
};

function buildDefaultExportPath(source: AccountDashboardExportSource): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
  const base = source.type === "managed" && source.name ? source.name : "current";
  return `./codexm-share-${base}-${timestamp}.json`;
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
  const staleTag = account.refreshStatusLabel === "stale" ? " [stale]" : "";
  const protectionTag = account.autoSwitchEligible ? "" : " [P]";
  return `${account.name}${staleTag}${protectionTag}`;
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
  columns: Pick<WideColumnWidths, "planWidth" | "scoreWidth" | "fiveHourWidth" | "oneWeekWidth" | "resetWidth">,
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
    columns.oneWeekWidth +
    1 +
    columns.resetWidth
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
  const resetWidths = resolveDynamicColumnWidth({
    header: "NEXT RESET",
    values: accounts.map((account) => account.nextResetLabel),
    minWidth: WIDE_RESET_MIN_WIDTH,
    maxWidth: WIDE_RESET_MAX_WIDTH,
  });
  const fixedMinWidths = {
    planWidth: planWidths.minWidth,
    scoreWidth: scoreWidths.minWidth,
    fiveHourWidth: fiveHourWidths.minWidth,
    oneWeekWidth: oneWeekWidths.minWidth,
    resetWidth: resetWidths.minWidth,
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
    oneWeekWidth: Math.max(0, oneWeekWidths.desiredWidth - oneWeekWidths.minWidth),
    resetWidth: Math.max(0, resetWidths.desiredWidth - resetWidths.minWidth),
  };
  let nameWidth = WIDE_NAME_MIN_WIDTH;
  let identityWidth = WIDE_IDENTITY_MIN_WIDTH;
  let planWidth = planWidths.minWidth;
  let scoreWidth = scoreWidths.minWidth;
  let fiveHourWidth = fiveHourWidths.minWidth;
  let oneWeekWidth = oneWeekWidths.minWidth;
  let resetWidth = resetWidths.minWidth;
  let remainingFlexibleWidth = flexibleWidth - nameWidth - identityWidth;

  const consumeGrowth = (currentWidth: number, desiredGrowth: number): [number, number] => {
    const appliedGrowth = Math.min(remainingFlexibleWidth, desiredGrowth);
    remainingFlexibleWidth -= appliedGrowth;
    return [currentWidth + appliedGrowth, desiredGrowth - appliedGrowth];
  };

  [planWidth] = consumeGrowth(planWidth, desiredFixedGrowths.planWidth);
  [scoreWidth] = consumeGrowth(scoreWidth, desiredFixedGrowths.scoreWidth);
  [fiveHourWidth] = consumeGrowth(fiveHourWidth, desiredFixedGrowths.fiveHourWidth);
  [oneWeekWidth] = consumeGrowth(oneWeekWidth, desiredFixedGrowths.oneWeekWidth);
  [resetWidth] = consumeGrowth(resetWidth, desiredFixedGrowths.resetWidth);

  const nameGrowth = Math.max(0, desiredNameWidth - nameWidth);
  const appliedNameGrowth = Math.min(remainingFlexibleWidth, nameGrowth);
  nameWidth += appliedNameGrowth;
  remainingFlexibleWidth -= appliedNameGrowth;

  const identityGrowth = Math.max(0, desiredIdentityWidth - identityWidth);
  const appliedIdentityGrowth = Math.min(remainingFlexibleWidth, identityGrowth);
  identityWidth += appliedIdentityGrowth;
  remainingFlexibleWidth -= appliedIdentityGrowth;

  if (remainingFlexibleWidth > 0) {
    const extraIdentityGrowth = remainingFlexibleWidth;
    identityWidth += extraIdentityGrowth;
    remainingFlexibleWidth -= extraIdentityGrowth;
  }

  return {
    nameWidth,
    identityWidth,
    planWidth,
    scoreWidth,
    fiveHourWidth,
    oneWeekWidth,
    resetWidth,
    minListWidth: getWideFixedWidth(showEtaColumn, fixedMinWidths) + WIDE_NAME_MIN_WIDTH + WIDE_IDENTITY_MIN_WIDTH,
    preferredListWidth:
      getWideFixedWidth(showEtaColumn, {
        planWidth: planWidths.desiredWidth,
        scoreWidth: scoreWidths.desiredWidth,
        fiveHourWidth: fiveHourWidths.desiredWidth,
        oneWeekWidth: oneWeekWidths.desiredWidth,
        resetWidth: resetWidths.desiredWidth,
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
    const wideColumns = getWideColumnWidths(
      WIDE_LIST_MAX_WIDTH,
      showEtaColumn,
      filteredAccounts,
    );
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

function getFilteredAccounts(snapshot: AccountDashboardSnapshot, query: string): AccountDashboardAccount[] {
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
    return invert(line);
  }

  if (account.oneWeekBlocked) {
    return blockRow(line);
  }

  return line;
}

function renderWideListHeader(width: number, showEtaColumn: boolean): string[] {
  return renderWideListHeaderWithColumns(
    getWideColumnWidths(width, showEtaColumn, []),
    showEtaColumn,
  );
}

function renderWideListHeaderWithColumns(
  columns: Pick<WideColumnWidths, "nameWidth" | "identityWidth" | "planWidth" | "scoreWidth" | "fiveHourWidth" | "oneWeekWidth" | "resetWidth">,
  showEtaColumn: boolean,
): string[] {
  const {
    nameWidth,
    identityWidth,
    planWidth,
    scoreWidth,
    fiveHourWidth,
    oneWeekWidth,
    resetWidth,
  } = columns;
  const etaBlockWidth = showEtaColumn ? 1 + WIDE_ETA_WIDTH : 0;
  const groupPrefix = 4 + nameWidth + 1 + identityWidth + 1 + planWidth + 1 + scoreWidth + etaBlockWidth + 1;
  const usedSpan = fiveHourWidth + 1 + oneWeekWidth;

  return [
    `${repeat(" ", groupPrefix)}${padVisibleCenter("USED", usedSpan)}`,
    [
      "    ",
      padEndVisible("NAME", nameWidth),
      " ",
      padEndVisible("IDENTITY", identityWidth),
      " ",
      padEndVisible("PLAN", planWidth),
      " ",
      padStartVisible("SCORE", scoreWidth),
      showEtaColumn ? ` ${padStartVisible("ETA", WIDE_ETA_WIDTH)}` : "",
      " ",
      padVisibleCenter("5H", fiveHourWidth),
      " ",
      padVisibleCenter("1W", oneWeekWidth),
      " ",
      padEndVisible("NEXT RESET", resetWidth),
    ].join(""),
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
      repeat("-", oneWeekWidth),
      " ",
      repeat("-", resetWidth),
    ].join(""),
  ];
}

function renderWideListRow(
  account: AccountDashboardAccount,
  selected: boolean,
  columns: Pick<WideColumnWidths, "nameWidth" | "identityWidth" | "planWidth" | "scoreWidth" | "fiveHourWidth" | "oneWeekWidth" | "resetWidth">,
  showEtaColumn: boolean,
): string {
  const {
    nameWidth,
    identityWidth,
    planWidth,
    scoreWidth,
    fiveHourWidth,
    oneWeekWidth,
    resetWidth,
  } = columns;
  const displayName = displayAccountName(account);
  const line = [
    selected ? ">" : " ",
    account.current ? "*" : " ",
    account.proxyUpstreamActive ? "@" : " ",
    " ",
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
    padStartVisible(account.oneWeekLabel, oneWeekWidth),
    " ",
    padEndVisible(truncate(account.nextResetLabel, resetWidth), resetWidth),
  ].join("");

  return styleListLine(line, account, selected);
}

function renderCompactListRow(
  account: AccountDashboardAccount,
  selected: boolean,
  width: number,
  showEtaColumn: boolean,
): string[] {
  const includePlan = width >= 64 && account.planLabel !== "";
  const includeIdentity = width >= 64 && account.identityLabel !== "";
  const includeReset = width >= 58;
  const firstFixedWidth =
    3 + 1 + 1 + 1 +
    (includePlan ? 1 + WIDE_PLAN_MAX_WIDTH : 0) +
    1 + WIDE_SCORE_MAX_WIDTH +
    (showEtaColumn ? 1 + WIDE_ETA_WIDTH : 0);
  const nameWidth = Math.max(8, width - firstFixedWidth);
  const displayName = displayAccountName(account);
  const firstLine = [
    selected ? ">" : " ",
    account.current ? "*" : " ",
    account.proxyUpstreamActive ? "@" : " ",
    " ",
    padEndVisible(truncate(displayName, nameWidth), nameWidth),
    includePlan ? ` ${padEndVisible(truncate(account.planLabel, WIDE_PLAN_MAX_WIDTH), WIDE_PLAN_MAX_WIDTH)}` : "",
    " ",
    padStartVisible(account.scoreLabel, WIDE_SCORE_MAX_WIDTH),
    showEtaColumn ? ` ${padStartVisible(account.etaLabel, WIDE_ETA_WIDTH)}` : "",
  ].join("");

  const secondSegments = [
    includeIdentity ? compactIdentity(account.identityLabel, Math.max(8, Math.min(24, Math.floor(width / 3)))) : null,
    `5H ${account.fiveHourLabel}`,
    `1W ${account.oneWeekLabel}`,
    includeReset ? account.nextResetLabel : null,
  ].filter((segment): segment is string => segment !== null);
  const secondLine = `    ${truncate(secondSegments.join(" | "), Math.max(0, width - 4))}`;

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
  const proxySelected = selectedAccount?.authModeLabel === "proxy";
  const hint = proxySelected
    ? width < 92
      ? `Enter | a auto | ${forceLabel} | o run | O iso | d desk | D rel | q quit`
      : width < 132
        ? `/ filter | Enter | a auto | ${forceLabel} | o run | O iso | d desk | D rel | i imp | q quit`
        : `j/k move | / filter | Enter | a auto | ${forceLabel} | o run | O iso | d desk | D relaunch | i imp | r refresh | q quit`
    : width < 92
      ? `Enter | a auto | ${forceLabel} | p prot | o run | O iso | d desk | D rel | q quit`
      : width < 132
        ? `/ filter | Enter | a auto | ${forceLabel} | p prot | o run | O iso | d desk | D rel | e/E exp | i imp | x del | u undo | q quit`
        : `j/k move | / filter | Enter | a auto | ${forceLabel} | p prot | o run | O iso | d desk | D relaunch | e/E exp | i imp | x del | u undo | r refresh | q quit`;
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

function resolvePreferredSelection(
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

function updateSnapshotCurrentIndicator(
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

function updateSnapshotProxyRouting(
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

function insertTextAtCursor(state: AccountDashboardState, value: string): AccountDashboardState {
  return {
    ...state,
    query: `${state.query.slice(0, state.cursor)}${value}${state.query.slice(state.cursor)}`,
    cursor: state.cursor + value.length,
    selected: 0,
    scrollTop: 0,
  };
}

function deleteTextBeforeCursor(state: AccountDashboardState): AccountDashboardState {
  if (state.cursor === 0) {
    return state;
  }

  return {
    ...state,
    query: `${state.query.slice(0, state.cursor - 1)}${state.query.slice(state.cursor)}`,
    cursor: state.cursor - 1,
    selected: 0,
    scrollTop: 0,
  };
}

function isPrintableInput(value: string): boolean {
  return value.length === 1 && value >= " " && value !== "\u007f";
}

function consumeInputBuffer(buffer: string): { events: InputEvent[]; rest: string } {
  const events: InputEvent[] = [];
  let index = 0;

  while (index < buffer.length) {
    const char = buffer[index];
    if (!char) {
      break;
    }

    if (char === "\u001b") {
      const sequence = buffer.slice(index, index + 3);
      if (sequence.startsWith("\u001b[")) {
        if (sequence.length < 3) {
          break;
        }
        const code = sequence[2];
        if (code === "A") {
          events.push({ value: sequence, name: "up" });
        } else if (code === "B") {
          events.push({ value: sequence, name: "down" });
        } else if (code === "C") {
          events.push({ value: sequence, name: "right" });
        } else if (code === "D") {
          events.push({ value: sequence, name: "left" });
        } else if (code === "H") {
          events.push({ value: sequence, name: "home" });
        } else if (code === "F") {
          events.push({ value: sequence, name: "end" });
        }
        index += 3;
        continue;
      }

      events.push({ value: char, name: "escape" });
      index += 1;
      continue;
    }

    if (char === "\u0003") {
      events.push({ value: char, name: "c", ctrl: true });
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      events.push({ value: char, name: "enter" });
      index += 1;
      if (char === "\r" && buffer[index] === "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "\u007f") {
      events.push({ value: char, name: "backspace" });
      index += 1;
      continue;
    }

    events.push({ value: char, name: char });
    index += 1;
  }

  return {
    events,
    rest: buffer.slice(index),
  };
}

function createPlaceholderSnapshot(): AccountDashboardSnapshot {
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

export async function runAccountDashboardTui(
  options: RunAccountDashboardTuiOptions,
): Promise<AccountDashboardExitResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signalSource = options.signalSource ?? process;
  const autoRefreshIntervalMs = options.autoRefreshIntervalMs ?? DEFAULT_AUTO_REFRESH_INTERVAL_MS;
  let snapshot = options.initialSnapshot ?? createPlaceholderSnapshot();
  let state = createInitialAccountDashboardState(options.initialQuery ?? "");
  let refreshing = false;
  let busyMessage: string | null = null;
  let startupWarningBanner: string | null = null;
  let cleanedUp = false;
  let resolved = false;
  let actionQueue = Promise.resolve();
  let inputBuffer = "";
  let refreshPromise: Promise<void> | null = null;
  let refreshQueued = false;
  let refreshPreferredName: string | null = null;
  let refreshAttemptCount = 0;
  let autoRefreshTimer: NodeJS.Timeout | null = null;
  let activeOperation: { controller: AbortController; label: string } | null = null;
  let promptState: PromptState | null = null;
  let confirmState: ConfirmState | null = null;
  let detailOverride: AccountDashboardDetailOverride | null = null;
  let undoAction: AccountDashboardUndoAction | null = null;
  let forceExitRequested = false;
  let unsubscribeExternalUpdates: (() => void) | null = null;
  const previousRawMode = stdin.isRaw === true;

  let resolveExit: ((result: AccountDashboardExitResult) => void) | null = null;
  const exitPromise = new Promise<AccountDashboardExitResult>((resolve) => {
    resolveExit = resolve;
  });

  const render = () => {
    if (cleanedUp) {
      return;
    }

    const footerOverride = promptState
      ? `${promptState.label} ${formatInteractiveQuery(promptState.value, promptState.cursor, true)}`
      : confirmState
        ? confirmState.kind === "delete"
          ? `confirm: Delete account "${confirmState.accountName}"? [y/N]`
          : confirmState.kind === "desktop-relaunch"
            ? `confirm: Relaunch Desktop for "${confirmState.accountName}"? May force-close non-codexm app. [y/N]`
            : `confirm: Stop stale codexm ${confirmState.conflict.kind} pid ${confirmState.conflict.pid} on ${confirmState.conflict.host}:${confirmState.conflict.port} and continue? [y/N]`
        : null;
    const hintOverride = promptState
      ? color("Enter confirm | Esc back | Ctrl-U clear | Ctrl-C quit", "dim")
      : confirmState
        ? color("y confirm | n cancel | Esc back | q quit", "dim")
        : null;
    const statusOverride = state.statusMessage
      ? null
      : promptState
        ? promptState.kind === "import-name"
          ? "Choose the local managed account name. Enter confirms; Esc goes back."
          : promptState.kind === "import-path"
            ? "Enter a bundle path to preview it. Enter confirms; Esc goes back."
            : "Enter an output path for the share bundle. Enter confirms; Esc goes back."
        : confirmState
          ? confirmState.kind === "delete"
            ? `Delete account "${confirmState.accountName}"? Press y to confirm.`
            : confirmState.kind === "desktop-relaunch"
              ? `Relaunch Desktop for "${confirmState.accountName}"? Press y to confirm.`
              : `Stop stale codexm ${confirmState.conflict.kind} process ${confirmState.conflict.pid} on ${confirmState.conflict.host}:${confirmState.conflict.port}? Press y to confirm.`
          : null;

    stdout.write(
      `${ANSI.clear}${ANSI.home}${renderAccountDashboardScreen({
        snapshot,
        state,
        width: stdout.columns ?? 80,
        height: stdout.rows ?? 24,
        busyMessage,
        refreshing,
        bannerMessage: startupWarningBanner,
        detailOverride,
        footerOverride,
        hintOverride,
        statusOverride,
      })}`,
    );
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (unsubscribeExternalUpdates) {
      unsubscribeExternalUpdates();
      unsubscribeExternalUpdates = null;
    }
    stdin.off("data", onData);
    stdout.off?.("resize", onResize);
    for (const { signal, handler } of signalHandlers) {
      signalSource.off(signal, handler);
    }
    void undoAction?.discard?.().catch(() => undefined);
    stdin.setRawMode?.(previousRawMode);
    stdin.pause();
    stdout.write(`${ANSI.showCursor}${ANSI.altOff}`);
  };

  const finish = (
    action: ExitAction,
    optionsForFinish: { preferredName?: string | null } = {},
  ) => {
    if (resolved) {
      return;
    }
    resolved = true;
    cleanup();
    resolveExit?.({
      code: 0,
      action,
      preferredName: optionsForFinish.preferredName,
    });
  };

  const handleProcessSignal = (_signal: NodeJS.Signals) => {
    forceExitRequested = true;
    activeOperation?.controller.abort();
    finish("quit");
  };

  const signalHandlers = EXIT_SIGNALS.map((signal) => {
    const handler = () => {
      handleProcessSignal(signal);
    };
    signalSource.on(signal, handler);
    return { signal, handler };
  });

  const requestRefresh = (preferredName: string | null = null) => {
    refreshQueued = true;
    if (preferredName) {
      refreshPreferredName = preferredName;
    }

    if (activeOperation || refreshPromise) {
      render();
      return;
    }

    refreshPromise = (async () => {
      while (refreshQueued && !cleanedUp) {
        refreshQueued = false;
        const preferred = refreshPreferredName;
        refreshPreferredName = null;
        const isInitialRefresh = refreshAttemptCount === 0;
        refreshAttemptCount += 1;
        refreshing = true;
        render();

        try {
          const nextSnapshot = await options.loadSnapshot();
          if (cleanedUp) {
            return;
          }

          const priorStatus = state.statusMessage;
          snapshot = nextSnapshot;
          startupWarningBanner = null;
          state = resolvePreferredSelection(snapshot, state, preferred);
          if (priorStatus?.startsWith("Refresh failed:")) {
            state.statusMessage = null;
          }
        } catch (error) {
          if (!cleanedUp) {
            const message = (error as Error).message;
            if (isInitialRefresh && options.initialSnapshot) {
              startupWarningBanner = `Initial refresh failed: ${message}`;
            } else {
              state = {
                ...state,
                statusMessage: `Refresh failed: ${message}`,
              };
            }
          }
        } finally {
          refreshing = false;
          if (cleanedUp) {
            refreshPromise = null;
          }
          render();
        }
      }

      refreshPromise = null;
    })().catch((error) => {
      refreshing = false;
      refreshPromise = null;
      if (!cleanedUp) {
        state = {
          ...state,
          statusMessage: `Refresh failed: ${(error as Error).message}`,
        };
        render();
      }
    });
  };

  const setUndoAction = (nextUndo: AccountDashboardUndoAction | undefined) => {
    if (undoAction && undoAction !== nextUndo) {
      void undoAction.discard?.().catch(() => undefined);
    }
    undoAction = nextUndo ?? null;
  };

  const applyExternalUpdate = (update: AccountDashboardExternalUpdate) => {
    if (cleanedUp) {
      return;
    }

    if (typeof update.statusMessage === "string" && update.statusMessage !== "") {
      state = {
        ...state,
        statusMessage: update.statusMessage,
      };
    }

    if ("preferredName" in update) {
      requestRefresh(update.preferredName ?? null);
      return;
    }

    if (update.refresh) {
      requestRefresh();
      return;
    }

    render();
  };

  const resolveActionStatus = (result: AccountDashboardActionResult, fallback: string): string => {
    const base = result.statusMessage ?? fallback;
    const withWarning = result.warningMessages?.length
      ? `${base} Warning: ${result.warningMessages[0]}`
      : base;
    return result.undo ? `${withWarning} Press u to undo.` : withWarning;
  };

  const runSimpleAction = async (
    label: string,
    run: () => Promise<AccountDashboardActionResult>,
  ) => {
    busyMessage = label;
    render();

    try {
      const result = await run();
      setUndoAction(result.undo);
      state = {
        ...state,
        statusMessage: resolveActionStatus(result, label),
      };
      if (typeof result.preferredName === "string") {
        requestRefresh(result.preferredName);
      } else if (result.preferredName === null) {
        requestRefresh();
      }
    } catch (error) {
      state = {
        ...state,
        statusMessage: `${label} failed: ${(error as Error).message}`,
      };
    } finally {
      busyMessage = null;
      render();
    }
  };

  const moveSelection = (delta: number) => {
    const filtered = getFilteredAccounts(snapshot, state.query);
    if (filtered.length === 0) {
      return;
    }
    state = {
      ...state,
      selected: clamp(state.selected + delta, 0, filtered.length - 1),
    };
  };

  const onResize = () => {
    render();
  };

  const handleFilterKeypress = async (event: InputEvent) => {
    if (event.name === "escape") {
      state = {
        ...state,
        filterActive: false,
      };
      render();
      return;
    }
    if (event.name === "enter") {
      state = {
        ...state,
        filterActive: false,
      };
      render();
      return;
    }
    if (event.name === "backspace") {
      state = deleteTextBeforeCursor(state);
      render();
      return;
    }
    if (event.ctrl && event.name === "u") {
      state = {
        ...state,
        query: "",
        cursor: 0,
        selected: 0,
        scrollTop: 0,
      };
      render();
      return;
    }
    if (event.name === "left") {
      state = {
        ...state,
        cursor: clamp(state.cursor - 1, 0, state.query.length),
      };
      render();
      return;
    }
    if (event.name === "right") {
      state = {
        ...state,
        cursor: clamp(state.cursor + 1, 0, state.query.length),
      };
      render();
      return;
    }
    if (isPrintableInput(event.value)) {
      state = insertTextAtCursor(state, event.value);
      render();
    }
  };

  const withOperationStatus = (
    accountName: string,
    result: { statusMessage?: string; warningMessages?: string[] },
    baseOverride?: string,
  ): string => {
    const base = baseOverride ?? result.statusMessage ?? `Switched to "${accountName}".`;
    return result.warningMessages?.length
      ? `${base} Warning: ${result.warningMessages[0]}`
      : base;
  };

  const runDesktopAction = async (
    name: string,
    optionsForAction: { forceRelaunch?: boolean } = {},
  ) => {
    if (!options.openDesktop) {
      state = {
        ...state,
        statusMessage: "Desktop open is unavailable in this session.",
      };
      render();
      return;
    }

    busyMessage = optionsForAction.forceRelaunch
      ? `Relaunching Codex Desktop for "${name}"...`
      : `Opening Codex Desktop for "${name}"...`;
    render();

    const result = await options.openDesktop(name, optionsForAction);
    state = {
      ...state,
      statusMessage: withOperationStatus(name, result),
    };
    render();
  };

  const runSwitchAction = async (optionsForAction: {
    force: boolean;
    after: ExitAction | "desktop" | "desktop-force" | null;
  }) => {
    const filtered = getFilteredAccounts(snapshot, state.query);
    const selected = filtered[state.selected] ?? null;
    if (!selected) {
      return;
    }

    const reloadingCurrentAccount =
      selected.current && optionsForAction.force && optionsForAction.after === null;
    const togglingProxy =
      selected.authModeLabel === "proxy" && optionsForAction.after === null && !reloadingCurrentAccount;

    if (selected.current && !reloadingCurrentAccount && !togglingProxy) {
      if (optionsForAction.after === "open-codex") {
        finish("open-codex", {
          preferredName: selected.name,
        });
        return;
      }
      if (optionsForAction.after === "open-isolated-codex") {
        finish("open-isolated-codex", {
          preferredName: selected.name,
        });
        return;
      }
      if (optionsForAction.after === "desktop") {
        await runDesktopAction(selected.name);
        requestRefresh(selected.name);
        return;
      }
      if (optionsForAction.after === "desktop-force") {
        await runDesktopAction(selected.name, { forceRelaunch: true });
        requestRefresh(selected.name);
        return;
      }

      state = {
        ...state,
        statusMessage: `"${selected.name}" is already current. Press f to reload it.`,
      };
      render();
      return;
    }

    const controller = new AbortController();
    activeOperation = {
      controller,
      label: reloadingCurrentAccount
        ? `reloading "${selected.name}"`
        : togglingProxy
          ? selected.current
            ? "disabling proxy"
            : "enabling proxy"
        : optionsForAction.after === "open-codex"
        ? `opening Codex TUI for "${selected.name}"`
        : optionsForAction.after === "open-isolated-codex"
          ? `opening isolated Codex TUI for "${selected.name}"`
        : optionsForAction.after === "desktop"
          ? `opening Codex Desktop for "${selected.name}"`
        : optionsForAction.after === "desktop-force"
          ? `relaunching Codex Desktop for "${selected.name}"`
          : `switching "${selected.name}"`,
    };
    busyMessage = reloadingCurrentAccount
      ? `Reloading "${selected.name}"...`
      : togglingProxy
        ? selected.current
          ? "Disabling proxy..."
          : "Enabling proxy..."
      : optionsForAction.after === "open-codex"
      ? `Switching to "${selected.name}" and opening Codex TUI...`
      : optionsForAction.after === "open-isolated-codex"
        ? `Switching to "${selected.name}" and opening isolated Codex TUI...`
      : optionsForAction.after === "desktop"
        ? `Switching to "${selected.name}" and opening Codex Desktop...`
      : optionsForAction.after === "desktop-force"
        ? `Switching to "${selected.name}" and relaunching Codex Desktop...`
        : optionsForAction.force
          ? `Force-switching to "${selected.name}"...`
          : `Switching to "${selected.name}"...`;
    render();

    try {
      const result = await options.switchAccount(selected.name, {
        force: optionsForAction.force,
        signal: controller.signal,
        onStatusMessage: (message) => {
          busyMessage = message;
          render();
        },
      });

      state = {
        ...state,
        statusMessage: withOperationStatus(
          selected.name,
          result,
          reloadingCurrentAccount ? `Reloaded "${selected.name}".` : undefined,
        ),
      };
      const currentName = result.currentName ?? selected.name;
      snapshot = updateSnapshotCurrentIndicator(snapshot, currentName);
      snapshot = updateSnapshotProxyRouting(snapshot, {
        proxyUpstreamName: result.proxyUpstreamName,
        proxyLastUpstreamLabel: result.proxyLastUpstreamLabel,
      });
      state = resolvePreferredSelection(snapshot, state, selected.name);

      if (optionsForAction.after === "open-codex") {
        render();
        finish("open-codex", {
          preferredName: selected.name,
        });
        return;
      }

      if (optionsForAction.after === "open-isolated-codex") {
        render();
        finish("open-isolated-codex", {
          preferredName: selected.name,
        });
        return;
      }

      if (optionsForAction.after === "desktop") {
        await runDesktopAction(selected.name);
        requestRefresh(selected.name);
        return;
      }
      if (optionsForAction.after === "desktop-force") {
        await runDesktopAction(selected.name, { forceRelaunch: true });
        requestRefresh(selected.name);
        return;
      }

      requestRefresh(selected.name);
    } catch (error) {
      if (
        error instanceof StaleDaemonProcessError
        && options.cleanupStaleDaemonProcess
      ) {
        confirmState = {
          kind: "cleanup-stale-daemon",
          accountName: selected.name,
          conflict: error.conflict,
          retry: optionsForAction,
        };
        state = {
          ...state,
          statusMessage: null,
        };
        return;
      }

      state = {
        ...state,
        statusMessage: optionsForAction.after === "desktop" || optionsForAction.after === "desktop-force"
          ? `Desktop open failed: ${(error as Error).message}`
          : optionsForAction.after === "open-codex"
            ? `Codex TUI open failed: ${(error as Error).message}`
            : optionsForAction.after === "open-isolated-codex"
              ? `Isolated Codex TUI open failed: ${(error as Error).message}`
            : reloadingCurrentAccount
              ? `Reload failed: ${(error as Error).message}`
            : `Switch failed: ${(error as Error).message}`,
      };
    } finally {
      busyMessage = null;
      activeOperation = null;
      render();
      if (refreshQueued && !refreshPromise && !cleanedUp) {
        requestRefresh();
      }
    }
  };

  const beginExportPrompt = (source: AccountDashboardExportSource) => {
    if (!options.exportAccount) {
      state = {
        ...state,
        statusMessage: "Export is unavailable in this session.",
      };
      render();
      return;
    }

    detailOverride = null;
    promptState = {
      kind: "export",
      label: "Export to file:",
      value: buildDefaultExportPath(source),
      cursor: buildDefaultExportPath(source).length,
      source,
    };
    render();
  };

  const beginImportPrompt = () => {
    if (!options.inspectImportBundle || !options.importBundle) {
      state = {
        ...state,
        statusMessage: "Import is unavailable in this session.",
      };
      render();
      return;
    }

    promptState = {
      kind: "import-path",
      label: "Bundle path:",
      value: "",
      cursor: 0,
    };
    detailOverride = null;
    render();
  };

  const beginDeleteConfirm = () => {
    if (!options.deleteAccount) {
      state = {
        ...state,
        statusMessage: "Delete is unavailable in this session.",
      };
      render();
      return;
    }

    const filtered = getFilteredAccounts(snapshot, state.query);
    const selected = filtered[state.selected] ?? null;
    if (!selected) {
      return;
    }

    confirmState = {
      kind: "delete",
      accountName: selected.name,
    };
    detailOverride = null;
    render();
  };

  const beginDesktopRelaunchConfirm = () => {
    if (!options.openDesktop) {
      state = {
        ...state,
        statusMessage: "Desktop open is unavailable in this session.",
      };
      render();
      return;
    }

    const filtered = getFilteredAccounts(snapshot, state.query);
    const selected = filtered[state.selected] ?? null;
    if (!selected) {
      return;
    }

    confirmState = {
      kind: "desktop-relaunch",
      accountName: selected.name,
    };
    detailOverride = null;
    render();
  };

  const handlePromptKeypress = async (event: InputEvent): Promise<void> => {
    if (!promptState) {
      return;
    }

    if (event.name === "escape") {
      if (promptState.kind === "import-name") {
        promptState = {
          kind: "import-path",
          label: "Bundle path:",
          value: promptState.bundlePath,
          cursor: promptState.bundlePath.length,
        };
      } else {
        promptState = null;
        detailOverride = null;
      }
      render();
      return;
    }

    if (event.name === "enter") {
      if (promptState.kind === "export") {
        const { source, value } = promptState;
        if (!value.trim()) {
          state = {
            ...state,
            statusMessage: "Output path is required.",
          };
          render();
          return;
        }
        promptState = null;
        await runSimpleAction("Export", async () =>
          await options.exportAccount!(source, value),
        );
        return;
      }

      if (promptState.kind === "import-path") {
        const bundlePath = promptState.value.trim();
        if (!bundlePath) {
          state = {
            ...state,
            statusMessage: "Bundle path is required.",
          };
          render();
          return;
        }

        try {
          const preview = await options.inspectImportBundle!(bundlePath);
          detailOverride = {
            title: preview.title,
            lines: preview.lines,
          };
          promptState = {
            kind: "import-name",
            label: "Save as name:",
            value: "",
            cursor: 0,
            bundlePath,
            preview,
          };
        } catch (error) {
          state = {
            ...state,
            statusMessage: `Preview failed: ${(error as Error).message}`,
          };
        }
        render();
        return;
      }

      const localName = promptState.value.trim();
      if (!localName) {
        state = {
          ...state,
          statusMessage: "Local account name is required.",
        };
        render();
        return;
      }

      const bundlePath = promptState.bundlePath;
      promptState = null;
      await runSimpleAction("Import", async () =>
        await options.importBundle!(bundlePath, localName),
      );
      detailOverride = null;
      return;
    }

    if (event.name === "backspace") {
      promptState = {
        ...promptState,
        value: `${promptState.value.slice(0, Math.max(0, promptState.cursor - 1))}${promptState.value.slice(promptState.cursor)}`,
        cursor: Math.max(0, promptState.cursor - 1),
      };
      render();
      return;
    }

    if (event.ctrl && event.name === "u") {
      promptState = {
        ...promptState,
        value: "",
        cursor: 0,
      };
      render();
      return;
    }

    if (event.name === "left") {
      promptState = {
        ...promptState,
        cursor: clamp(promptState.cursor - 1, 0, promptState.value.length),
      };
      render();
      return;
    }

    if (event.name === "right") {
      promptState = {
        ...promptState,
        cursor: clamp(promptState.cursor + 1, 0, promptState.value.length),
      };
      render();
      return;
    }

    if (isPrintableInput(event.value)) {
      promptState = {
        ...promptState,
        value: `${promptState.value.slice(0, promptState.cursor)}${event.value}${promptState.value.slice(promptState.cursor)}`,
        cursor: promptState.cursor + event.value.length,
      };
      render();
    }
  };

  const handleConfirmKeypress = async (event: InputEvent): Promise<void> => {
    if (!confirmState) {
      return;
    }

    if (event.name === "escape" || event.name === "n" || event.name === "enter") {
      confirmState = null;
      render();
      return;
    }

    if (event.name === "q" || (event.ctrl && event.name === "c")) {
      finish("quit");
      return;
    }

    if (event.name !== "y") {
      return;
    }

    const activeConfirm = confirmState;
    const accountName = activeConfirm.accountName;
    const confirmKind = activeConfirm.kind;
    confirmState = null;
    if (confirmKind === "delete") {
      await runSimpleAction("Delete", async () =>
        await options.deleteAccount!(accountName),
      );
      return;
    }

    if (confirmKind === "cleanup-stale-daemon") {
      if (!options.cleanupStaleDaemonProcess) {
        state = {
          ...state,
          statusMessage: "Stale daemon cleanup is unavailable in this session.",
        };
        render();
        return;
      }

      busyMessage =
        `Stopping stale codexm ${activeConfirm.conflict.kind} process ${activeConfirm.conflict.pid}...`;
      render();

      try {
        await options.cleanupStaleDaemonProcess(activeConfirm.conflict);
        state = {
          ...state,
          statusMessage:
            `Stopped stale codexm ${activeConfirm.conflict.kind} process ${activeConfirm.conflict.pid}. Retrying...`,
        };
        render();
        await runSwitchAction(activeConfirm.retry);
      } catch (error) {
        busyMessage = null;
        state = {
          ...state,
          statusMessage: `Cleanup failed: ${(error as Error).message}`,
        };
        render();
      }
      return;
    }

    const filtered = getFilteredAccounts(snapshot, state.query);
    const selectedIndex = filtered.findIndex((account) => account.name === accountName);
    if (selectedIndex >= 0) {
      state = {
        ...state,
        selected: selectedIndex,
      };
    }
    await runSwitchAction({
      force: false,
      after: "desktop-force",
    });
  };

  const handleActiveOperationKeypress = (event: InputEvent): boolean => {
    if (!activeOperation) {
      return false;
    }

    if ((event.ctrl && event.name === "c") || event.name === "escape") {
      activeOperation.controller.abort();
      state = {
        ...state,
        statusMessage: `Cancelling ${activeOperation.label}...`,
      };
      render();
      return true;
    }

    if (event.name === "up" || event.name === "k") {
      moveSelection(-1);
      render();
      return true;
    }
    if (event.name === "down" || event.name === "j") {
      moveSelection(1);
      render();
      return true;
    }
    if (event.name === "home" || event.value === "g") {
      state = {
        ...state,
        selected: 0,
        scrollTop: 0,
      };
      render();
      return true;
    }
    if (event.name === "end" || event.value === "G") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      state = {
        ...state,
        selected: Math.max(0, filtered.length - 1),
      };
      render();
      return true;
    }

    if (event.name === "q") {
      state = {
        ...state,
        statusMessage: `Busy. Press Esc or Ctrl-C to cancel ${activeOperation.label}.`,
      };
      render();
      return true;
    }

    return true;
  };

  const handleBrowseKeypress = async (event: InputEvent): Promise<void> => {
    if (handleActiveOperationKeypress(event)) {
      return;
    }

    if ((event.ctrl && event.name === "c") || event.name === "q") {
      finish("quit");
      return;
    }
    if (event.name === "escape") {
      detailOverride = null;
      render();
      return;
    }
    if (event.name === "up" || event.name === "k") {
      moveSelection(-1);
      render();
      return;
    }
    if (event.name === "down" || event.name === "j") {
      moveSelection(1);
      render();
      return;
    }
    if (event.name === "home" || event.value === "g") {
      state = {
        ...state,
        selected: 0,
        scrollTop: 0,
      };
      render();
      return;
    }
    if (event.name === "end" || event.value === "G") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      state = {
        ...state,
        selected: Math.max(0, filtered.length - 1),
      };
      render();
      return;
    }
    if (event.value === "/") {
      state = {
        ...state,
        filterActive: true,
        cursor: state.query.length,
      };
      render();
      return;
    }
    if (event.value === "r") {
      void options.triggerBackgroundRefresh?.({
        ensureDaemon: true,
        source: "tui-manual-refresh",
      }).catch(() => undefined);
      requestRefresh();
      return;
    }
    if (event.value === "a") {
      if (!options.toggleAutoswitch) {
        state = {
          ...state,
          statusMessage: "Autoswitch toggle is unavailable in this session.",
        };
        render();
        return;
      }

      await runSimpleAction("Autoswitch", async () => await options.toggleAutoswitch!());
      return;
    }
    if (event.value === "e") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      const selected = filtered[state.selected] ?? null;
      if (!selected) {
        return;
      }
      if (selected.authModeLabel === "proxy") {
        state = {
          ...state,
          statusMessage: "Proxy export is unavailable.",
        };
        render();
        return;
      }
      beginExportPrompt({
        type: "managed",
        name: selected.name,
      });
      return;
    }
    if (event.value === "E") {
      beginExportPrompt({
        type: "current",
        name: null,
      });
      return;
    }
    if (event.value === "i") {
      beginImportPrompt();
      return;
    }
    if (event.value === "x") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      const selected = filtered[state.selected] ?? null;
      if (selected?.authModeLabel === "proxy") {
        state = {
          ...state,
          statusMessage: "Proxy delete is unavailable.",
        };
        render();
        return;
      }
      beginDeleteConfirm();
      return;
    }
    if (event.value === "u") {
      if (!undoAction) {
        state = {
          ...state,
          statusMessage: "Nothing to undo.",
        };
        render();
        return;
      }

      const currentUndo = undoAction;
      undoAction = null;
      await runSimpleAction("Undo", async () => await currentUndo.run());
      return;
    }
    if (event.value === "p") {
      if (!options.toggleAutoSwitchProtection) {
        state = {
          ...state,
          statusMessage: "Protection toggle is unavailable in this session.",
        };
        render();
        return;
      }

      const filtered = getFilteredAccounts(snapshot, state.query);
      const selected = filtered[state.selected] ?? null;
      if (!selected) {
        return;
      }
      if (selected.authModeLabel === "proxy") {
        state = {
          ...state,
          statusMessage: "Proxy protection toggle is unavailable.",
        };
        render();
        return;
      }

      await runSimpleAction("Protection", async () =>
        await options.toggleAutoSwitchProtection!(
          selected.name,
          !selected.autoSwitchEligible,
        ));
      return;
    }
    if (event.value === "f") {
      await runSwitchAction({
        force: true,
        after: null,
      });
      return;
    }
    if (event.value === "o") {
      await runSwitchAction({
        force: false,
        after: "open-codex",
      });
      return;
    }
    if (event.value === "O") {
      await runSwitchAction({
        force: false,
        after: "open-isolated-codex",
      });
      return;
    }
    if (event.value === "d") {
      await runSwitchAction({
        force: false,
        after: "desktop",
      });
      return;
    }
    if (event.value === "D") {
      beginDesktopRelaunchConfirm();
      return;
    }
    if (event.name === "enter") {
      await runSwitchAction({
        force: false,
        after: null,
      });
    }
  };

  const onData = (chunk: Buffer | string) => {
    inputBuffer += chunk.toString();
    const { events, rest } = consumeInputBuffer(inputBuffer);
    inputBuffer = rest;

    for (const event of events) {
      if (!promptState && !confirmState && !state.filterActive && activeOperation) {
        handleActiveOperationKeypress(event);
        continue;
      }

      actionQueue = actionQueue
        .then(async () => {
          if (cleanedUp) {
            return;
          }

          if (promptState) {
            await handlePromptKeypress(event);
            return;
          }

          if (confirmState) {
            await handleConfirmKeypress(event);
            return;
          }

          if (state.filterActive) {
            await handleFilterKeypress(event);
            return;
          }

          await handleBrowseKeypress(event);
        })
        .catch((error) => {
          busyMessage = null;
          activeOperation = null;
          state = {
            ...state,
            statusMessage: `TUI error: ${(error as Error).message}`,
          };
          render();
        });
    }
  };

  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(`${ANSI.altOn}${ANSI.hideCursor}`);
  stdout.on?.("resize", onResize);
  stdin.on("data", onData);
  if (options.subscribeExternalUpdates) {
    unsubscribeExternalUpdates = options.subscribeExternalUpdates((update) => {
      actionQueue = actionQueue
        .then(async () => {
          applyExternalUpdate(update);
        })
        .catch((error) => {
          busyMessage = null;
          activeOperation = null;
          state = {
            ...state,
            statusMessage: `TUI error: ${(error as Error).message}`,
          };
          render();
        });
    });
  }

  if (typeof autoRefreshIntervalMs === "number" && autoRefreshIntervalMs > 0) {
    autoRefreshTimer = setInterval(() => {
      if (cleanedUp || activeOperation) {
        return;
      }
      requestRefresh();
    }, autoRefreshIntervalMs);
  }

  render();
  requestRefresh();

  const settlePendingWork = async () => {
    await actionQueue.catch(() => undefined);
    while (refreshPromise) {
      const pendingRefresh = refreshPromise;
      await pendingRefresh.catch(() => undefined);
      if (refreshPromise === pendingRefresh) {
        break;
      }
    }
  };

  let exitResult: AccountDashboardExitResult;
  try {
    exitResult = await exitPromise;
  } finally {
    cleanup();
    if (!forceExitRequested) {
      await settlePendingWork();
    }
  }

  return exitResult;
}
