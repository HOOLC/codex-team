import type { AccountStore } from "../account-store/index.js";
import type {
  CodexDesktopLauncher,
  ManagedQuotaSignal,
  ManagedWatchActivitySignal,
} from "../desktop/launcher.js";
import { createCliProcessManager } from "./cli-watcher.js";
import {
  isTerminalWatchQuota,
  toCliQuotaSummaryFromRuntimeQuota,
} from "../cli/quota.js";
import {
  appendWatchQuotaHistory,
  createWatchHistoryStore,
} from "./history.js";
import {
  describeBusySwitchLock,
  performAutoSwitch,
  tryAcquireSwitchLock,
  tryReadManagedDesktopQuota,
} from "../switching.js";
import {
  describeWatchAutoSwitchEvent,
  describeWatchAutoSwitchSkippedEvent,
  describeWatchQuotaEvent,
  describeWatchStatusEvent,
  formatWatchLogLine,
  resolveWatchAccountLabel,
} from "./output.js";

const WATCH_AUTO_SWITCH_TIMEOUT_MS = 900_000;

interface CliStreams {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

async function resolveWatchHistoryIdentity(
  store: AccountStore,
  accountLabel: string,
  debugLog: (message: string) => void,
): Promise<{ accountId: string; identity: string } | null> {
  try {
    const { accounts } = await store.listAccounts();

    if (accountLabel !== "current") {
      const named = accounts.find((account) => account.name === accountLabel);
      if (named) {
        return {
          accountId: named.account_id,
          identity: named.identity,
        };
      }
    }

    const current = await store.getCurrentStatus();
    if (current.matched_accounts.length !== 1) {
      return null;
    }

    const matched = accounts.find((account) => account.name === current.matched_accounts[0]);
    if (!matched) {
      return null;
    }

    return {
      accountId: matched.account_id,
      identity: matched.identity,
    };
  } catch (error) {
    debugLog(`watch: failed to resolve managed account identity: ${(error as Error).message}`);
    return null;
  }
}

export async function runCliWatchSession(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  streams: CliStreams;
  interruptSignal?: AbortSignal;
  autoSwitch: boolean;
  debug: boolean;
  debugLog: (message: string) => void;
  watchQuotaMinReadIntervalMs: number;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
}): Promise<number> {
  const {
    store,
    desktopLauncher,
    streams,
    interruptSignal,
    autoSwitch,
    debug,
    debugLog,
    watchQuotaMinReadIntervalMs,
    managedDesktopWaitStatusDelayMs,
    managedDesktopWaitStatusIntervalMs,
  } = options;

  const platformModule = await import("../platform.js");
  const platform = await platformModule.getPlatform();
  debugLog(`watch: no managed Desktop detected, entering CLI watch mode (platform=${platform})`);
  streams.stderr.write(
    `${formatWatchLogLine("No managed Codex Desktop session — entering CLI watch mode")}\n`,
  );

  const cliManager = createCliProcessManager({
    pollIntervalMs: watchQuotaMinReadIntervalMs,
  });

  const discovered = await cliManager.findRunningCliProcesses();
  if (discovered.length > 0) {
    streams.stderr.write(
      `${formatWatchLogLine(`Found ${discovered.length} running codex CLI process(es)`)}\n`,
    );
    for (const proc of discovered) {
      debugLog(`watch: discovered CLI process pid=${proc.pid} command=${proc.command}`);
    }
  }

  let cliWatchExitCode = 0;
  let cliSwitchInFlight = false;
  let cliLastSwitchStartedAt = 0;
  let cliLastQuotaUpdateLine: string | null = null;
  let cliCurrentAccountLabel = await resolveWatchAccountLabel(store);
  const cliWatchSwitchCooldownMs = 5_000;

  const handleCliQuotaResult = async (quotaSignal: {
    requestId: string;
    quota: ReturnType<typeof toCliQuotaSummaryFromRuntimeQuota> | null;
    shouldAutoSwitch: boolean;
  }) => {
    const quotaUpdateLine = describeWatchQuotaEvent(cliCurrentAccountLabel, quotaSignal.quota);
    if (quotaUpdateLine !== cliLastQuotaUpdateLine) {
      streams.stdout.write(`${formatWatchLogLine(quotaUpdateLine)}\n`);
      cliLastQuotaUpdateLine = quotaUpdateLine;
    }

    if (!autoSwitch || !quotaSignal.shouldAutoSwitch) {
      return;
    }

    const lock = await tryAcquireSwitchLock(store, "watch-cli");
    if (!lock.acquired) {
      streams.stdout.write(
        `${formatWatchLogLine(
          describeWatchAutoSwitchSkippedEvent(cliCurrentAccountLabel, "lock-busy"),
        )}\n`,
      );
      return;
    }

    const now = Date.now();
    if (cliSwitchInFlight || now - cliLastSwitchStartedAt < cliWatchSwitchCooldownMs) {
      await lock.release();
      return;
    }

    cliSwitchInFlight = true;
    cliLastSwitchStartedAt = now;

    try {
      const switchResult = await performAutoSwitch(store, desktopLauncher, {
        dryRun: false,
        force: false,
        signal: interruptSignal,
        statusStream: streams.stderr,
        statusDelayMs: managedDesktopWaitStatusDelayMs,
        statusIntervalMs: managedDesktopWaitStatusIntervalMs,
        timeoutMs: WATCH_AUTO_SWITCH_TIMEOUT_MS,
        debugLog,
      });

      if (switchResult.skipped) {
        cliCurrentAccountLabel = switchResult.selected.name;
        streams.stdout.write(
          `${formatWatchLogLine(
            describeWatchAutoSwitchSkippedEvent(cliCurrentAccountLabel, "already-best"),
          )}\n`,
        );
      } else if (switchResult.result) {
        const previousLabel = cliCurrentAccountLabel;
        cliCurrentAccountLabel = switchResult.result.account.name;
        streams.stdout.write(
          `${formatWatchLogLine(
            describeWatchAutoSwitchEvent(
              previousLabel,
              cliCurrentAccountLabel,
              switchResult.result.warnings,
            ),
          )}\n`,
        );

        const restartResult = await cliManager.restartCliProcess({
          accountId: switchResult.selected.account_id ?? undefined,
          signal: interruptSignal,
        });
        if (restartResult.restarted > 0) {
          streams.stderr.write(
            `${formatWatchLogLine(
              `Restarted ${restartResult.restarted} CLI process(es). Use "codexm run" for seamless auto-restart.`,
            )}\n`,
          );
        }
        if (restartResult.failed > 0) {
          streams.stderr.write(
            `${formatWatchLogLine(
              `Failed to restart ${restartResult.failed} CLI process(es)`,
            )}\n`,
          );
        }
      }

      if (switchResult.refreshResult.failures.length > 0) {
        cliWatchExitCode = 1;
      }
    } finally {
      cliSwitchInFlight = false;
      await lock.release();
    }
  };

  try {
    await cliManager.watchCliQuotaSignals({
      pollIntervalMs: watchQuotaMinReadIntervalMs,
      signal: interruptSignal,
      debugLogger: debug
        ? (line) => {
            streams.stderr.write(`${line}\n`);
          }
        : undefined,
      onStatus: async (event) => {
        if (event.type === "disconnected") {
          streams.stderr.write(
            `${formatWatchLogLine(`CLI connection lost (attempt ${event.attempt}): ${event.error ?? "unknown"}`)}\n`,
          );
        } else if (event.type === "reconnected") {
          streams.stderr.write(
            `${formatWatchLogLine("CLI connection established")}\n`,
          );
        }
      },
      onQuotaSignal: async (quotaSignal) => {
        const quota = quotaSignal.quota
          ? toCliQuotaSummaryFromRuntimeQuota(quotaSignal.quota)
          : null;
        await handleCliQuotaResult({
          requestId: quotaSignal.requestId,
          quota,
          shouldAutoSwitch: quotaSignal.shouldAutoSwitch,
        });
      },
    });
  } catch (error) {
    if (!interruptSignal?.aborted) {
      streams.stderr.write(`Error: ${(error as Error).message}\n`);
      cliWatchExitCode = 1;
    }
  }

  return cliWatchExitCode;
}

export async function runManagedDesktopWatchSession(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  streams: CliStreams;
  interruptSignal?: AbortSignal;
  autoSwitch: boolean;
  debug: boolean;
  debugLog: (message: string) => void;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
  watchQuotaMinReadIntervalMs: number;
  watchQuotaIdleReadIntervalMs: number;
}): Promise<number> {
  const {
    store,
    desktopLauncher,
    streams,
    interruptSignal,
    autoSwitch,
    debug,
    debugLog,
    managedDesktopWaitStatusDelayMs,
    managedDesktopWaitStatusIntervalMs,
    watchQuotaMinReadIntervalMs,
    watchQuotaIdleReadIntervalMs,
  } = options;

  let watchExitCode = 0;
  let switchInFlight = false;
  let lastSwitchStartedAt = 0;
  let lastQuotaUpdateLine: string | null = null;
  let currentWatchAccountLabel = await resolveWatchAccountLabel(store);
  const watchHistoryStore = createWatchHistoryStore(store.paths.codexTeamDir);
  const watchSwitchCooldownMs = 5_000;

  debugLog("watch: starting managed desktop quota watch");
  debugLog(`watch: auto-switch ${autoSwitch ? "enabled" : "disabled"}`);

  const handleQuotaReadResult = async (quotaSignal: {
    requestId: string;
    quota: ReturnType<typeof toCliQuotaSummaryFromRuntimeQuota> | null;
    shouldAutoSwitch: boolean;
  }) => {
    const quota = quotaSignal.quota;
    if (quota?.refresh_status === "ok") {
      try {
        const historyIdentity = await resolveWatchHistoryIdentity(
          store,
          currentWatchAccountLabel,
          debugLog,
        );
        await appendWatchQuotaHistory(watchHistoryStore, {
          recordedAt: quota.fetched_at ?? new Date().toISOString(),
          accountName: currentWatchAccountLabel,
          accountId: historyIdentity?.accountId ?? quota.account_id,
          identity: historyIdentity?.identity ?? quota.identity,
          planType: quota.plan_type,
          available: quota.available,
          fiveHour: quota.five_hour
            ? {
                usedPercent: quota.five_hour.used_percent,
                windowSeconds: quota.five_hour.window_seconds,
                resetAt: quota.five_hour.reset_at ?? null,
              }
            : null,
          oneWeek: quota.one_week
            ? {
                usedPercent: quota.one_week.used_percent,
                windowSeconds: quota.one_week.window_seconds,
                resetAt: quota.one_week.reset_at ?? null,
              }
            : null,
        });
      } catch (error) {
        debugLog(`watch: failed to persist watch history: ${(error as Error).message}`);
      }
    }
    const quotaUpdateLine = describeWatchQuotaEvent(currentWatchAccountLabel, quota);
    if (quotaUpdateLine !== lastQuotaUpdateLine) {
      streams.stdout.write(`${formatWatchLogLine(quotaUpdateLine)}\n`);
      lastQuotaUpdateLine = quotaUpdateLine;
    } else {
      debugLog(`watch: quota output unchanged for requestId=${quotaSignal.requestId}`);
    }
    if (!autoSwitch) {
      return;
    }

    if (!quotaSignal.shouldAutoSwitch) {
      debugLog(
        `watch: skipping auto switch for requestId=${quotaSignal.requestId} because the event is informational only`,
      );
      return;
    }

    const lock = await tryAcquireSwitchLock(store, "watch");
    if (!lock.acquired) {
      debugLog(`watch: switch lock is busy at ${lock.lockPath}`);
      streams.stdout.write(
        `${formatWatchLogLine(
          describeWatchAutoSwitchSkippedEvent(currentWatchAccountLabel, "lock-busy"),
        )}\n`,
      );
      return;
    }

    const now = Date.now();
    if (switchInFlight || now - lastSwitchStartedAt < watchSwitchCooldownMs) {
      await lock.release();
      debugLog(
        `watch: skipped auto switch for requestId=${quotaSignal.requestId} because another switch is already in progress`,
      );
      return;
    }

    switchInFlight = true;
    lastSwitchStartedAt = now;

    try {
      const autoSwitchResult = await performAutoSwitch(store, desktopLauncher, {
        dryRun: false,
        force: false,
        signal: interruptSignal,
        statusStream: streams.stderr,
        statusDelayMs: managedDesktopWaitStatusDelayMs,
        statusIntervalMs: managedDesktopWaitStatusIntervalMs,
        timeoutMs: WATCH_AUTO_SWITCH_TIMEOUT_MS,
        debugLog,
      });

      if (autoSwitchResult.skipped) {
        currentWatchAccountLabel = autoSwitchResult.selected.name;
        streams.stdout.write(
          `${formatWatchLogLine(
            describeWatchAutoSwitchSkippedEvent(currentWatchAccountLabel, "already-best"),
          )}\n`,
        );
      } else if (autoSwitchResult.result) {
        const previousAccountLabel = currentWatchAccountLabel;
        currentWatchAccountLabel = autoSwitchResult.result.account.name;
        streams.stdout.write(
          `${formatWatchLogLine(
            describeWatchAutoSwitchEvent(
              previousAccountLabel,
              currentWatchAccountLabel,
              autoSwitchResult.result.warnings,
            ),
          )}\n`,
        );
      }

      if (autoSwitchResult.refreshResult.failures.length > 0) {
        watchExitCode = 1;
      }
    } finally {
      switchInFlight = false;
      await lock.release();
    }
  };

  let quotaReadTimer: NodeJS.Timeout | null = null;
  let idleQuotaReadTimer: NodeJS.Timeout | null = null;
  let quotaReadInFlight = false;
  let lastQuotaReadStartedAt = 0;
  let pendingQuotaReadReason: string | null = null;
  let watchStopped = false;

  const clearQuotaReadTimer = () => {
    if (quotaReadTimer) {
      clearTimeout(quotaReadTimer);
      quotaReadTimer = null;
    }
  };

  const readManagedQuotaForWatch = async (reason: string) => {
    if (watchStopped || interruptSignal?.aborted) {
      return;
    }

    if (quotaReadInFlight) {
      pendingQuotaReadReason = reason;
      return;
    }

    quotaReadInFlight = true;
    lastQuotaReadStartedAt = Date.now();
    debugLog(`watch: reading managed Desktop quota reason=${reason}`);
    try {
      const quota = await tryReadManagedDesktopQuota(desktopLauncher, debugLog);
      if (watchStopped || interruptSignal?.aborted) {
        return;
      }
      await handleQuotaReadResult({
        requestId: `poll:${reason}`,
        quota,
        shouldAutoSwitch: isTerminalWatchQuota(quota),
      });
    } finally {
      quotaReadInFlight = false;
      const nextReason = pendingQuotaReadReason;
      pendingQuotaReadReason = null;
      if (nextReason && !watchStopped && !interruptSignal?.aborted) {
        scheduleQuotaRead(nextReason);
      }
    }
  };

  const scheduleQuotaRead = (reason: string): void => {
    if (watchStopped || interruptSignal?.aborted) {
      return;
    }

    pendingQuotaReadReason = reason;
    if (quotaReadTimer || quotaReadInFlight) {
      return;
    }

    const elapsedMs =
      lastQuotaReadStartedAt === 0
        ? watchQuotaMinReadIntervalMs
        : Date.now() - lastQuotaReadStartedAt;
    const delayMs = Math.max(0, watchQuotaMinReadIntervalMs - elapsedMs);
    debugLog(`watch: scheduled quota read reason=${reason} delay_ms=${delayMs}`);
    quotaReadTimer = setTimeout(() => {
      quotaReadTimer = null;
      const queuedReason = pendingQuotaReadReason ?? reason;
      pendingQuotaReadReason = null;
      void readManagedQuotaForWatch(queuedReason).catch((error) => {
        watchExitCode = 1;
        streams.stderr.write(`Error: ${(error as Error).message}\n`);
      });
    }, delayMs);
  };

  const scheduleIdleQuotaRead = () => {
    if (watchStopped || interruptSignal?.aborted || watchQuotaIdleReadIntervalMs <= 0) {
      return;
    }

    idleQuotaReadTimer = setTimeout(() => {
      idleQuotaReadTimer = null;
      scheduleQuotaRead("idle");
      scheduleIdleQuotaRead();
    }, watchQuotaIdleReadIntervalMs);
  };

  try {
    await readManagedQuotaForWatch("startup");
    scheduleIdleQuotaRead();

    await desktopLauncher.watchManagedQuotaSignals({
      signal: interruptSignal,
      debugLogger: debug
        ? (line) => {
            streams.stderr.write(`${line}\n`);
          }
        : undefined,
      onStatus: (event) => {
        streams.stderr.write(
          `${formatWatchLogLine(describeWatchStatusEvent(currentWatchAccountLabel, event))}\n`,
        );
      },
      onActivitySignal: (activitySignal: ManagedWatchActivitySignal) => {
        debugLog(
          `watch: activity signal matched reason=${activitySignal.reason} requestId=${activitySignal.requestId}`,
        );
        scheduleQuotaRead(activitySignal.reason);
      },
      onQuotaSignal: async (quotaSignal: ManagedQuotaSignal) => {
        debugLog(
          `watch: quota signal matched reason=${quotaSignal.reason} requestId=${quotaSignal.requestId}`,
        );

        const quota = await tryReadManagedDesktopQuota(
          desktopLauncher,
          debugLog,
          quotaSignal.quota,
        );
        await handleQuotaReadResult({
          requestId: quotaSignal.requestId,
          quota,
          shouldAutoSwitch: quotaSignal.shouldAutoSwitch,
        });
      },
    });
  } finally {
    watchStopped = true;
    clearQuotaReadTimer();
    if (idleQuotaReadTimer) {
      clearTimeout(idleQuotaReadTimer);
    }
  }

  return watchExitCode;
}
