import type { LocalUsageSummary } from "../local-usage/types.js";
import type {
  StaleDaemonPortConflict,
} from "../daemon/process.js";

export type SignalSource = {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
};

export type ExitAction = "quit" | "open-codex" | "open-isolated-codex";

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
  fiveHourResetLabel: string;
  oneWeekLabel: string;
  oneWeekResetLabel: string;
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
