import { readFile, stat } from "node:fs/promises";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { getSnapshotIdentity, maskAccountId, parseAuthSnapshot } from "../auth-snapshot.js";
import { ensureAccountName, type AccountStore } from "../account-store/index.js";
import type {
  CodexDesktopLauncher,
  RuntimeAccountSnapshot,
  RuntimeReadSource,
} from "../desktop/launcher.js";
import {
  computeAvailability,
  describeCurrentUsageSummary,
  describeQuotaRefresh,
  toCliQuotaRefreshResult,
  toCliQuotaSummary,
  toCliQuotaSummaryFromRuntimeQuota,
  type CliQuotaSummary,
} from "../cli/quota.js";
import { writeJson } from "../cli/output.js";
import {
  LOCAL_USAGE_WINDOWS,
  formatLocalUsageWindowLine,
  type LocalUsageWindowName,
} from "../local-usage/format.js";
import { LocalUsageService } from "../local-usage/service.js";
import {
  computeWatchHistoryEta,
  computeWatchObservedRatioDiagnostics,
  createWatchHistoryStore,
  filterWatchHistoryByScope,
  type WatchHistoryEtaContext,
} from "../watch/history.js";
import { buildProxyQuotaAggregate } from "../proxy/quota.js";
import { PROXY_ACCOUNT_ID, PROXY_ACCOUNT_NAME } from "../proxy/constants.js";
import {
  formatProxyUpstreamSelectionLabel,
  readLatestProxyUpstreamSelection,
} from "../proxy/request-log.js";
import { readProxyState } from "../proxy/state.js";
import type { DaemonProcessManager } from "../daemon/process.js";
import { describeDaemonFeatureLine } from "../daemon/display.js";
import { triggerDaemonAuthRefresh } from "../daemon/trigger.js";

dayjs.extend(utc);
dayjs.extend(timezone);

interface CurrentStatusView extends Awaited<ReturnType<AccountStore["getCurrentStatus"]>> {
  source: "auth.json" | "desktop-runtime" | "direct-runtime";
  runtime_differs_from_local: boolean;
}

interface CurrentRuntimeAccountView {
  snapshot: RuntimeAccountSnapshot;
  source: RuntimeReadSource;
}

interface CurrentRuntimeQuotaView {
  quota: CliQuotaSummary;
  source: RuntimeReadSource;
}

interface DoctorCurrentAuthView {
  status: "ok" | "missing" | "invalid";
  auth_mode: string | null;
  identity: string | null;
  matched_accounts: string[];
  managed: boolean;
  error: string | null;
}

interface DoctorRuntimeView {
  status: "ok" | "unavailable" | "error";
  account: RuntimeAccountSnapshot | null;
  quota: CliQuotaSummary | null;
  error: string | null;
}

interface DoctorDesktopRuntimeView {
  status: "ok" | "unavailable" | "error";
  account: RuntimeAccountSnapshot | null;
  quota: CliQuotaSummary | null;
  error: string | null;
  differs_from_local: boolean | null;
  differs_from_direct: boolean | null;
}

interface CliDoctorReport {
  healthy: boolean;
  store: Awaited<ReturnType<AccountStore["doctor"]>>;
  current_auth: DoctorCurrentAuthView;
  direct_runtime: DoctorRuntimeView;
  desktop_runtime: DoctorDesktopRuntimeView;
  warnings: string[];
  issues: string[];
}

type DebugLogger = (message: string) => void;

function toWatchEtaTarget(account: Awaited<ReturnType<AccountStore["refreshAllQuotas"]>>["successes"][number]) {
  return {
    plan_type: account.plan_type,
    available: computeAvailability(account),
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

function toJsonEta(eta: WatchHistoryEtaContext) {
  const rate = eta.rate_1w_units_per_hour;
  const eta5hEq1wHours =
    eta.status === "ok" && rate && rate > 0 && typeof eta.remaining_5h_eq_1w === "number"
      ? Number((eta.remaining_5h_eq_1w / rate).toFixed(2))
      : null;
  const eta1wHours =
    eta.status === "ok" && rate && rate > 0 && typeof eta.remaining_1w === "number"
      ? Number((eta.remaining_1w / rate).toFixed(2))
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function describeCurrentSource(source: CurrentStatusView["source"]): string {
  switch (source) {
    case "desktop-runtime":
      return "managed Desktop runtime (mcp + auth.json)";
    case "direct-runtime":
      return "direct Codex runtime (app-server + auth.json)";
    default:
      return "local auth.json";
  }
}

function describeCurrentStatus(
  status: CurrentStatusView,
  usage?: {
    quota: CliQuotaSummary | null;
    unavailableReason: string | null;
    sourceLabel?: string;
  },
): string {
  const lines: string[] = [];

  if (!status.exists) {
    lines.push("Current auth: missing");
  } else {
    lines.push("Current auth: present");
    lines.push(`Source: ${describeCurrentSource(status.source)}`);
    lines.push(`Auth mode: ${status.auth_mode}`);
    if (status.identity) {
      lines.push(`Identity: ${maskAccountId(status.identity)}`);
    }
    if (status.matched_accounts.length === 0) {
      lines.push("Managed account: no (unmanaged)");
    } else if (status.matched_accounts.length === 1) {
      lines.push(`Managed account: ${status.matched_accounts[0]}`);
    } else {
      lines.push(`Managed account: multiple (${status.matched_accounts.join(", ")})`);
    }
  }

  for (const warning of status.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  if (usage) {
    lines.push(
      describeCurrentUsageSummary(usage.quota, usage.unavailableReason, usage.sourceLabel),
    );
  }

  return lines.join("\n");
}

function quotaSummaryLabel(quota: CliQuotaSummary | null): string {
  return describeCurrentUsageSummary(quota, null).replace(/^Usage:\s*/, "");
}

function runtimeAccountLabel(account: RuntimeAccountSnapshot | null): string {
  if (!account) {
    return "unavailable";
  }

  const fields = [account.auth_mode ?? "unknown"];
  if (account.email) {
    fields.push(account.email);
  }
  if (account.plan_type) {
    fields.push(account.plan_type);
  }
  return fields.join(" | ");
}

function hasRuntimeAuthDifference(
  left: { auth_mode: string | null } | null,
  right: { auth_mode: string | null } | null,
): boolean | null {
  if (!left || !right || !left.auth_mode || !right.auth_mode) {
    return null;
  }

  return left.auth_mode !== right.auth_mode;
}

async function tryReadCurrentRuntimeQuota(
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: DebugLogger,
): Promise<CurrentRuntimeQuotaView | null> {
  try {
    const quotaResult = await desktopLauncher.readCurrentRuntimeQuotaResult();
    if (!quotaResult) {
      debugLog?.("current: runtime quota unavailable");
      return null;
    }

    debugLog?.(`current: using ${quotaResult.source} runtime quota`);
    return {
      quota: toCliQuotaSummaryFromRuntimeQuota(quotaResult.snapshot),
      source: quotaResult.source,
    };
  } catch (error) {
    debugLog?.(`current: runtime quota read failed: ${(error as Error).message}`);
    return null;
  }
}

async function tryReadCurrentRuntimeAccount(
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: DebugLogger,
): Promise<CurrentRuntimeAccountView | null> {
  try {
    const accountResult = await desktopLauncher.readCurrentRuntimeAccountResult();
    if (!accountResult) {
      debugLog?.("current: runtime account unavailable");
      return null;
    }

    debugLog?.(`current: using ${accountResult.source} runtime account`);
    return accountResult;
  } catch (error) {
    debugLog?.(`current: runtime account read failed: ${(error as Error).message}`);
    return null;
  }
}

function buildCurrentStatusView(
  localStatus: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
  runtimeAccountView: CurrentRuntimeAccountView | null,
): CurrentStatusView {
  const warnings = [...localStatus.warnings];
  let runtimeDiffersFromLocal = false;
  const runtimeAccount = runtimeAccountView?.snapshot ?? null;

  if (runtimeAccount && runtimeAccount.auth_mode !== localStatus.auth_mode) {
    runtimeDiffersFromLocal = true;
    warnings.push(
      runtimeAccountView?.source === "desktop"
        ? "Managed Desktop auth differs from ~/.codex/auth.json."
        : "Direct Codex runtime auth differs from ~/.codex/auth.json.",
    );
  }

  return {
    ...localStatus,
    exists:
      localStatus.exists ||
      (runtimeAccount !== null && runtimeAccount.auth_mode !== null),
    auth_mode: runtimeAccount?.auth_mode ?? localStatus.auth_mode,
    warnings,
    source:
      runtimeAccountView?.source === "desktop"
        ? "desktop-runtime"
        : runtimeAccountView?.source === "direct"
          ? "direct-runtime"
          : "auth.json",
    runtime_differs_from_local: runtimeDiffersFromLocal,
  };
}

async function inspectDoctorCurrentAuth(store: AccountStore): Promise<DoctorCurrentAuthView> {
  if (!(await pathExists(store.paths.currentAuthPath))) {
    return {
      status: "missing",
      auth_mode: null,
      identity: null,
      matched_accounts: [],
      managed: false,
      error: null,
    };
  }

  try {
    const localStatus = await store.getCurrentStatus();
    return {
      status: "ok",
      auth_mode: localStatus.auth_mode,
      identity: localStatus.identity,
      matched_accounts: localStatus.matched_accounts,
      managed: localStatus.managed,
      error: null,
    };
  } catch (error) {
    let parsedAuthMode: string | null = null;
    let parsedIdentity: string | null = null;

    try {
      const rawAuth = await readFile(store.paths.currentAuthPath, "utf8");
      const snapshot = parseAuthSnapshot(rawAuth);
      parsedAuthMode = snapshot.auth_mode;
      parsedIdentity = getSnapshotIdentity(snapshot);
    } catch {
      // Keep the doctor output best-effort when current auth parsing fails.
    }

    return {
      status: "invalid",
      auth_mode: parsedAuthMode,
      identity: parsedIdentity,
      matched_accounts: [],
      managed: false,
      error: (error as Error).message,
    };
  }
}

async function inspectDirectRuntime(
  desktopLauncher: CodexDesktopLauncher,
): Promise<DoctorRuntimeView> {
  try {
    const account = await desktopLauncher.readDirectRuntimeAccount();
    if (!account) {
      return {
        status: "unavailable",
        account: null,
        quota: null,
        error: "Direct runtime did not return account info.",
      };
    }

    try {
      const quotaSnapshot = await desktopLauncher.readDirectRuntimeQuota();
      return {
        status: "ok",
        account,
        quota: quotaSnapshot ? toCliQuotaSummaryFromRuntimeQuota(quotaSnapshot) : null,
        error: null,
      };
    } catch {
      return {
        status: "ok",
        account,
        quota: null,
        error: null,
      };
    }
  } catch (error) {
    return {
      status: "error",
      account: null,
      quota: null,
      error: (error as Error).message,
    };
  }
}

async function inspectDesktopRuntime(
  desktopLauncher: CodexDesktopLauncher,
  currentAuth: DoctorCurrentAuthView,
  directRuntime: DoctorRuntimeView,
): Promise<DoctorDesktopRuntimeView> {
  try {
    const account = await desktopLauncher.readManagedCurrentAccount();
    const quotaSnapshot = await desktopLauncher.readManagedCurrentQuota();

    if (!account && !quotaSnapshot) {
      return {
        status: "unavailable",
        account: null,
        quota: null,
        error: null,
        differs_from_local: null,
        differs_from_direct: null,
      };
    }

    return {
      status: "ok",
      account,
      quota: quotaSnapshot ? toCliQuotaSummaryFromRuntimeQuota(quotaSnapshot) : null,
      error: null,
      differs_from_local: hasRuntimeAuthDifference(
        account,
        currentAuth.status === "ok" ? { auth_mode: currentAuth.auth_mode } : null,
      ),
      differs_from_direct: hasRuntimeAuthDifference(account, directRuntime.account),
    };
  } catch (error) {
    return {
      status: "error",
      account: null,
      quota: null,
      error: (error as Error).message,
      differs_from_local: null,
      differs_from_direct: null,
    };
  }
}

async function runDoctorChecks(
  store: AccountStore,
  desktopLauncher: CodexDesktopLauncher,
): Promise<CliDoctorReport> {
  const [storeReport, currentAuth, directRuntime] = await Promise.all([
    store.doctor(),
    inspectDoctorCurrentAuth(store),
    inspectDirectRuntime(desktopLauncher),
  ]);
  const desktopRuntime = await inspectDesktopRuntime(desktopLauncher, currentAuth, directRuntime);

  const warnings = [...storeReport.warnings];
  const issues = [...storeReport.issues];

  if (currentAuth.status === "missing") {
    issues.push("Current ~/.codex/auth.json is missing.");
  } else if (currentAuth.status === "invalid" && currentAuth.error) {
    issues.push(`Current auth.json is invalid: ${currentAuth.error}`);
  }

  if (directRuntime.status !== "ok") {
    issues.push(directRuntime.error ?? "Direct runtime health check failed.");
  } else if (!directRuntime.quota) {
    warnings.push("Direct runtime quota probe did not return usage info.");
  }

  if (desktopRuntime.status === "error") {
    warnings.push(`Managed Desktop runtime probe failed: ${desktopRuntime.error}`);
  }

  if (desktopRuntime.differs_from_local === true) {
    warnings.push("Managed Desktop runtime auth differs from ~/.codex/auth.json.");
  }

  if (desktopRuntime.differs_from_direct === true) {
    warnings.push("Managed Desktop runtime auth differs from the direct runtime probe.");
  }

  const uniqueWarnings = [...new Set(warnings)];
  const uniqueIssues = [...new Set(issues)];

  return {
    healthy: uniqueIssues.length === 0,
    store: storeReport,
    current_auth: currentAuth,
    direct_runtime: directRuntime,
    desktop_runtime: desktopRuntime,
    warnings: uniqueWarnings,
    issues: uniqueIssues,
  };
}

function describeDoctorReport(report: CliDoctorReport): string {
  const lines = [
    `Doctor: ${report.healthy ? "healthy" : "issues found"}`,
    `Store: ${report.store.healthy ? "healthy" : "issues found"} | accounts=${report.store.account_count} | invalid=${report.store.invalid_accounts.length}`,
    `Current auth: ${report.current_auth.status}${
      report.current_auth.status === "ok"
        ? ` | ${report.current_auth.auth_mode ?? "unknown"} | managed=${report.current_auth.managed ? "yes" : "no"}`
        : report.current_auth.error
          ? ` | ${report.current_auth.error}`
          : ""
    }`,
    `Direct runtime: ${report.direct_runtime.status}${
      report.direct_runtime.status === "ok"
        ? ` | ${runtimeAccountLabel(report.direct_runtime.account)}`
        : report.direct_runtime.error
          ? ` | ${report.direct_runtime.error}`
          : ""
    }`,
  ];

  if (report.direct_runtime.status === "ok") {
    lines.push(`Direct quota: ${quotaSummaryLabel(report.direct_runtime.quota)}`);
  }

  lines.push(
    `Desktop runtime: ${report.desktop_runtime.status}${
      report.desktop_runtime.status === "ok"
        ? ` | ${runtimeAccountLabel(report.desktop_runtime.account)}`
        : report.desktop_runtime.error
          ? ` | ${report.desktop_runtime.error}`
          : ""
    }`,
  );

  if (report.desktop_runtime.status === "ok" && report.desktop_runtime.quota) {
    lines.push(`Desktop quota: ${quotaSummaryLabel(report.desktop_runtime.quota)}`);
  }

  for (const warning of report.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  for (const issue of report.issues) {
    lines.push(`Issue: ${issue}`);
  }

  return lines.join("\n");
}

export async function handleCurrentCommand(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  stdout: NodeJS.WriteStream;
  debugLog: DebugLogger;
  json: boolean;
  refresh: boolean;
}): Promise<number> {
  const localStatus = await options.store.getCurrentStatus();
  const runtimeAccount = await tryReadCurrentRuntimeAccount(options.desktopLauncher, options.debugLog);
  const result = buildCurrentStatusView(localStatus, runtimeAccount);
  let quota: CliQuotaSummary | null = null;
  let usageUnavailableReason: string | null = null;
  let usageSourceLabel: string | null = null;

  if (!options.refresh && result.exists && result.matched_accounts.length === 1) {
    const runtimeQuota = await tryReadCurrentRuntimeQuota(options.desktopLauncher, options.debugLog);
    if (runtimeQuota) {
      quota = runtimeQuota.quota;
      usageSourceLabel = runtimeQuota.source === "desktop" ? "live Desktop runtime" : "direct runtime";
    }
  }

  if (options.refresh) {
    if (!result.exists) {
      usageUnavailableReason = "unavailable (current auth is missing)";
    } else if (result.matched_accounts.length === 0) {
      usageUnavailableReason = "unavailable (current auth is unmanaged)";
    } else if (result.matched_accounts.length > 1) {
      usageUnavailableReason = "unavailable (current auth matches multiple managed accounts)";
    } else {
      const currentName = result.matched_accounts[0];
      const runtimeQuota = await tryReadCurrentRuntimeQuota(options.desktopLauncher, options.debugLog);
      if (runtimeQuota) {
        quota = runtimeQuota.quota;
        usageSourceLabel =
          runtimeQuota.source === "desktop"
            ? "refreshed via Desktop runtime"
            : "refreshed via direct runtime";
      } else {
        const quotaResult = await options.store.refreshQuotaForAccount(currentName);
        const quotaList = await options.store.listQuotaSummaries();
        const matched =
          quotaList.accounts.find((account) => account.name === quotaResult.account.name) ?? null;
        quota = matched ? toCliQuotaSummary(matched) : null;
        if (quota) {
          usageSourceLabel = "refreshed via api";
        }
      }
    }
  }

  options.debugLog(
    `current: exists=${result.exists} managed=${result.managed} matched_accounts=${result.matched_accounts.length} auth_mode=${result.auth_mode ?? "null"} source=${result.source} runtime_differs=${result.runtime_differs_from_local} refresh=${options.refresh} quota_refreshed=${quota !== null} quota_source=${usageSourceLabel ?? "none"}`,
  );
  if (options.json) {
    writeJson(
      options.stdout,
      options.refresh || quota
        ? {
            ...result,
            quota,
          }
        : result,
    );
  } else {
    options.stdout.write(
      `${describeCurrentStatus(
        result,
        options.refresh
          ? {
              quota,
              unavailableReason: usageUnavailableReason,
              sourceLabel: usageSourceLabel ?? undefined,
            }
          : quota
            ? {
                quota,
                unavailableReason: usageUnavailableReason,
                sourceLabel: usageSourceLabel ?? undefined,
              }
            : undefined,
      )}\n`,
    );
  }
  return 0;
}

export async function handleDoctorCommand(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  stdout: NodeJS.WriteStream;
  debugLog: DebugLogger;
  json: boolean;
}): Promise<number> {
  const report = await runDoctorChecks(options.store, options.desktopLauncher);
  options.debugLog(
    `doctor: healthy=${report.healthy} current_auth=${report.current_auth.status} direct_runtime=${report.direct_runtime.status} desktop_runtime=${report.desktop_runtime.status} warnings=${report.warnings.length} issues=${report.issues.length}`,
  );

  if (options.json) {
    writeJson(options.stdout, report);
  } else {
    options.stdout.write(`${describeDoctorReport(report)}\n`);
  }

  return report.healthy ? 0 : 1;
}

export async function handleListCommand(options: {
  store: AccountStore;
  daemonProcessManager: DaemonProcessManager;
  stdout: NodeJS.WriteStream;
  debugLog: DebugLogger;
  debug: boolean;
  json: boolean;
  refresh: boolean;
  targetName?: string;
  usageWindow?: string;
  verbose: boolean;
}): Promise<number> {
  const usageWindow = options.usageWindow ?? "7d";
  if (!LOCAL_USAGE_WINDOWS.includes(usageWindow as LocalUsageWindowName)) {
    throw new Error(`Usage window must be one of: ${LOCAL_USAGE_WINDOWS.join(", ")}.`);
  }
  if (options.targetName) {
    ensureAccountName(options.targetName);
  }

  const result = await options.store.refreshAllQuotas(options.targetName, {
    quotaClientMode: "list-fast",
    allowCachedQuotaFallback: true,
  });
  const proxyAggregate = options.targetName
    ? null
    : await buildProxyQuotaAggregate({
        store: options.store,
        includeWhenDisabled: true,
      });
  const proxySummary = proxyAggregate?.summary ?? null;
  const proxyState = await readProxyState(options.store.paths.codexTeamDir);
  const now = new Date();
  const proxyLastUpstream = proxySummary && proxyState?.enabled === true
    ? await readLatestProxyUpstreamSelection(options.store.paths.codexTeamDir)
    : null;
  const proxyLastUpstreamLine = proxyLastUpstream
    ? `Proxy last upstream: ${formatProxyUpstreamSelectionLabel(proxyLastUpstream, now) ?? proxyLastUpstream.accountName}`
    : null;
  const displayResult = proxySummary
    ? {
        ...result,
        successes: [proxySummary, ...result.successes],
      }
    : result;
  const current = await options.store.getCurrentStatus();
  const daemonStatus = await options.daemonProcessManager.getStatus();
  const currentAccounts = new Set(current.matched_accounts);
  if (current.account_id === PROXY_ACCOUNT_ID) {
    currentAccounts.add(PROXY_ACCOUNT_NAME);
  }
  const watchHistoryStore = createWatchHistoryStore(options.store.paths.codexTeamDir);
  const watchHistory = filterWatchHistoryByScope(
    await watchHistoryStore.read(now),
    { kind: "global" },
  );
  const etaByName = new Map(
    displayResult.successes.map((account) => [
      account.name,
      computeWatchHistoryEta(
        watchHistory,
        account.name === PROXY_ACCOUNT_NAME && proxyAggregate
          ? proxyAggregate.watchEtaTarget
          : toWatchEtaTarget(account),
        now,
      ),
    ] as const),
  );
  options.debugLog(
    `list: target=${options.targetName ?? "all"} usage_window=${usageWindow} successes=${displayResult.successes.length} failures=${result.failures.length} warnings=${result.warnings.length} current_matches=${current.matched_accounts.length} proxy=${proxySummary ? "yes" : "no"} watch_history_samples=${watchHistory.length}`,
  );
  const usageSummary = await new LocalUsageService({
    homeDir: options.store.paths.homeDir,
  }).load();
  const usageBlock = {
    selected_window: usageWindow,
    windows: {
      [usageWindow]: usageSummary.windows[usageWindow as LocalUsageWindowName],
    },
  };
  const usageLine = formatLocalUsageWindowLine(
    usageWindow,
    usageSummary.windows[usageWindow as LocalUsageWindowName],
  );
  if (options.debug) {
    const ratioDiagnostics = computeWatchObservedRatioDiagnostics(watchHistory, now);
    if (ratioDiagnostics.length === 0) {
      options.debugLog("list: observed_5h_1w_ratio window=24h insufficient_samples");
    } else {
      for (const diagnostic of ratioDiagnostics) {
        options.debugLog(
          `list: observed_5h_1w_ratio window=24h plan=${diagnostic.key} samples=${diagnostic.sample_count} observed=${diagnostic.observed_weighted_raw_ratio} expected=${diagnostic.expected_raw_ratio ?? "n/a"} mean=${diagnostic.observed_mean_raw_ratio} variance=${diagnostic.variance}`,
        );
        if (diagnostic.warning) {
          options.debugLog(
            `warning: list observed_5h_1w_ratio_mismatch window=24h plan=${diagnostic.key} observed=${diagnostic.observed_weighted_raw_ratio} expected=${diagnostic.expected_raw_ratio ?? "n/a"} relative_delta=${diagnostic.relative_delta ?? "n/a"} samples=${diagnostic.sample_count}`,
          );
        }
      }
    }
  }
  if (options.json) {
    writeJson(options.stdout, {
      ...toCliQuotaRefreshResult(displayResult),
      current,
      daemon: {
        running: daemonStatus.running,
        state: daemonStatus.state,
      },
      proxy: proxySummary ? toCliQuotaSummary(proxySummary) : null,
      proxy_last_upstream: proxyLastUpstream
        ? {
            account_name: proxyLastUpstream.accountName,
            auth_mode: proxyLastUpstream.authMode,
            at: proxyLastUpstream.ts,
            label: formatProxyUpstreamSelectionLabel(proxyLastUpstream, now),
          }
        : null,
      usage: usageBlock,
      successes: displayResult.successes.map((account) => ({
        ...toCliQuotaSummary(account),
        is_current: currentAccounts.has(account.name),
        eta: toJsonEta(
          etaByName.get(account.name)
            ?? computeWatchHistoryEta(
              [],
              account.name === PROXY_ACCOUNT_NAME && proxyAggregate
                ? proxyAggregate.watchEtaTarget
                : toWatchEtaTarget(account),
              now,
            ),
        ),
      })),
    });
  } else {
    options.stdout.write(
      `${describeQuotaRefresh(displayResult, current, {
        verbose: options.verbose,
        etaByName,
        usageLine,
        daemonFeatureLine: describeDaemonFeatureLine(daemonStatus),
        proxyLastUpstreamLine,
        proxyLastUpstreamAccountName: proxyLastUpstream?.accountName ?? null,
        summaryAccounts: result.successes,
      })}\n`,
    );
  }
  void triggerDaemonAuthRefresh({
    store: options.store,
    daemonProcessManager: options.daemonProcessManager,
    ensureDaemon: options.refresh,
    source: options.refresh ? "list-refresh" : "list",
  }).catch((error) => {
    options.debugLog(`list: failed to queue background auth refresh: ${(error as Error).message}`);
  });
  return result.failures.length === 0 ? 0 : 1;
}
