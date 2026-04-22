import { watch } from "node:fs";
import { PassThrough } from "node:stream";

import { type AccountStore } from "../account-store/index.js";
import { getUsage } from "../cli/spec.js";
import { type RunnerOptions, type RunnerResult } from "../codex-cli-runner.js";
import type { DaemonProcessManager } from "../daemon/process.js";
import {
  cleanupStaleDaemonPortConflict,
  createDaemonProcessManager,
} from "../daemon/process.js";
import { triggerDaemonAuthRefresh } from "../daemon/trigger.js";
import { type CodexDesktopLauncher } from "../desktop/launcher.js";
import {
  isOnlyManagedDesktopInstanceRunning,
  launchManagedDesktopSession,
} from "../desktop/managed-state.js";
import { getPlatform } from "../platform.js";
import { PROXY_ACCOUNT_NAME } from "../proxy/constants.js";
import { formatProxyUpstreamSelectionLabel } from "../proxy/request-log.js";
import { createProxyProcessManager, type ProxyProcessManager } from "../proxy/process.js";
import { resolveManagedDesktopApiBaseUrl } from "../proxy/runtime.js";
import {
  runAccountDashboardTui,
  type AccountDashboardExternalUpdate,
} from "../tui/index.js";
import type { WatchLeaseManager } from "../watch/lease.js";
import type { WatchProcessManager } from "../watch/process.js";
import {
  disableAutoswitchMode,
  enableAutoswitchMode,
  readAutoswitchStatus,
} from "./autoswitch.js";
import {
  disableProxyModeWithDesktopRefresh,
  enableProxyModeWithDesktopRefresh,
} from "./proxy.js";
import { performManualSwitch } from "./switch.js";
import {
  buildAccountDashboardSnapshot,
  buildCachedAccountDashboardSnapshot,
} from "./tui-snapshot.js";
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

export { buildAccountDashboardSnapshot, buildCachedAccountDashboardSnapshot } from "./tui-snapshot.js";

export async function handleTuiCommand(options: {
  positionals: string[];
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  daemonProcessManager?: DaemonProcessManager;
  watchProcessManager: WatchProcessManager;
  proxyProcessManager?: ProxyProcessManager;
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
  const daemonProcessManager =
    options.daemonProcessManager ?? createDaemonProcessManager(options.store.paths.codexTeamDir);
  const proxyProcessManager =
    options.proxyProcessManager ?? createProxyProcessManager(options.store.paths.codexTeamDir);
  let nextInitialQuery = initialQuery;
  let queuedExternalUpdate: AccountDashboardExternalUpdate | null = null;

  while (true) {
    const silentStatusStream = new PassThrough() as unknown as NodeJS.WriteStream;
    const initialSnapshot = await buildCachedAccountDashboardSnapshot({
      store: options.store,
      daemonProcessManager,
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
      daemonProcessManager,
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
          daemonProcessManager,
          debugLog: options.debugLog,
        }),
        triggerBackgroundRefresh: async (refreshOptions) => {
          await triggerDaemonAuthRefresh({
            store: options.store,
            daemonProcessManager,
            ensureDaemon: refreshOptions.ensureDaemon,
            source: refreshOptions.source,
          });
        },
        cleanupStaleDaemonProcess: async (conflict) => {
          await cleanupStaleDaemonPortConflict(conflict);
        },
        switchAccount: async (name, switchOptions) => {
          localSwitchInFlightRef.value = true;
          try {
            if (name === PROXY_ACCOUNT_NAME) {
              const proxyCurrentlyActive = currentManagedAccountRef.value === PROXY_ACCOUNT_NAME;
              if (proxyCurrentlyActive && !switchOptions.force) {
                const disabled = await disableProxyModeWithDesktopRefresh({
                  store: options.store,
                  proxyProcessManager,
                  desktopLauncher: options.desktopLauncher,
                  force: false,
                  signal: switchOptions.signal ?? options.interruptSignal,
                  statusStream: silentStatusStream,
                  onStatusMessage: switchOptions.onStatusMessage,
                  managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
                  managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
                });
                currentManagedAccountRef.value = await resolveCurrentManagedAccountLabel(options.store);
                return {
                  statusMessage: "Disabled proxy.",
                  currentName: currentManagedAccountRef.value,
                  proxyUpstreamName: null,
                  proxyLastUpstreamLabel: null,
                  warningMessages: disabled.warnings,
                };
              }

              const enabledProxy = await enableProxyModeWithDesktopRefresh({
                store: options.store,
                proxyProcessManager,
                desktopLauncher: options.desktopLauncher,
                force: switchOptions.force,
                debug: false,
                signal: switchOptions.signal ?? options.interruptSignal,
                statusStream: silentStatusStream,
                onStatusMessage: switchOptions.onStatusMessage,
                managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
                managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
              });
              currentManagedAccountRef.value = PROXY_ACCOUNT_NAME;
              return {
                statusMessage: proxyCurrentlyActive ? "Reloaded proxy." : 'Switched to "proxy".',
                currentName: PROXY_ACCOUNT_NAME,
                warningMessages: [
                  ...enabledProxy.warnings,
                  ...(enabledProxy.desktopForceWarning ? [enabledProxy.desktopForceWarning] : []),
                ],
              };
            }
            const { result, desktopForceWarning, proxyRetained } = await performManualSwitch({
              name,
              force: switchOptions.force,
              store: options.store,
              desktopLauncher: options.desktopLauncher,
              stderr: silentStatusStream,
              onStatusMessage: switchOptions.onStatusMessage,
              debugLog: options.debugLog,
              interruptSignal: switchOptions.signal ?? options.interruptSignal,
              managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
              managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
            });
            currentManagedAccountRef.value = proxyRetained ? PROXY_ACCOUNT_NAME : result.account.name;
            const proxyLastUpstreamLabel = proxyRetained
              ? formatProxyUpstreamSelectionLabel({
                  accountName: result.account.name,
                  authMode: result.account.auth_mode,
                  ts: new Date().toISOString(),
                })
              : undefined;

            return {
              statusMessage: proxyRetained
                ? `Updated proxy upstream to "${result.account.name}" while proxy remains enabled.`
                : `Switched to "${result.account.name}".`,
              currentName: proxyRetained ? PROXY_ACCOUNT_NAME : result.account.name,
              proxyUpstreamName: proxyRetained ? result.account.name : undefined,
              proxyLastUpstreamLabel,
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
          const desktopApiBaseUrl = await resolveManagedDesktopApiBaseUrl(options.store);

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

          const { refreshedAccountSurface } = await launchManagedDesktopSession({
            desktopLauncher: options.desktopLauncher,
            appPath,
            existingApps: runningApps,
            platform,
            desktopApiBaseUrl,
          });
          const warningMessages: string[] = [];
          if (!refreshedAccountSurface) {
            warningMessages.push(
              "Opened Desktop, but codexm could not refresh the in-app account surface yet.",
            );
          }
          await externalUpdateMonitors.reconcileNow();
          return {
            statusMessage: runningApps.length > 0 && desktopOptions.forceRelaunch
              ? `Relaunched Codex Desktop for "${name}".`
              : `Opened Codex Desktop for "${name}".`,
            warningMessages,
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
        toggleAutoSwitchProtection: async (name, eligible) => {
          const account = await options.store.setAutoSwitchEligibility(name, eligible);
          return {
            statusMessage: eligible
              ? `Removed auto-switch protection from "${account.name}".`
              : `Protected "${account.name}" from auto-switch target selection.`,
            preferredName: account.name,
          };
        },
        toggleAutoswitch: async () => {
          const status = await readAutoswitchStatus({
            daemonProcessManager,
          });
          if (status.enabled) {
            await disableAutoswitchMode({
              store: options.store,
              daemonProcessManager,
            });
            await externalUpdateMonitors.reconcileNow();
            return {
              statusMessage: "Disabled autoswitch.",
              preferredName: null,
            };
          }

          await enableAutoswitchMode({
            store: options.store,
            daemonProcessManager,
            debug: false,
          });
          await externalUpdateMonitors.reconcileNow();
          return {
            statusMessage: "Enabled autoswitch.",
            preferredName: null,
          };
        },
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
