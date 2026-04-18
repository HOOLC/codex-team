import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import { type AccountStore } from "../account-store/index.js";
import { type CodexDesktopLauncher } from "../desktop/launcher.js";
import {
  prepareIsolatedCodexRun,
  startIsolatedQuotaHistorySampler,
  type PreparedIsolatedCodexRun,
} from "../run/isolated-runtime.js";
import {
  createWatchLeaseManager,
  type WatchLeaseManager,
} from "../watch/lease.js";
import type { WatchProcessManager } from "../watch/process.js";
import { runManagedDesktopWatchSession } from "../watch/session.js";
import {
  type AccountDashboardExternalUpdate,
} from "../tui/index.js";
import { type RunnerOptions, type RunnerResult } from "../codex-cli-runner.js";

export type DebugLogger = (message: string) => void;

export interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface AccountDashboardExternalUpdateFeed {
  emit: (update: AccountDashboardExternalUpdate) => void;
  subscribe: (
    listener: (update: AccountDashboardExternalUpdate) => void,
  ) => (() => void);
}

export interface TuiExternalUpdateMonitors {
  reconcileNow(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_TUI_WATCH_QUOTA_MIN_READ_INTERVAL_MS = 30_000;
const DEFAULT_TUI_WATCH_QUOTA_IDLE_READ_INTERVAL_MS = 120_000;
const DEFAULT_TUI_WATCH_LEASE_POLL_INTERVAL_MS = 5_000;
const TUI_SWITCH_NOTICE_DEDUPE_MS = 1_500;

export function createAccountDashboardExternalUpdateFeed(): AccountDashboardExternalUpdateFeed {
  let listener: ((update: AccountDashboardExternalUpdate) => void) | null = null;
  const queued: AccountDashboardExternalUpdate[] = [];

  return {
    emit(update) {
      if (listener) {
        listener(update);
        return;
      }

      queued.push(update);
    },
    subscribe(nextListener) {
      listener = nextListener;
      for (const update of queued.splice(0)) {
        nextListener(update);
      }

      return () => {
        if (listener === nextListener) {
          listener = null;
        }
      };
    },
  };
}

export async function resolveCurrentManagedAccountLabel(
  store: AccountStore,
): Promise<string | null> {
  try {
    const current = await store.getCurrentStatus();
    return current.matched_accounts.length === 1 ? current.matched_accounts[0] : null;
  } catch {
    return null;
  }
}

function createNullWriteStream(): NodeJS.WriteStream {
  return {
    write: () => true,
  } as unknown as NodeJS.WriteStream;
}

function describeCurrentAccountSwitchMessage(
  previousAccount: string | null,
  nextAccount: string | null,
): string {
  if (previousAccount && nextAccount) {
    return `Current account switched from "${previousAccount}" to "${nextAccount}".`;
  }

  if (nextAccount) {
    return `Current account switched to "${nextAccount}".`;
  }

  return "Current managed account changed.";
}

function describeForegroundAutoSwitchMessage(
  previousAccount: string,
  nextAccount: string,
  warnings: string[],
): string {
  const base = `Auto-switched from "${previousAccount}" to "${nextAccount}".`;
  return warnings.length > 0 ? `${base} Warning: ${warnings[0]}` : base;
}

export async function startTuiExternalUpdateMonitors(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  watchProcessManager: WatchProcessManager;
  watchLeaseManager?: WatchLeaseManager;
  updateFeed: AccountDashboardExternalUpdateFeed;
  currentManagedAccountRef: { value: string | null };
  localSwitchInFlightRef: { value: boolean };
  debugLog?: DebugLogger;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
  foregroundWatchLeasePollIntervalMs?: number;
  authWatchImpl?: typeof watch;
}): Promise<TuiExternalUpdateMonitors> {
  const {
    store,
    desktopLauncher,
    watchProcessManager,
    updateFeed,
    currentManagedAccountRef,
    localSwitchInFlightRef,
    debugLog,
    managedDesktopWaitStatusDelayMs,
    managedDesktopWaitStatusIntervalMs,
    foregroundWatchLeasePollIntervalMs = DEFAULT_TUI_WATCH_LEASE_POLL_INTERVAL_MS,
    authWatchImpl,
  } = options;
  const watchLeaseManager =
    options.watchLeaseManager ?? createWatchLeaseManager(store.paths.codexTeamDir);
  const authWatchDir = dirname(store.paths.currentAuthPath);
  const authWatchFileName = basename(store.paths.currentAuthPath);
  let stopped = false;
  let authWatcher: FSWatcher | null = null;
  let authDebounceTimer: NodeJS.Timeout | null = null;
  let authWatcherRestartTimer: NodeJS.Timeout | null = null;
  let foregroundWatchPollTimer: NodeJS.Timeout | null = null;
  let foregroundWatchAbortController: AbortController | null = null;
  let foregroundWatchPromise: Promise<number> | null = null;
  let recentSwitchTarget: { value: string | null; recordedAt: number } | null = null;
  let ownsForegroundWatchLease = false;
  let startedForegroundWatch = false;

  const shouldSuppressSwitchNotice = (targetAccount: string | null): boolean =>
    recentSwitchTarget !== null &&
    recentSwitchTarget.value === targetAccount &&
    Date.now() - recentSwitchTarget.recordedAt < TUI_SWITCH_NOTICE_DEDUPE_MS;

  const recordSwitchNotice = (targetAccount: string | null) => {
    recentSwitchTarget = {
      value: targetAccount,
      recordedAt: Date.now(),
    };
  };

  const syncCurrentManagedAccount = async () => {
    const nextAccount = await resolveCurrentManagedAccountLabel(store);
    if (nextAccount === currentManagedAccountRef.value) {
      return;
    }

    const previousAccount = currentManagedAccountRef.value;
    currentManagedAccountRef.value = nextAccount;

    if (localSwitchInFlightRef.value || shouldSuppressSwitchNotice(nextAccount)) {
      return;
    }

    recordSwitchNotice(nextAccount);
    updateFeed.emit({
      statusMessage: describeCurrentAccountSwitchMessage(previousAccount, nextAccount),
      preferredName: nextAccount,
    });
  };

  const stopAuthWatcher = () => {
    if (authDebounceTimer) {
      clearTimeout(authDebounceTimer);
      authDebounceTimer = null;
    }
    if (authWatcherRestartTimer) {
      clearTimeout(authWatcherRestartTimer);
      authWatcherRestartTimer = null;
    }
    if (authWatcher) {
      authWatcher.close();
      authWatcher = null;
    }
  };

  const startAuthWatcher = () => {
    try {
      authWatcher = (authWatchImpl ?? watch)(
        authWatchDir,
        { persistent: false },
        (_eventType, filename) => {
          const normalizedName =
            typeof filename === "string" || Buffer.isBuffer(filename)
              ? String(filename)
              : null;
          if (normalizedName && normalizedName !== authWatchFileName) {
            return;
          }

          if (authDebounceTimer) {
            clearTimeout(authDebounceTimer);
          }

          authDebounceTimer = setTimeout(() => {
            authDebounceTimer = null;
            void syncCurrentManagedAccount().catch((error) => {
              debugLog?.(`tui: failed to sync current account after auth change: ${(error as Error).message}`);
            });
          }, 150);
        },
      );

      authWatcher.on("error", (error) => {
        debugLog?.(`tui: auth watcher error: ${error.message}`);
        authWatcherRestartTimer = setTimeout(() => {
          if (stopped) {
            return;
          }

          stopAuthWatcher();
          startAuthWatcher();
        }, 1_000);
      });
    } catch (error) {
      debugLog?.(`tui: failed to start auth watcher: ${(error as Error).message}`);
    }
  };

  startAuthWatcher();

  const getDetachedWatchStatus = async () =>
    await watchProcessManager.getStatus().catch((error) => {
      debugLog?.(`tui: failed to inspect detached watch status: ${(error as Error).message}`);
      return {
        running: false,
        state: null,
      };
    });

  const getActiveWatchLease = async () =>
    await watchLeaseManager.getStatus().catch((error) => {
      debugLog?.(`tui: failed to inspect watch lease status: ${(error as Error).message}`);
      return {
        active: false,
        state: null,
      };
    });

  const releaseForegroundWatchLease = async () => {
    if (!ownsForegroundWatchLease) {
      return;
    }

    ownsForegroundWatchLease = false;
    await watchLeaseManager.release({
      ownerKind: "tui-foreground",
      pid: process.pid,
    }).catch((error) => {
      debugLog?.(`tui: failed to release foreground watch lease: ${(error as Error).message}`);
    });
  };

  const stopForegroundWatch = async () => {
    if (foregroundWatchAbortController) {
      foregroundWatchAbortController.abort();
    }

    await foregroundWatchPromise?.catch(() => undefined);
    foregroundWatchAbortController = null;
    foregroundWatchPromise = null;
    await releaseForegroundWatchLease();
  };

  const startForegroundWatch = async () => {
    if (foregroundWatchPromise) {
      return;
    }

    const detachedWatchStatus = await getDetachedWatchStatus();
    if (detachedWatchStatus.running) {
      return;
    }

    const activeLease = await getActiveWatchLease();
    if (activeLease.active && activeLease.state) {
      if (
        activeLease.state.owner_kind !== "tui-foreground"
        || activeLease.state.pid !== process.pid
      ) {
        return;
      }
    }

    const managedDesktopRunning = await desktopLauncher.isManagedDesktopRunning().catch((error) => {
      debugLog?.(`tui: failed to inspect managed desktop status: ${(error as Error).message}`);
      return false;
    });
    if (!managedDesktopRunning) {
      return;
    }

    const lease = await watchLeaseManager.claimForeground({
      autoSwitch: true,
      autoSwitchEtaHours: null,
      debug: false,
      pid: process.pid,
    }).catch((error) => {
      debugLog?.(`tui: failed to claim foreground watch lease: ${(error as Error).message}`);
      return {
        acquired: false,
        state: null,
      };
    });
    if (!lease.acquired) {
      return;
    }

    ownsForegroundWatchLease = true;
    startedForegroundWatch = true;
    foregroundWatchAbortController = new AbortController();
    const silentStream = createNullWriteStream();

    foregroundWatchPromise = runManagedDesktopWatchSession({
      store,
      desktopLauncher,
      streams: {
        stdout: silentStream,
        stderr: silentStream,
      },
      interruptSignal: foregroundWatchAbortController.signal,
      autoSwitch: true,
      autoSwitchEtaHours: null,
      debug: false,
      debugLog: debugLog ?? (() => undefined),
      managedDesktopWaitStatusDelayMs,
      managedDesktopWaitStatusIntervalMs,
      watchQuotaMinReadIntervalMs: DEFAULT_TUI_WATCH_QUOTA_MIN_READ_INTERVAL_MS,
      watchQuotaIdleReadIntervalMs: DEFAULT_TUI_WATCH_QUOTA_IDLE_READ_INTERVAL_MS,
      onAutoSwitchEvent: async (event) => {
        if (event.type !== "switched") {
          return;
        }

        currentManagedAccountRef.value = event.toAccount;
        if (shouldSuppressSwitchNotice(event.toAccount)) {
          return;
        }

        recordSwitchNotice(event.toAccount);
        updateFeed.emit({
          statusMessage: describeForegroundAutoSwitchMessage(
            event.fromAccount,
            event.toAccount,
            event.warnings,
          ),
          preferredName: event.toAccount,
        });
      },
    }).then((exitCode) => {
      if (!stopped && exitCode !== 0) {
        updateFeed.emit({
          statusMessage: "Foreground watch stopped after an error.",
        });
      }
      return exitCode;
    }).catch((error) => {
      if (!stopped && !foregroundWatchAbortController?.signal.aborted) {
        debugLog?.(`tui: foreground watch failed: ${(error as Error).message}`);
        updateFeed.emit({
          statusMessage: `Foreground watch failed: ${(error as Error).message}`,
        });
      }
      return 1;
    }).finally(async () => {
      foregroundWatchAbortController = null;
      foregroundWatchPromise = null;
      await releaseForegroundWatchLease();
    });
  };

  const reconcileForegroundWatch = async () => {
    if (stopped) {
      return;
    }

    if (foregroundWatchPromise) {
      const detachedWatchStatus = await getDetachedWatchStatus();
      if (detachedWatchStatus.running) {
        await stopForegroundWatch();
        return;
      }

      const activeLease = await getActiveWatchLease();
      if (
        activeLease.active
        && activeLease.state
        && (
          activeLease.state.owner_kind !== "tui-foreground"
          || activeLease.state.pid !== process.pid
        )
      ) {
        await stopForegroundWatch();
      }
      return;
    }

    await startForegroundWatch();
  };

  await reconcileForegroundWatch();
  foregroundWatchPollTimer = setInterval(() => {
    void reconcileForegroundWatch();
  }, foregroundWatchLeasePollIntervalMs);

  return {
    async reconcileNow() {
      await reconcileForegroundWatch();
    },
    async stop() {
      stopped = true;
      stopAuthWatcher();
      if (foregroundWatchPollTimer) {
        clearInterval(foregroundWatchPollTimer);
        foregroundWatchPollTimer = null;
      }

      const detachedWatchStatusBeforeStop = await getDetachedWatchStatus();
      const shouldHandoffForegroundWatch =
        startedForegroundWatch && !detachedWatchStatusBeforeStop.running;

      await stopForegroundWatch();

      if (shouldHandoffForegroundWatch) {
        const activeLease = await getActiveWatchLease();
        if (!activeLease.active) {
          await watchProcessManager.startDetached({
            autoSwitch: true,
            autoSwitchEtaHours: null,
            debug: false,
          }).catch((error) => {
            debugLog?.(`tui: failed to hand off to detached watch: ${(error as Error).message}`);
          });
        }
      }
    },
  };
}

export async function runDashboardCodexSession(options: {
  store: AccountStore;
  runCodexCli: (options: RunnerOptions) => Promise<RunnerResult>;
  debugLog?: DebugLogger;
  stderr: NodeJS.WriteStream;
  signal?: AbortSignal;
}): Promise<number> {
  const currentStatus = await options.store.getCurrentStatus();
  return (await options.runCodexCli({
    codexArgs: [],
    accountId: currentStatus.account_id,
    email: null,
    debugLog: options.debugLog,
    stderr: options.stderr,
    signal: options.signal,
  })).exitCode;
}

export async function runDashboardIsolatedCodexSession(options: {
  accountName: string;
  store: AccountStore;
  runCodexCli: (options: RunnerOptions) => Promise<RunnerResult>;
  debugLog?: DebugLogger;
  stderr: NodeJS.WriteStream;
  signal?: AbortSignal;
  prepareIsolatedRunImpl?: (options: {
    accountName: string;
    baseEnv?: NodeJS.ProcessEnv;
    store: AccountStore;
  }) => Promise<PreparedIsolatedCodexRun>;
  startIsolatedQuotaHistorySamplerImpl?: typeof startIsolatedQuotaHistorySampler;
}): Promise<number> {
  const prepareIsolatedRunImpl =
    options.prepareIsolatedRunImpl ?? prepareIsolatedCodexRun;
  const startIsolatedQuotaHistorySamplerImpl =
    options.startIsolatedQuotaHistorySamplerImpl ?? startIsolatedQuotaHistorySampler;
  const preparedRun = await prepareIsolatedRunImpl({
    accountName: options.accountName,
    baseEnv: process.env,
    store: options.store,
  });
  const sampler = startIsolatedQuotaHistorySamplerImpl({
    account: preparedRun.account,
    codexHomeEnv: preparedRun.env,
    pollIntervalMs: DEFAULT_TUI_WATCH_QUOTA_MIN_READ_INTERVAL_MS,
    scopeId: preparedRun.runId,
    store: options.store,
    debugLog: options.debugLog,
  });

  try {
    return (await options.runCodexCli({
      codexArgs: [],
      accountId: preparedRun.account.account_id,
      email: preparedRun.account.email ?? null,
      authFilePath: preparedRun.authFilePath,
      sessionsDirPath: preparedRun.sessionsDirPath,
      env: preparedRun.env,
      disableAuthWatch: true,
      registerProcess: false,
      debugLog: options.debugLog,
      stderr: options.stderr,
      signal: options.signal,
    })).exitCode;
  } finally {
    await sampler.stop();
    await preparedRun.cleanup();
  }
}
