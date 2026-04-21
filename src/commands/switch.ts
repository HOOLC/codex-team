import { type AccountStore } from "../account-store/index.js";
import { type CliQuotaSummary, toCliQuotaSummary } from "../cli/quota.js";
import { shouldSkipManagedDesktopRefresh } from "../desktop/managed-state.js";
import { type CodexDesktopLauncher } from "../desktop/launcher.js";
import { appendEventLog, buildEventPayload, shortenErrorMessage } from "../logging.js";
import { isSyntheticProxyRuntimeActive, markProxyRoutingDisabled } from "../proxy/runtime.js";
import {
  describeBusySwitchLock,
  refreshManagedDesktopAfterSwitch,
  stripManagedDesktopWarning,
  tryAcquireSwitchLock,
} from "../switching.js";

type DebugLogger = (message: string) => void;

export interface PerformManualSwitchOptions {
  name: string;
  force: boolean;
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  stderr: NodeJS.WriteStream;
  onStatusMessage?: (message: string) => void;
  debugLog?: DebugLogger;
  interruptSignal?: AbortSignal;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
}

export interface PerformManualSwitchResult {
  result: Awaited<ReturnType<AccountStore["switchAccount"]>>;
  quota: CliQuotaSummary | null;
  desktopForceWarning: string | null;
}

export async function performManualSwitch(
  options: PerformManualSwitchOptions,
): Promise<PerformManualSwitchResult> {
  options.debugLog?.(`switch: mode=manual target=${options.name} force=${options.force}`);
  await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
    component: "switch",
    event: "account.switch.started",
    trigger: "cli",
    fields: {
      target_account_name: options.name,
      force: options.force,
    },
  }));
  const switchCommand = `switch ${options.name}`;
  const lock = await tryAcquireSwitchLock(options.store, switchCommand);
  if (!lock.acquired) {
    throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
  }

  let desktopForceWarning: string | null = null;
  const result = await (async () => {
    try {
      const proxyModeWasActive = await isSyntheticProxyRuntimeActive(options.store);
      const switched = await options.store.switchAccount(options.name);
      if (proxyModeWasActive) {
        await markProxyRoutingDisabled(options.store);
      }
      switched.warnings = stripManagedDesktopWarning(switched.warnings);
      const skipDesktopRefresh = await shouldSkipManagedDesktopRefresh(
        options.store,
        options.desktopLauncher,
        options.debugLog,
      );
      if (!skipDesktopRefresh) {
        const refreshOutcome = await refreshManagedDesktopAfterSwitch(
          switched.warnings,
          options.desktopLauncher,
          {
            force: options.force,
            signal: options.interruptSignal,
            statusStream: options.stderr,
            onStatusMessage: options.onStatusMessage,
            statusDelayMs: options.managedDesktopWaitStatusDelayMs,
            statusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
          },
        );
        if (options.force && refreshOutcome === "none") {
          desktopForceWarning =
            "Warning: --force is only meaningful with a managed Desktop session. " +
            'In CLI mode, use "codexm run" for seamless auth hot-switching.';
        }
      }
      return switched;
    } catch (error) {
      await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
        component: "switch",
        event: "account.switch.failed",
        trigger: "cli",
        level: "error",
        errorMessageShort: shortenErrorMessage((error as Error).message),
        fields: {
          target_account_name: options.name,
          force: options.force,
        },
      }));
      throw error;
    } finally {
      await lock.release();
    }
  })();

  let quota: CliQuotaSummary | null = null;
  try {
    await options.store.refreshQuotaForAccount(result.account.name, {
      quotaClientMode: "list-fast",
    });
    const quotaList = await options.store.listQuotaSummaries();
    const matched = quotaList.accounts.find((account) => account.name === result.account.name) ?? null;
    quota = matched ? toCliQuotaSummary(matched) : null;
  } catch (error) {
    result.warnings.push((error as Error).message);
  }

  options.debugLog?.(
    `switch: completed target=${result.account.name} warnings=${result.warnings.length} quota_refreshed=${quota !== null}`,
  );
  await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
    component: "switch",
    event: "account.switch.completed",
    trigger: "cli",
    fields: {
      target_account_name: result.account.name,
      warning_count: result.warnings.length,
      quota_refreshed: quota !== null,
    },
  }));

  return {
    result,
    quota,
    desktopForceWarning,
  };
}
