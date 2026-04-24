import { dirname } from "node:path";

import { maskAccountId } from "../auth-snapshot.js";
import { ensureAccountName, type AccountStore, type ManagedAccount } from "../account-store/index.js";
import type {
  CodexDesktopLauncher,
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
import type { LocalUsageSummary } from "../local-usage/types.js";
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
import { resolveProxyManualUpstreamAccountName } from "../proxy/runtime.js";
import { readProxyState } from "../proxy/state.js";
import type { DaemonProcessManager } from "../daemon/process.js";
import { describeDaemonFeatureLine } from "../daemon/display.js";
import { triggerDaemonAuthRefresh } from "../daemon/trigger.js";
import { summarizeAuthRepairAdvice } from "../auth-refresh.js";
import {
  buildSingleAccountDetailJson,
  buildSingleAccountDetailText,
  describeCurrentStatus,
  describeDoctorReport,
  formatDateTime,
  formatResetAt,
  toJsonEta,
  toWatchEtaTarget,
} from "./inspection-display.js";
import {
  buildCurrentStatusView,
  runDoctorChecks,
  tryReadCurrentRuntimeAccount,
  tryReadDirectRuntimeQuota,
  type CurrentStatusView,
} from "./inspection-runtime.js";

type DebugLogger = (message: string) => void;

export async function handleCurrentCommand(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  stdout: NodeJS.WriteStream;
  debugLog: DebugLogger;
  json: boolean;
}): Promise<number> {
  const localStatus = await options.store.getCurrentStatus();
  const runtimeAccount = await tryReadCurrentRuntimeAccount(options.desktopLauncher, options.debugLog);
  const result = buildCurrentStatusView(localStatus, runtimeAccount);
  let quota: CliQuotaSummary | null = null;
  let usageUnavailableReason: string | null = null;
  let usageSourceLabel: string | null = null;
  const isProxyCurrent = result.account_id === PROXY_ACCOUNT_ID;

  if (!result.exists) {
    usageUnavailableReason = "unavailable (current auth is missing)";
  } else if (isProxyCurrent) {
    const proxyAggregate = await buildProxyQuotaAggregate({
      store: options.store,
      includeWhenDisabled: true,
    });
    quota = proxyAggregate ? toCliQuotaSummary(proxyAggregate.summary) : null;
    if (quota) {
      usageSourceLabel = "proxy aggregate";
    } else {
      usageUnavailableReason = "unavailable (proxy aggregate quota is unavailable)";
    }
  } else {
    const runtimeQuota = await tryReadDirectRuntimeQuota(options.desktopLauncher, options.debugLog);
    if (runtimeQuota) {
      quota = runtimeQuota.quota;
      usageSourceLabel = "direct runtime";
    } else if (result.matched_accounts.length === 1) {
      const currentName = result.matched_accounts[0];
      try {
        const quotaResult = await options.store.refreshQuotaForAccount(currentName, {
          allowCachedQuotaFallback: true,
        });
        const quotaList = await options.store.listQuotaSummaries();
        const matched =
          quotaList.accounts.find((account) => account.name === quotaResult.account.name) ?? null;
        quota = matched ? toCliQuotaSummary(matched) : null;
        if (quota) {
          usageSourceLabel =
            quota.refresh_status === "stale" ? "saved account cache" : "refreshed via api";
        } else {
          usageUnavailableReason = "unavailable (saved account quota is unavailable)";
        }
      } catch (error) {
        usageUnavailableReason = `unavailable (${(error as Error).message})`;
      }
    } else if (result.matched_accounts.length > 1) {
      usageUnavailableReason = "unavailable (current auth matches multiple managed accounts)";
    } else {
      usageUnavailableReason = "unavailable (direct runtime quota is unavailable)";
    }
  }

  options.debugLog(
    `current: exists=${result.exists} managed=${result.managed} matched_accounts=${result.matched_accounts.length} auth_mode=${result.auth_mode ?? "null"} source=${result.source} runtime_differs=${result.runtime_differs_from_local} quota_present=${quota !== null} quota_source=${usageSourceLabel ?? "none"} quota_unavailable=${usageUnavailableReason ?? "none"}`,
  );
  if (options.json) {
    writeJson(
      options.stdout,
      quota
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
        result.exists || usageUnavailableReason
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
  const { accounts: managedAccounts } = await options.store.listAccounts();
  const proxyAggregate = options.targetName
    ? null
    : await buildProxyQuotaAggregate({
        store: options.store,
        includeWhenDisabled: true,
      });
  const proxySummary = proxyAggregate?.summary ?? null;
  const proxyState = await readProxyState(options.store.paths.codexTeamDir);
  const now = new Date();
  const proxyCurrentUpstreamName = proxySummary && proxyState?.enabled === true
    ? await resolveProxyManualUpstreamAccountName(options.store)
    : null;
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
  const accountPathByName = new Map(
    managedAccounts.map((account) => [account.name, dirname(account.authPath)] as const),
  );
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
  const authRepairAdvice = await summarizeAuthRepairAdvice(managedAccounts, now);
  const combinedWarnings = authRepairAdvice ? [...result.warnings, authRepairAdvice] : result.warnings;
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
  if (options.targetName) {
    const account = await options.store.getManagedAccount(options.targetName);
    const matchedQuota = displayResult.successes.find((entry) => entry.name === options.targetName) ?? null;
    const quotaFailure = result.failures.find((failure) => failure.name === options.targetName)?.error ?? null;
    const quota = matchedQuota ? toCliQuotaSummary(matchedQuota) : null;
    const eta = etaByName.get(options.targetName) ?? null;

    if (options.json) {
      writeJson(options.stdout, buildSingleAccountDetailJson({
        account,
        quota,
        quotaFailure,
        eta,
        current,
        daemonStatus,
        usageWindow: usageWindow as LocalUsageWindowName,
        usageSummary,
        warnings: combinedWarnings,
        proxyCurrentUpstreamName,
        proxyLastUpstreamLabel: proxyLastUpstream ? formatProxyUpstreamSelectionLabel(proxyLastUpstream, now) : null,
      }));
    } else {
      options.stdout.write(`${buildSingleAccountDetailText({
        account,
        quota,
        quotaFailure,
        eta,
        current,
        daemonStatus,
        usageWindow: usageWindow as LocalUsageWindowName,
        usageSummary,
        warnings: combinedWarnings,
        proxyCurrentUpstreamName,
        proxyLastUpstreamLine,
      })}\n`);
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
  if (options.json) {
    writeJson(options.stdout, {
      ...toCliQuotaRefreshResult({
        ...displayResult,
        warnings: combinedWarnings,
      }),
      current,
      daemon: {
        running: daemonStatus.running,
        state: daemonStatus.state,
      },
      proxy: proxySummary ? toCliQuotaSummary(proxySummary) : null,
      proxy_current_upstream: proxyCurrentUpstreamName
        ? {
            account_name: proxyCurrentUpstreamName,
          }
        : null,
      proxy_last_upstream: proxyLastUpstream
        ? {
            account_name: proxyLastUpstream.accountName,
            auth_mode: proxyLastUpstream.authMode,
            at: proxyLastUpstream.ts,
            label: formatProxyUpstreamSelectionLabel(proxyLastUpstream, now),
          }
        : null,
      usage: usageBlock,
      warnings: combinedWarnings,
      successes: displayResult.successes.map((account) => ({
        ...toCliQuotaSummary(account),
        account_path: accountPathByName.get(account.name) ?? null,
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
      `${describeQuotaRefresh({
        ...displayResult,
        warnings: combinedWarnings,
      }, current, {
        verbose: options.verbose,
        terminalWidth: options.stdout.isTTY ? options.stdout.columns : null,
        etaByName,
        usageLine,
        daemonFeatureLine: describeDaemonFeatureLine(daemonStatus),
        proxyLastUpstreamLine,
        proxyLastUpstreamAccountName: proxyCurrentUpstreamName ?? proxyLastUpstream?.accountName ?? null,
        proxyAggregate,
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
