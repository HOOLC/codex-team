import { ensureAccountName, type AccountStore } from "../account-store/index.js";
import { maskAccountId } from "../auth-snapshot.js";
import type { ParsedArgs } from "../cli/args.js";
import type { CodexDesktopLauncher } from "../desktop/launcher.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import {
  confirmDesktopRelaunch,
  isOnlyManagedDesktopInstanceRunning,
  resolveManagedDesktopState,
  restoreLaunchBackup,
} from "../desktop/managed-state.js";
import { getPlatform } from "../platform.js";
import type { DaemonProcessManager } from "../daemon/process.js";
import { defaultDaemonState } from "../daemon/state.js";
import { proxyBackendBaseUrl, proxyOpenAIBaseUrl, resolveProxyPort } from "../proxy/constants.js";
import { isSyntheticProxyRuntimeActive, markProxyRoutingDisabled } from "../proxy/runtime.js";
import {
  describeBusySwitchLock,
  resolveManagedAccountByName,
  selectAutoSwitchAccount,
  stripManagedDesktopWarning,
  tryAcquireSwitchLock,
} from "../switching.js";
import { runCliWatchSession, runManagedDesktopWatchSession } from "../watch/session.js";

const INTERNAL_LAUNCH_REFUSAL_MESSAGE =
  'Refusing to run "codexm launch" from inside Codex Desktop because quitting the app would terminate this session. Run this command from an external terminal instead.';

interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export async function handleLaunchCommand(options: {
  parsed: ParsedArgs;
  json: boolean;
  debug: boolean;
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  daemonProcessManager: DaemonProcessManager;
  streams: CliStreams;
  debugLog: (message: string) => void;
}): Promise<number> {
  const {
    parsed,
    json,
    debug,
    store,
    desktopLauncher,
    daemonProcessManager,
    streams,
    debugLog,
  } = options;

  const name = parsed.positionals[0] ?? null;
  const auto = parsed.flags.has("--auto");

  if (
    parsed.positionals.length > 1 ||
    (auto && name)
  ) {
    throw new Error(`Usage: ${getUsage("launch")}`);
  }
  if (name) {
    ensureAccountName(name);
  }

  if (await desktopLauncher.isRunningInsideDesktopShell()) {
    throw new Error(INTERNAL_LAUNCH_REFUSAL_MESSAGE);
  }

  const launchPlatform = await getPlatform();
  if (launchPlatform !== "darwin") {
    throw new Error(
      launchPlatform === "wsl"
        ? "codexm launch is not supported on WSL. Use \"codexm run [-- ...args]\" to start codex with auto-restart on auth changes."
        : "codexm launch is not supported on Linux. Use \"codexm run [-- ...args]\" to start codex with auto-restart on auth changes.",
    );
  }

  const warnings: string[] = [];
  const appPath = await desktopLauncher.findInstalledApp();
  if (!appPath) {
    throw new Error("Codex Desktop not found at /Applications/Codex.app.");
  }
  debugLog(`launch: requested_account=${name ?? "current"}`);
  debugLog(`launch: using app path ${appPath}`);

  const runningApps = await desktopLauncher.listRunningApps();
  debugLog(`launch: running_desktop_instances=${runningApps.length}`);
  if (runningApps.length > 0) {
    const managedDesktopState = await desktopLauncher.readManagedState();
    const canRelaunchGracefully = isOnlyManagedDesktopInstanceRunning(
      runningApps,
      managedDesktopState,
      launchPlatform,
    );
    const confirmed = await confirmDesktopRelaunch(
      streams,
      canRelaunchGracefully
        ? "Codex Desktop is already running. Close it and relaunch with the selected auth? [y/N] "
        : "Codex Desktop is already running outside codexm. Force-kill it and relaunch with the selected auth? [y/N] ",
    );
    if (!confirmed) {
      if (json) {
        writeJson(streams.stdout, {
          ok: false,
          action: "launch",
          cancelled: true,
        });
      } else {
        streams.stdout.write("Aborted.\n");
      }
      return 1;
    }

    await desktopLauncher.quitRunningApps({ force: !canRelaunchGracefully });
  }

  let switchedAccount: Awaited<ReturnType<AccountStore["switchAccount"]>>["account"] | null = null;
  let switchBackupPath: string | null = null;
  let proxyModeWasActive = false;
  const requestedTargetName = name;

  if (auto || requestedTargetName) {
    const launchCommand = auto ? "launch --auto" : `launch ${requestedTargetName}`;
    const lock = await tryAcquireSwitchLock(store, launchCommand);
    if (!lock.acquired) {
      throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
    }

    try {
      const targetName = auto
        ? (await selectAutoSwitchAccount(store)).selected.name
        : requestedTargetName;
      if (auto) {
        debugLog(`launch: auto-selected account=${targetName ?? "current"}`);
      }
      const currentStatus = await store.getCurrentStatus();
      if (targetName && !currentStatus.matched_accounts.includes(targetName)) {
        proxyModeWasActive = await isSyntheticProxyRuntimeActive(store);
        const switchResult = await store.switchAccount(targetName);
        warnings.push(...stripManagedDesktopWarning(switchResult.warnings));
        switchedAccount = switchResult.account;
        switchBackupPath = switchResult.backup_path;
        debugLog(`launch: pre-switched account=${switchResult.account.name}`);
      } else if (targetName) {
        switchedAccount = await resolveManagedAccountByName(store, targetName);
      }

      try {
        await desktopLauncher.launch(appPath);
        const managedState = await resolveManagedDesktopState(
          desktopLauncher,
          appPath,
          runningApps,
          launchPlatform,
        );
        if (!managedState) {
          await desktopLauncher.clearManagedState().catch(() => undefined);
          throw new Error(
            "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
          );
        }
        await desktopLauncher.writeManagedState(managedState);
        if (proxyModeWasActive) {
          await markProxyRoutingDisabled(store);
        }
        debugLog(
          `launch: recorded managed desktop pid=${managedState.pid} port=${managedState.remote_debugging_port}`,
        );
      } catch (error) {
        if (switchedAccount) {
          await restoreLaunchBackup(store, switchBackupPath).catch(() => undefined);
          debugLog(
            `launch: restored previous auth after failure for account=${switchedAccount.name}`,
          );
        }
        throw error;
      }
    } finally {
      await lock.release();
    }
  } else {
    await desktopLauncher.launch(appPath);
    const managedState = await resolveManagedDesktopState(
      desktopLauncher,
      appPath,
      runningApps,
      launchPlatform,
    );
    if (!managedState) {
      await desktopLauncher.clearManagedState().catch(() => undefined);
      throw new Error(
        "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
      );
    }
    await desktopLauncher.writeManagedState(managedState);
    debugLog(
      `launch: recorded managed desktop pid=${managedState.pid} port=${managedState.remote_debugging_port}`,
    );
  }

  const currentDaemonState = (await daemonProcessManager.getStatus()).state
    ?? defaultDaemonState(store.paths.codexTeamDir);
  const daemonHost = currentDaemonState.host;
  const daemonPort = resolveProxyPort({
    env: process.env,
    fallback: currentDaemonState.port,
  });
  const daemonResult = await daemonProcessManager.ensureConfig({
    stayalive: true,
    watch: currentDaemonState.watch,
    auto_switch: currentDaemonState.watch ? currentDaemonState.auto_switch : false,
    proxy: currentDaemonState.proxy,
    host: daemonHost,
    port: daemonPort,
    debug: currentDaemonState.debug || debug,
    base_url: proxyBackendBaseUrl(daemonHost, daemonPort),
    openai_base_url: proxyOpenAIBaseUrl(daemonHost, daemonPort),
  });

  if (json) {
    writeJson(streams.stdout, {
      ok: true,
      action: "launch",
      account: switchedAccount
        ? {
            name: switchedAccount.name,
            account_id: switchedAccount.account_id,
            user_id: switchedAccount.user_id ?? null,
            identity: switchedAccount.identity,
            auth_mode: switchedAccount.auth_mode,
          }
        : null,
      launched_with_current_auth: switchedAccount === null,
      app_path: appPath,
      relaunched: runningApps.length > 0,
      daemon: {
        action: daemonResult.action,
        pid: daemonResult.state.pid,
        started_at: daemonResult.state.started_at,
        log_path: daemonResult.state.log_path,
        stayalive: daemonResult.state.stayalive,
        autoswitch: daemonResult.state.auto_switch,
        proxy: daemonResult.state.proxy,
      },
      warnings,
    });
  } else {
    if (switchedAccount) {
      streams.stdout.write(
        `Switched to "${switchedAccount.name}" (${maskAccountId(switchedAccount.identity)}).\n`,
      );
    }
    if (runningApps.length > 0) {
      streams.stdout.write("Closed existing Codex Desktop instance and launched a new one.\n");
    }
    streams.stdout.write(
      switchedAccount
        ? `Launched Codex Desktop with "${switchedAccount.name}" (${maskAccountId(switchedAccount.identity)}).\n`
        : "Launched Codex Desktop with current auth.\n",
    );
    const daemonStatusMessage = daemonResult.action === "reused"
      ? `Background daemon already running (pid ${daemonResult.state.pid}).`
      : daemonResult.action === "restarted"
        ? `Restarted background daemon (pid ${daemonResult.state.pid}).`
        : `Started background daemon (pid ${daemonResult.state.pid}).`;
    streams.stdout.write(`${daemonStatusMessage}\n`);
    streams.stdout.write(`Log: ${daemonResult.state.log_path}\n`);
    for (const warning of warnings) {
      streams.stdout.write(`Warning: ${warning}\n`);
    }
  }

  return 0;
}

export async function handleWatchCommand(options: {
  parsed: ParsedArgs;
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  streams: CliStreams;
  interruptSignal?: AbortSignal;
  debug: boolean;
  debugLog: (message: string) => void;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
  watchQuotaMinReadIntervalMs: number;
  watchQuotaIdleReadIntervalMs: number;
}): Promise<number> {
  const {
    parsed,
    store,
    desktopLauncher,
    streams,
    interruptSignal,
    debug,
    debugLog,
    managedDesktopWaitStatusDelayMs,
    managedDesktopWaitStatusIntervalMs,
    watchQuotaMinReadIntervalMs,
    watchQuotaIdleReadIntervalMs,
  } = options;

  if (parsed.positionals.length > 0) {
    throw new Error(`Usage: ${getUsage("watch")}`);
  }

  const autoSwitch = !parsed.flags.has("--no-auto-switch");
  if (parsed.flags.has("--detach") || parsed.flags.has("--status") || parsed.flags.has("--stop")) {
    throw new Error(`Usage: ${getUsage("watch")}`);
  }

  const desktopRunning = await desktopLauncher.isManagedDesktopRunning();
  if (!desktopRunning) {
    return await runCliWatchSession({
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
    });
  }

  return await runManagedDesktopWatchSession({
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
  });
}
