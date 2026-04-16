import { type AccountStore } from "../account-store/index.js";
import { type CliQuotaSummary, toCliQuotaSummary } from "../cli/quota.js";
import { shouldSkipManagedDesktopRefresh } from "../desktop/managed-state.js";
import { type CodexDesktopLauncher } from "../desktop/launcher.js";
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
  const switchCommand = `switch ${options.name}`;
  const lock = await tryAcquireSwitchLock(options.store, switchCommand);
  if (!lock.acquired) {
    throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
  }

  let desktopForceWarning: string | null = null;
  const result = await (async () => {
    try {
      const switched = await options.store.switchAccount(options.name);
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

  return {
    result,
    quota,
    desktopForceWarning,
  };
}
