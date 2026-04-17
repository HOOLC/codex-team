import { watch } from "node:fs";
import { PassThrough } from "node:stream";

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { maskAccountId } from "../auth-snapshot.js";
import { type AccountStore, type AccountQuotaSummary, type ManagedAccount } from "../account-store/index.js";
import {
  buildReasonLabel,
  colorizeReason,
  colorizeRefreshStatus,
  colorizeScore,
  deriveAvailability,
  formatBottleneck,
  formatEtaLabel,
  formatEtaSummary,
  formatRawScore,
  formatRemainingPercent,
  formatResetAt,
  formatUsagePercent,
  isWindowUnavailable,
  normalizePlusScore,
  orderListAccounts,
  toQuotaEtaSummary,
} from "../cli/quota-display.js";
import { buildListSummary } from "../cli/quota-summary.js";
import { selectCurrentNextResetWindow, toAutoSwitchCandidate } from "../cli/quota-ranking.js";
import { type CodexDesktopLauncher } from "../desktop/launcher.js";
import {
  isOnlyManagedDesktopInstanceRunning,
  resolveManagedDesktopState,
} from "../desktop/managed-state.js";
import { getPlatform } from "../platform.js";
import type { WatchProcessManager } from "../watch/process.js";
import type { WatchLeaseManager } from "../watch/lease.js";
import {
  computeWatchHistoryEta,
  createWatchHistoryStore,
  filterWatchHistoryByScope,
  type WatchHistoryEtaContext,
} from "../watch/history.js";
import { LocalUsageService } from "../local-usage/service.js";
import {
  readLocalUsageSummaryCache,
  writeLocalUsageSummaryCache,
} from "../local-usage/summary-cache.js";
import {
  runAccountDashboardTui,
  type AccountDashboardExternalUpdate,
  type AccountDashboardSnapshot,
} from "../tui/index.js";
import { performManualSwitch } from "./switch.js";
import { getUsage } from "../cli/spec.js";
import { type RunnerOptions, type RunnerResult } from "../codex-cli-runner.js";
import {
  deleteAccountForTui,
  exportShareBundleForTui,
  importShareBundleForTui,
  previewShareBundleForTui,
} from "./tui-share.js";
import {
  createAccountDashboardExternalUpdateFeed,
  resolveCurrentManagedAccountLabel,
  runDashboardCodexSession,
  runDashboardIsolatedCodexSession,
  startTuiExternalUpdateMonitors,
  type CliStreams,
  type DebugLogger,
} from "./tui-runtime.js";

dayjs.extend(utc);
dayjs.extend(timezone);


function describeCurrentListStatus(
  status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
): string {
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

function toWatchEtaTarget(account: AccountQuotaSummary) {
  return {
    plan_type: account.plan_type,
    available: deriveAvailability(account),
    five_hour: account.five_hour
      ? {
          used_percent: account.five_hour.used_percent,
          window_seconds: account.five_hour.window_seconds,
          reset_at: account.five_hour.reset_at ?? null,
        }
      : null,
    one_week: account.one_week
      ? {
          used_percent: account.one_week.used_percent,
          window_seconds: account.one_week.window_seconds,
          reset_at: account.one_week.reset_at ?? null,
        }
      : null,
  };
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return dayjs.utc(value).tz(dayjs.tz.guess()).format("YYYY-MM-DD HH:mm");
}

function formatClock(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return dayjs.utc(value).tz(dayjs.tz.guess()).format("HH:mm");
}

function formatRelativeOffsetCompact(offsetMs: number): string {
  const absMs = Math.abs(offsetMs);
  if (absMs < 60_000) {
    return "now";
  }

  const minutes = absMs / 60_000;
  if (minutes < 60) {
    return `${Math.max(1, Math.round(minutes))}m`;
  }

  const hours = absMs / 3_600_000;
  if (hours < 24) {
    const value = hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
    return `${value.replace(/\.0$/u, "")}h`;
  }

  const days = absMs / 86_400_000;
  const value = days < 10 ? days.toFixed(1) : String(Math.round(days));
  return `${value.replace(/\.0$/u, "")}d`;
}

function formatRelativeOffsetLabel(
  value: string | null | undefined,
  now: Date,
): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const compact = formatRelativeOffsetCompact(timestamp - now.getTime());
  if (compact === "now") {
    return "now";
  }

  return timestamp >= now.getTime() ? `in ${compact}` : `${compact} ago`;
}

function formatDateTimeWithRelative(
  value: string | null | undefined,
  now: Date,
): string {
  const absolute = formatDateTime(value);
  if (absolute === "-") {
    return absolute;
  }

  const relative = formatRelativeOffsetLabel(value, now);
  return relative ? `${absolute} (${relative})` : absolute;
}

function formatWindowResetForList(
  window: { reset_at?: string | null } | null | undefined,
  now: Date,
): string {
  if (!window?.reset_at) {
    return "-";
  }

  const timestamp = Date.parse(window.reset_at);
  if (Number.isNaN(timestamp)) {
    return "-";
  }

  if (timestamp <= now.getTime()) {
    return "now";
  }

  return formatRelativeOffsetCompact(timestamp - now.getTime());
}

function formatWindowResetForDetail(
  window: { reset_at?: string | null } | null | undefined,
  now: Date,
): string {
  if (!window?.reset_at) {
    return "-";
  }

  const absolute = dayjs.utc(window.reset_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm");
  const relative = formatRelativeOffsetLabel(window.reset_at, now);
  return relative ? `${absolute} (${relative})` : absolute;
}

function toQuotaSummary(account: ManagedAccount, refreshed: AccountQuotaSummary | null): AccountQuotaSummary {
  if (refreshed) {
    return refreshed;
  }

  return {
    name: account.name,
    account_id: account.account_id,
    user_id: account.user_id ?? null,
    identity: account.identity,
    plan_type: account.quota.plan_type ?? null,
    credits_balance: account.quota.credits_balance ?? null,
    status: account.quota.status,
    fetched_at: account.quota.fetched_at ?? null,
    error_message: account.quota.error_message ?? null,
    unlimited: account.quota.unlimited === true,
    five_hour: account.quota.five_hour ?? null,
    one_week: account.quota.one_week ?? null,
  };
}

function describeCurrentHeader(
  status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
  usableCount: number,
  totalCount: number,
  latestFetchedAt: string | null,
): string {
  const currentLabel = !status.exists
    ? "missing"
    : status.matched_accounts.length === 1
      ? status.matched_accounts[0]
      : status.matched_accounts.length > 1
        ? "multiple"
        : "unmanaged";

  return `codexm | current ${currentLabel} | ${usableCount}/${totalCount} usable | updated ${formatClock(latestFetchedAt)}`;
}

async function readWatchHistory(
  store: AccountStore,
  now: Date,
) {
  const watchHistoryStore = createWatchHistoryStore(store.paths.codexTeamDir);
  return filterWatchHistoryByScope(await watchHistoryStore.read(now), { kind: "global" });
}

async function loadFreshLocalUsageSummary(store: AccountStore) {
  const summary = await new LocalUsageService({
    homeDir: store.paths.homeDir,
  }).load();
  await writeLocalUsageSummaryCache(summary, store.paths.homeDir);
  return summary;
}

async function loadCachedLocalUsageSummary(store: AccountStore) {
  const cached = await readLocalUsageSummaryCache({
    homeDir: store.paths.homeDir,
  });
  if (cached) {
    return cached;
  }
  return await loadFreshLocalUsageSummary(store);
}

function buildAccountDetailLines(options: {
  account: AccountQuotaSummary;
  accountMeta: ManagedAccount | undefined;
  availabilityLabel: string;
  score: number | null;
  eta: WatchHistoryEtaContext | undefined;
  nextResetDetailLabel: string;
  reasonLabel: string;
  candidate: ReturnType<typeof toAutoSwitchCandidate>;
  now: Date;
}): string[] {
  const {
    account,
    accountMeta,
    availabilityLabel,
    score,
    eta,
    nextResetDetailLabel,
    reasonLabel,
    candidate,
    now,
  } = options;
  const etaSummary = toQuotaEtaSummary(eta);
  const maskedIdentity = maskAccountId(account.identity);
  const formattedScore = colorizeScore(formatRemainingPercent(score), score);
  const formattedFiveHour = formatUsagePercent(account.five_hour);
  const formattedOneWeek = formatUsagePercent(account.one_week);
  const formattedRefresh = colorizeRefreshStatus(account.status, account.status);
  const formattedReason = colorizeReason(reasonLabel, account.status);
  const score1h = candidate ? normalizePlusScore(candidate.score_1h) : null;
  const projectedOneWeek1h = candidate ? normalizePlusScore(candidate.projected_1w_1h) : null;

  return [
    `Email: ${accountMeta?.email ?? "-"}`,
    `Auth: ${accountMeta?.auth_mode ?? "-"}`,
    `Fetched: ${formatDateTime(account.fetched_at)}`,
    `Refresh: ${formattedRefresh}`,
    `Reason: ${formattedReason}`,
    "",
    `Identity: ${maskedIdentity}`,
    `Account: ${maskAccountId(account.account_id)}`,
    `User: ${account.user_id ? maskAccountId(account.user_id) : "-"}`,
    `Bottleneck: ${formatBottleneck(eta)}`,
    `Joined: ${formatDateTime(accountMeta?.created_at)}`,
    `Switched: ${formatDateTimeWithRelative(accountMeta?.last_switched_at ?? null, now)}`,
    "",
    `Score: ${formattedScore}`,
    `ETA: ${formatEtaLabel(eta)}`,
    `5H used: ${formattedFiveHour}`,
    `1W used: ${formattedOneWeek}`,
    `Next reset: ${nextResetDetailLabel}`,
    `Availability: ${availabilityLabel}`,
    "",
    `ETA 5H->1W: ${etaSummary ? formatEtaSummary({ ...etaSummary, hours: etaSummary.eta_5h_eq_1w_hours }) : "-"}`,
    `ETA 1W: ${etaSummary ? formatEtaSummary({ ...etaSummary, hours: etaSummary.eta_1w_hours }) : "-"}`,
    `Rate 1W units: ${etaSummary?.rate_1w_units_per_hour ?? "-"}`,
    `5H remain->1W: ${etaSummary?.remaining_5h_eq_1w ?? "-"}`,
    `1H score: ${colorizeScore(formatRemainingPercent(score1h), score1h)}`,
    `5H->1W 1H: ${candidate ? formatRawScore(candidate.projected_5h_in_1w_units_1h) : "-"}`,
    `1W 1H: ${colorizeScore(formatRemainingPercent(projectedOneWeek1h), projectedOneWeek1h)}`,
    `5H:1W: ${candidate ? String(candidate.five_hour_to_one_week_ratio) : "-"}`,
    `5H reset: ${formatResetAt(account.five_hour)}`,
    `1W reset: ${formatResetAt(account.one_week)}`,
  ];
}

function buildDashboardSnapshot(options: {
  accounts: ManagedAccount[];
  current: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>;
  summaryAccounts: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
  warnings: string[];
  watchHistory: Awaited<ReturnType<ReturnType<typeof createWatchHistoryStore>["read"]>>;
  usageSummary: Awaited<ReturnType<typeof loadFreshLocalUsageSummary>> | null;
  refreshedByName?: Map<string, AccountQuotaSummary>;
  debugLog?: DebugLogger;
}): AccountDashboardSnapshot {
  const allAccounts = options.accounts.map((account) =>
    toQuotaSummary(account, options.refreshedByName?.get(account.name) ?? null),
  );
  const now = new Date();
  const etaByName = new Map(
    allAccounts.map((account) => [
      account.name,
      computeWatchHistoryEta(options.watchHistory, toWatchEtaTarget(account), now),
    ] as const),
  );
  const showEtaColumn = allAccounts.some((account) => (
    formatEtaLabel(etaByName.get(account.name)) !== "-"
  ));
  const orderedAccounts = orderListAccounts(allAccounts);
  const currentAccounts = new Set(options.current.matched_accounts);
  const { summaryLine, poolLine } = buildListSummary(options.summaryAccounts);
  const latestFetchedAt = allAccounts
    .map((account) => account.fetched_at)
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const usableCount = allAccounts.filter((account) => deriveAvailability(account) === "available").length;
  const accountMetaByName = new Map(options.accounts.map((account) => [account.name, account] as const));

  options.debugLog?.(
    `tui: accounts=${allAccounts.length} failures=${options.failures.length} warnings=${options.warnings.length} current_matches=${options.current.matched_accounts.length} watch_history_samples=${options.watchHistory.length}`,
  );

  return {
    headerLine: describeCurrentHeader(options.current, usableCount, allAccounts.length, latestFetchedAt),
    currentStatusLine: describeCurrentListStatus(options.current),
    summaryLine,
    poolLine,
    usageSummary: options.usageSummary,
    showEtaColumn,
    warnings: options.warnings,
    failures: options.failures,
    accounts: orderedAccounts.map((account) => {
      const candidate = toAutoSwitchCandidate(account);
      const eta = etaByName.get(account.name);
      const score = candidate ? normalizePlusScore(candidate.current_score) : null;
      const nextResetWindow = candidate ? selectCurrentNextResetWindow(account, candidate) : null;
      const nextResetLabel = formatWindowResetForList(nextResetWindow, now);
      const nextResetDetailLabel = formatWindowResetForDetail(nextResetWindow, now);
      const availabilityLabel = deriveAvailability(account);
      const reasonLabel = buildReasonLabel(account, eta);
      const accountMeta = accountMetaByName.get(account.name);

      return {
        name: account.name,
        planLabel: account.plan_type ?? "-",
        identityLabel: maskAccountId(account.identity),
        availabilityLabel,
        current: currentAccounts.has(account.name),
        score,
        scoreLabel: colorizeScore(formatRemainingPercent(score), score),
        etaLabel: formatEtaLabel(eta),
        nextResetLabel,
        fiveHourLabel: formatUsagePercent(account.five_hour),
        oneWeekLabel: formatUsagePercent(account.one_week),
        authModeLabel: accountMeta?.auth_mode ?? "-",
        emailLabel: accountMeta?.email ?? "-",
        accountIdLabel: maskAccountId(account.account_id),
        userIdLabel: account.user_id ? maskAccountId(account.user_id) : "-",
        joinedAtLabel: formatDateTime(accountMeta?.created_at),
        lastSwitchedAtLabel: formatDateTime(accountMeta?.last_switched_at ?? null),
        fetchedAtLabel: formatDateTime(account.fetched_at),
        refreshStatusLabel: account.status,
        bottleneckLabel: formatBottleneck(eta),
        reasonLabel,
        oneWeekBlocked: isWindowUnavailable(account.one_week),
        detailLines: buildAccountDetailLines({
          account,
          accountMeta,
          availabilityLabel,
          score,
          eta,
          nextResetDetailLabel,
          reasonLabel,
          candidate,
          now,
        }),
      };
    }),
  };
}

export async function buildAccountDashboardSnapshot(options: {
  store: AccountStore;
  debugLog?: DebugLogger;
}): Promise<AccountDashboardSnapshot> {
  const result = await options.store.refreshAllQuotas(undefined, {
    quotaClientMode: "list-fast",
    allowCachedQuotaFallback: true,
  });
  const { accounts, warnings: accountWarnings } = await options.store.listAccounts();
  const current = await options.store.getCurrentStatus();
  const watchHistory = await readWatchHistory(options.store, new Date());
  const usageSummary = await loadFreshLocalUsageSummary(options.store);
  const refreshedByName = new Map(result.successes.map((account) => [account.name, account] as const));
  return buildDashboardSnapshot({
    accounts,
    current,
    summaryAccounts: result.successes,
    failures: result.failures,
    warnings: [...accountWarnings, ...result.warnings],
    watchHistory,
    usageSummary,
    refreshedByName,
    debugLog: options.debugLog,
  });
}

export async function buildCachedAccountDashboardSnapshot(options: {
  store: AccountStore;
  debugLog?: DebugLogger;
}): Promise<AccountDashboardSnapshot> {
  const { accounts, warnings } = await options.store.listAccounts();
  const current = await options.store.getCurrentStatus();
  const watchHistory = await readWatchHistory(options.store, new Date());
  const usageSummary = await loadCachedLocalUsageSummary(options.store);

  return buildDashboardSnapshot({
    accounts,
    current,
    summaryAccounts: accounts.map((account) => toQuotaSummary(account, null)),
    failures: [],
    warnings,
    watchHistory,
    usageSummary,
    debugLog: options.debugLog,
  });
}

export async function handleTuiCommand(options: {
  positionals: string[];
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  watchProcessManager: WatchProcessManager;
  watchLeaseManager?: WatchLeaseManager;
  streams: CliStreams;
  runCodexCli: (options: RunnerOptions) => Promise<RunnerResult>;
  debugLog?: DebugLogger;
  interruptSignal?: AbortSignal;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
  foregroundWatchLeasePollIntervalMs?: number;
  authWatchImpl?: typeof watch;
  runDashboardTuiImpl?: typeof runAccountDashboardTui;
  prepareIsolatedRunImpl?: Parameters<typeof runDashboardIsolatedCodexSession>[0]["prepareIsolatedRunImpl"];
  startIsolatedQuotaHistorySamplerImpl?: Parameters<typeof runDashboardIsolatedCodexSession>[0]["startIsolatedQuotaHistorySamplerImpl"];
}): Promise<number> {
  if (options.positionals.length > 1) {
    throw new Error(`Usage: ${getUsage("tui")}`);
  }

  const initialQuery = options.positionals[0] ?? "";
  if (!options.streams.stdin.isTTY || !options.streams.stdout.isTTY) {
    throw new Error(
      'codexm tui requires an interactive terminal. Use "codexm list" or "codexm list --json" instead.',
    );
  }

  const runDashboardTuiImpl = options.runDashboardTuiImpl ?? runAccountDashboardTui;
  let nextInitialQuery = initialQuery;
  let queuedExternalUpdate: AccountDashboardExternalUpdate | null = null;

  while (true) {
    const silentStatusStream = new PassThrough() as unknown as NodeJS.WriteStream;
    const initialSnapshot = await buildCachedAccountDashboardSnapshot({
      store: options.store,
      debugLog: options.debugLog,
    });
    const externalUpdateFeed = createAccountDashboardExternalUpdateFeed();
    if (queuedExternalUpdate) {
      externalUpdateFeed.emit(queuedExternalUpdate);
      queuedExternalUpdate = null;
    }
    const currentManagedAccountRef = {
      value: await resolveCurrentManagedAccountLabel(options.store),
    };
    const localSwitchInFlightRef = {
      value: false,
    };
    const externalUpdateMonitors = await startTuiExternalUpdateMonitors({
      store: options.store,
      desktopLauncher: options.desktopLauncher,
      watchProcessManager: options.watchProcessManager,
      watchLeaseManager: options.watchLeaseManager,
      updateFeed: externalUpdateFeed,
      currentManagedAccountRef,
      localSwitchInFlightRef,
      debugLog: options.debugLog,
      managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
      managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
      foregroundWatchLeasePollIntervalMs: options.foregroundWatchLeasePollIntervalMs,
      authWatchImpl: options.authWatchImpl,
    });

    let exit;
    try {
      exit = await runDashboardTuiImpl({
        stdin: options.streams.stdin,
        stdout: options.streams.stdout,
        initialQuery: nextInitialQuery,
        initialSnapshot,
        subscribeExternalUpdates: externalUpdateFeed.subscribe,
        loadSnapshot: async () => await buildAccountDashboardSnapshot({
          store: options.store,
          debugLog: options.debugLog,
        }),
        switchAccount: async (name, switchOptions) => {
          localSwitchInFlightRef.value = true;
          try {
            const { result, desktopForceWarning } = await performManualSwitch({
              name,
              force: switchOptions.force,
              store: options.store,
              desktopLauncher: options.desktopLauncher,
              stderr: silentStatusStream,
              debugLog: options.debugLog,
              interruptSignal: switchOptions.signal ?? options.interruptSignal,
              managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
              managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
            });
            currentManagedAccountRef.value = result.account.name;

            return {
              statusMessage: `Switched to "${result.account.name}".`,
              warningMessages: [
                ...result.warnings,
                ...(desktopForceWarning ? [desktopForceWarning] : []),
              ],
            };
          } finally {
            localSwitchInFlightRef.value = false;
          }
        },
        openDesktop: async (name, desktopOptions = {}) => {
          const appPath = await options.desktopLauncher.findInstalledApp();
          if (!appPath) {
            throw new Error("Codex Desktop not found at /Applications/Codex.app.");
          }

          const runningApps = await options.desktopLauncher.listRunningApps();
          if (runningApps.length > 0 && !desktopOptions.forceRelaunch) {
            await options.desktopLauncher.activateApp(appPath);
            const warnings = (await options.desktopLauncher.isManagedDesktopRunning())
              ? []
              : [
                  "Desktop is not codexm-managed; the focused app may still use its previous auth until relaunched.",
                ];

            return {
              statusMessage: `Focused Codex Desktop for "${name}".`,
              warningMessages: warnings,
            };
          }

          const platform = await getPlatform();
          if (runningApps.length > 0 && desktopOptions.forceRelaunch) {
            const managedDesktopState = await options.desktopLauncher.readManagedState();
            const canRelaunchGracefully = isOnlyManagedDesktopInstanceRunning(
              runningApps,
              managedDesktopState,
              platform,
            );
            await options.desktopLauncher.quitRunningApps({
              force: !canRelaunchGracefully,
            });
          }

          await options.desktopLauncher.launch(appPath);
          const managedState = await resolveManagedDesktopState(
            options.desktopLauncher,
            appPath,
            runningApps,
            platform,
          );
          if (!managedState) {
            await options.desktopLauncher.clearManagedState().catch(() => undefined);
            throw new Error(
              "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
            );
          }

          await options.desktopLauncher.writeManagedState(managedState);
          await externalUpdateMonitors.reconcileNow();
          return {
            statusMessage: runningApps.length > 0 && desktopOptions.forceRelaunch
              ? `Relaunched Codex Desktop for "${name}".`
              : `Opened Codex Desktop for "${name}".`,
            warningMessages: [],
          };
        },
        exportAccount: async (source, outputPath) =>
          await exportShareBundleForTui({
            store: options.store,
            source,
            outputPath,
          }),
        inspectImportBundle: async (bundlePath) =>
          await previewShareBundleForTui(bundlePath),
        importBundle: async (bundlePath, localName) =>
          await importShareBundleForTui({
            store: options.store,
            bundlePath,
            localName,
          }),
        deleteAccount: async (name) =>
          await deleteAccountForTui({
            store: options.store,
            name,
          }),
      });
    } finally {
      await externalUpdateMonitors.stop();
    }

    nextInitialQuery = "";

    if (exit.action === "quit") {
      return exit.code;
    }

    try {
      if (exit.action === "open-codex") {
        await runDashboardCodexSession({
          store: options.store,
          runCodexCli: options.runCodexCli,
          debugLog: options.debugLog,
          stderr: options.streams.stderr,
          signal: options.interruptSignal,
        });
        continue;
      }

      if (!exit.preferredName) {
        throw new Error("The selected account was unavailable for isolated codex launch.");
      }

      await runDashboardIsolatedCodexSession({
        accountName: exit.preferredName,
        store: options.store,
        runCodexCli: options.runCodexCli,
        debugLog: options.debugLog,
        stderr: options.streams.stderr,
        signal: options.interruptSignal,
        prepareIsolatedRunImpl: options.prepareIsolatedRunImpl,
        startIsolatedQuotaHistorySamplerImpl: options.startIsolatedQuotaHistorySamplerImpl,
      });
    } catch (error) {
      queuedExternalUpdate = {
        statusMessage: `Codex open failed: ${(error as Error).message}`,
        preferredName: exit.preferredName ?? null,
      };
    }
  }
}
