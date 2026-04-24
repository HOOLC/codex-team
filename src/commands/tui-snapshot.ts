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
  isAccountFullyUnavailable,
  normalizeAccountScore,
  orderListAccounts,
  toQuotaEtaSummary,
} from "../cli/quota-display.js";
import { buildListSummary } from "../cli/quota-summary.js";
import { selectCurrentNextResetWindow, toDisplayAutoSwitchCandidate } from "../cli/quota-ranking.js";
import { appendDaemonFeatureTags } from "../daemon/display.js";
import type { DaemonProcessManager } from "../daemon/process.js";
import { createDaemonProcessManager } from "../daemon/process.js";
import { triggerDaemonAuthRefresh } from "../daemon/trigger.js";
import { LocalUsageService } from "../local-usage/service.js";
import {
  readLocalUsageSummaryCache,
  writeLocalUsageSummaryCache,
} from "../local-usage/summary-cache.js";
import { PROXY_ACCOUNT_ID, PROXY_ACCOUNT_NAME, PROXY_EMAIL, PROXY_USER_ID } from "../proxy/constants.js";
import {
  formatProxyUpstreamSelectionLabel,
  readLatestProxyUpstreamSelection,
  type ProxyLastUpstreamSelection,
} from "../proxy/request-log.js";
import { buildProxyQuotaAggregate } from "../proxy/quota.js";
import { resolveProxyManualUpstreamAccountName } from "../proxy/runtime.js";
import { readProxyState } from "../proxy/state.js";
import {
  computeWatchHistoryEta,
  createWatchHistoryStore,
  filterWatchHistoryByScope,
  type WatchHistoryEtaContext,
} from "../watch/history.js";
import { type AccountDashboardSnapshot } from "../tui/index.js";
import type { DebugLogger } from "./tui-runtime.js";
import { summarizeAuthRepairAdvice } from "../auth-refresh.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function describeCurrentListStatus(
  status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
): string {
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
    : status.account_id === PROXY_ACCOUNT_ID
      ? "proxy"
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
  reasonLabel: string;
  candidate: ReturnType<typeof toDisplayAutoSwitchCandidate>;
  now: Date;
  proxyAggregate?: Awaited<ReturnType<typeof buildProxyQuotaAggregate>> | null;
  proxyLastUpstreamLabel?: string | null;
  proxyBaseUrl?: string | null;
  proxyOpenAIBaseUrl?: string | null;
}): string[] {
  const {
    account,
    accountMeta,
    availabilityLabel,
    score,
    eta,
    reasonLabel,
    candidate,
    now,
    proxyAggregate,
    proxyLastUpstreamLabel,
    proxyBaseUrl,
    proxyOpenAIBaseUrl,
  } = options;
  const etaSummary = toQuotaEtaSummary(eta);
  const formattedScore = colorizeScore(formatRemainingPercent(score), score);
  const formattedFiveHour = formatUsagePercent(account.five_hour);
  const formattedOneWeek = formatUsagePercent(account.one_week);
  const formattedRefresh = colorizeRefreshStatus(account.status, account.status);
  const formattedReason = colorizeReason(reasonLabel, account.status);
  const score1h = candidate ? normalizeAccountScore(candidate.score_1h, account, proxyAggregate) : null;
  const projectedOneWeek1h = candidate?.projected_1w_1h ?? null;
  const isProxyAccount = accountMeta?.auth_mode === "proxy";

  const lines = [
    `Email: ${accountMeta?.email ?? "-"}`,
    `Auth: ${accountMeta?.auth_mode ?? "-"}`,
    `Fetched: ${formatDateTime(account.fetched_at)}`,
    `Refresh: ${formattedRefresh}`,
    `Reason: ${formattedReason}`,
    "",
    `Score: ${formattedScore}`,
    `ETA: ${formatEtaLabel(eta)}`,
    `5H used: ${formattedFiveHour}`,
    `1W used: ${formattedOneWeek}`,
    `5H reset: ${formatResetAt(account.five_hour)}`,
    `1W reset: ${formatResetAt(account.one_week)}`,
    `Availability: ${availabilityLabel}`,
  ];

  if (!isProxyAccount) {
    lines.push(
      "",
      `Identity: ${account.identity}`,
      `Account: ${account.account_id}`,
      `User: ${account.user_id ?? "-"}`,
      `Bottleneck: ${formatBottleneck(eta)}`,
      `Joined: ${formatDateTime(accountMeta?.created_at)}`,
      `Switched: ${formatDateTimeWithRelative(accountMeta?.last_switched_at ?? null, now)}`,
    );
  } else {
    lines.push(
      "",
      "Pool: auto-switch eligible accounts",
      ...(proxyBaseUrl ? [`ChatGPT: ${proxyBaseUrl}`] : []),
      ...(proxyOpenAIBaseUrl ? [`OpenAI: ${proxyOpenAIBaseUrl}`] : []),
      ...(proxyLastUpstreamLabel ? [`Last upstream: ${proxyLastUpstreamLabel}`] : []),
      `Bottleneck: ${formatBottleneck(eta)}`,
    );
  }

  lines.push(
    "",
    `ETA 5H->1W: ${etaSummary ? formatEtaSummary({ ...etaSummary, hours: etaSummary.eta_5h_eq_1w_hours }) : "-"}`,
    `ETA 1W: ${etaSummary ? formatEtaSummary({ ...etaSummary, hours: etaSummary.eta_1w_hours }) : "-"}`,
    `Rate 1W units: ${etaSummary?.rate_1w_units_per_hour ?? "-"}`,
    `5H remain->1W: ${etaSummary?.remaining_5h_eq_1w ?? "-"}`,
    `1H score: ${colorizeScore(formatRemainingPercent(score1h), score1h)}`,
    `5H->1W 1H: ${candidate ? formatRawScore(candidate.projected_5h_in_1w_units_1h) : "-"}`,
    `1W 1H: ${colorizeScore(formatRemainingPercent(projectedOneWeek1h), projectedOneWeek1h)}`,
    `5H:1W: ${candidate ? String(candidate.five_hour_to_one_week_ratio) : "-"}`,
  );

  return lines;
}

function buildDashboardSnapshot(options: {
  accounts: ManagedAccount[];
  current: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>;
  daemonStatus: Awaited<ReturnType<DaemonProcessManager["getStatus"]>>;
  failures: Array<{ name: string; error: string }>;
  warnings: string[];
  watchHistory: Awaited<ReturnType<ReturnType<typeof createWatchHistoryStore>["read"]>>;
  usageSummary: Awaited<ReturnType<typeof loadFreshLocalUsageSummary>> | null;
  refreshedByName?: Map<string, AccountQuotaSummary>;
  proxySummary?: AccountQuotaSummary | null;
  proxyAggregate?: Awaited<ReturnType<typeof buildProxyQuotaAggregate>> | null;
  proxyLastUpstream?: ProxyLastUpstreamSelection | null;
  proxyManualUpstreamName?: string | null;
  proxyBaseUrl?: string | null;
  proxyOpenAIBaseUrl?: string | null;
  debugLog?: DebugLogger;
}): AccountDashboardSnapshot {
  const allAccounts = options.accounts.map((account) =>
    toQuotaSummary(account, options.refreshedByName?.get(account.name) ?? null),
  );
  const displayAccounts = options.proxySummary
    ? [options.proxySummary, ...allAccounts]
    : allAccounts;
  const summaryAccounts = allAccounts;
  const now = new Date();
  const etaByName = new Map(
    displayAccounts.map((account) => [
      account.name,
      computeWatchHistoryEta(
        options.watchHistory,
        account.name === PROXY_ACCOUNT_NAME && options.proxyAggregate
          ? options.proxyAggregate.watchEtaTarget
          : toWatchEtaTarget(account),
        now,
      ),
    ] as const),
  );
  const showEtaColumn = displayAccounts.some((account) => (
    formatEtaLabel(etaByName.get(account.name)) !== "-"
  ));
  const orderedAccounts = options.proxySummary
    ? [options.proxySummary, ...orderListAccounts(allAccounts)]
    : orderListAccounts(allAccounts);
  const currentAccounts = new Set(options.current.matched_accounts);
  if (options.current.account_id === PROXY_ACCOUNT_ID) {
    currentAccounts.add(PROXY_ACCOUNT_NAME);
  }
  const { summaryLine, poolLine } = buildListSummary(summaryAccounts);
  const latestFetchedAt = displayAccounts
    .map((account) => account.fetched_at)
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const usableCount = summaryAccounts.filter((account) => deriveAvailability(account) === "available").length;
  const accountMetaByName = new Map(options.accounts.map((account) => [account.name, account] as const));
  const proxyUpstreamAccountName = options.proxyManualUpstreamName
    ?? options.proxyLastUpstream?.accountName
    ?? null;

  options.debugLog?.(
    `tui: accounts=${displayAccounts.length} proxy=${options.proxySummary ? "yes" : "no"} failures=${options.failures.length} warnings=${options.warnings.length} current_matches=${options.current.matched_accounts.length} watch_history_samples=${options.watchHistory.length}`,
  );

  return {
    headerLine: describeCurrentHeader(options.current, usableCount, summaryAccounts.length, latestFetchedAt),
    currentStatusLine: appendDaemonFeatureTags(describeCurrentListStatus(options.current), options.daemonStatus),
    summaryLine,
    poolLine,
    usageSummary: options.usageSummary,
    showEtaColumn,
    warnings: options.warnings,
    failures: options.failures,
    accounts: orderedAccounts.map((account) => {
      const candidate = toDisplayAutoSwitchCandidate(account, options.proxyAggregate);
      const eta = etaByName.get(account.name);
      const score = candidate ? normalizeAccountScore(candidate.current_score, account, options.proxyAggregate) : null;
      const nextResetWindow = candidate ? selectCurrentNextResetWindow(account, candidate) : null;
      const nextResetLabel = nextResetWindow ? formatResetAt(nextResetWindow) : "-";
      const availabilityLabel = deriveAvailability(account);
      const reasonLabel = buildReasonLabel(account, eta);
      const accountMeta = accountMetaByName.get(account.name);
      const isProxyAccount =
        account.name === PROXY_ACCOUNT_NAME && account.account_id === PROXY_ACCOUNT_ID;
      const proxyLastUpstreamLabel = isProxyAccount
        ? formatProxyUpstreamSelectionLabel(options.proxyLastUpstream, now)
        : null;
      const accountMetaForDetail = accountMeta ?? (isProxyAccount
        ? {
            name: PROXY_ACCOUNT_NAME,
            auth_mode: "proxy",
            account_id: PROXY_ACCOUNT_ID,
            user_id: PROXY_USER_ID,
            identity: account.identity,
            email: PROXY_EMAIL,
            created_at: "",
            updated_at: "",
            last_switched_at: null,
            quota: {
              status: account.status,
            },
            authPath: "",
            metaPath: "",
            configPath: null,
            duplicateAccountId: false,
            auto_switch_eligible: true,
          } satisfies ManagedAccount
        : undefined);

      return {
        name: account.name,
        autoSwitchEligible: account.auto_switch_eligible ?? true,
        planLabel: isProxyAccount ? "" : (account.plan_type ?? "-"),
        identityLabel: isProxyAccount ? "" : maskAccountId(account.identity),
        availabilityLabel,
        current: currentAccounts.has(account.name),
        score,
        scoreLabel: colorizeScore(formatRemainingPercent(score), score),
        etaLabel: formatEtaLabel(eta),
        nextResetLabel,
        fiveHourLabel: formatUsagePercent(account.five_hour),
        fiveHourResetLabel: formatResetAt(account.five_hour),
        oneWeekLabel: formatUsagePercent(account.one_week),
        oneWeekResetLabel: formatResetAt(account.one_week),
        authModeLabel: accountMetaForDetail?.auth_mode ?? "-",
        emailLabel: accountMetaForDetail?.email ?? "-",
        accountIdLabel: maskAccountId(account.account_id),
        userIdLabel: account.user_id ? maskAccountId(account.user_id) : "-",
        joinedAtLabel: formatDateTime(accountMetaForDetail?.created_at),
        lastSwitchedAtLabel: formatDateTime(accountMetaForDetail?.last_switched_at ?? null),
        fetchedAtLabel: formatDateTime(account.fetched_at),
        refreshStatusLabel: account.status,
        bottleneckLabel: formatBottleneck(eta),
        reasonLabel,
        proxyUpstreamActive: !isProxyAccount && proxyUpstreamAccountName === account.name,
        oneWeekBlocked: isAccountFullyUnavailable(account),
        proxyLastUpstreamLabel,
        detailLines: buildAccountDetailLines({
          account,
          accountMeta: accountMetaForDetail,
          availabilityLabel,
          score,
          eta,
          reasonLabel,
          candidate,
          now,
          proxyAggregate: options.proxyAggregate,
          proxyLastUpstreamLabel,
          proxyBaseUrl: options.proxyBaseUrl,
          proxyOpenAIBaseUrl: options.proxyOpenAIBaseUrl,
        }),
      };
    }),
  };
}

export async function buildAccountDashboardSnapshot(options: {
  store: AccountStore;
  daemonProcessManager?: DaemonProcessManager;
  debugLog?: DebugLogger;
}): Promise<AccountDashboardSnapshot> {
  const daemonProcessManager =
    options.daemonProcessManager ?? createDaemonProcessManager(options.store.paths.codexTeamDir);
  void triggerDaemonAuthRefresh({
    store: options.store,
    daemonProcessManager,
    ensureDaemon: false,
    source: "tui-refresh",
  }).catch((error) => {
    options.debugLog?.(`tui: failed to queue background auth refresh: ${(error as Error).message}`);
  });
  const result = await options.store.refreshAllQuotas(undefined, {
    quotaClientMode: "list-fast",
    allowCachedQuotaFallback: true,
  });
  const { accounts, warnings: accountWarnings } = await options.store.listAccounts();
  const current = await options.store.getCurrentStatus();
  const daemonStatus = await daemonProcessManager.getStatus();
  const proxyState = await readProxyState(options.store.paths.codexTeamDir);
  const watchHistory = await readWatchHistory(options.store, new Date());
  const usageSummary = await loadFreshLocalUsageSummary(options.store);
  const refreshedByName = new Map(result.successes.map((account) => [account.name, account] as const));
  const proxyAggregate = await buildProxyQuotaAggregate({
    store: options.store,
    includeWhenDisabled: true,
  });
  const proxyManualUpstreamName = proxyState?.enabled === true
    ? await resolveProxyManualUpstreamAccountName(options.store, accounts)
    : null;
  const proxyLastUpstream = proxyState?.enabled === true
    ? await readLatestProxyUpstreamSelection(options.store.paths.codexTeamDir)
    : null;
  const authRepairAdvice = await summarizeAuthRepairAdvice(accounts);
  return buildDashboardSnapshot({
    accounts,
    current,
    daemonStatus,
    failures: result.failures,
    warnings: [
      ...accountWarnings,
      ...result.warnings,
      ...(authRepairAdvice ? [authRepairAdvice] : []),
    ],
    watchHistory,
    usageSummary,
    refreshedByName,
    proxySummary: proxyAggregate?.summary ?? null,
    proxyAggregate,
    proxyLastUpstream,
    proxyManualUpstreamName,
    proxyBaseUrl: proxyState?.base_url ?? null,
    proxyOpenAIBaseUrl: proxyState?.openai_base_url ?? null,
    debugLog: options.debugLog,
  });
}

export async function buildCachedAccountDashboardSnapshot(options: {
  store: AccountStore;
  daemonProcessManager?: DaemonProcessManager;
  debugLog?: DebugLogger;
}): Promise<AccountDashboardSnapshot> {
  const daemonProcessManager =
    options.daemonProcessManager ?? createDaemonProcessManager(options.store.paths.codexTeamDir);
  void triggerDaemonAuthRefresh({
    store: options.store,
    daemonProcessManager,
    ensureDaemon: false,
    source: "tui-open",
  }).catch((error) => {
    options.debugLog?.(`tui: failed to queue background auth refresh: ${(error as Error).message}`);
  });
  const { accounts, warnings } = await options.store.listAccounts();
  const current = await options.store.getCurrentStatus();
  const daemonStatus = await daemonProcessManager.getStatus();
  const proxyState = await readProxyState(options.store.paths.codexTeamDir);
  const watchHistory = await readWatchHistory(options.store, new Date());
  const usageSummary = await loadCachedLocalUsageSummary(options.store);
  const proxyAggregate = await buildProxyQuotaAggregate({
    store: options.store,
    includeWhenDisabled: true,
  });
  const proxyManualUpstreamName = proxyState?.enabled === true
    ? await resolveProxyManualUpstreamAccountName(options.store, accounts)
    : null;
  const proxyLastUpstream = proxyState?.enabled === true
    ? await readLatestProxyUpstreamSelection(options.store.paths.codexTeamDir)
    : null;
  const authRepairAdvice = await summarizeAuthRepairAdvice(accounts);

  return buildDashboardSnapshot({
    accounts,
    current,
    daemonStatus,
    failures: [],
    warnings: [...warnings, ...(authRepairAdvice ? [authRepairAdvice] : [])],
    watchHistory,
    usageSummary,
    proxySummary: proxyAggregate?.summary ?? null,
    proxyAggregate,
    proxyLastUpstream,
    proxyManualUpstreamName,
    proxyBaseUrl: proxyState?.base_url ?? null,
    proxyOpenAIBaseUrl: proxyState?.openai_base_url ?? null,
    debugLog: options.debugLog,
  });
}
