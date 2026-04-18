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
import type { WatchProcessManager } from "../watch/process.js";
import { ensureDetachedWatch } from "../watch/detached.js";
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

function parseAutoSwitchEtaHours(rawValue: string | undefined): number | null {
  if (rawValue === undefined) {
    return null;
  }

  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("--auto-switch-eta-hours must be a positive number.");
  }

  return numeric;
}

export async function handleLaunchCommand(options: {
  parsed: ParsedArgs;
  json: boolean;
  debug: boolean;
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  watchProcessManager: WatchProcessManager;
  streams: CliStreams;
  debugLog: (message: string) => void;
}): Promise<number> {
  const {
    parsed,
    json,
    debug,
    store,
    desktopLauncher,
    watchProcessManager,
    streams,
    debugLog,
  } = options;

  const name = parsed.positionals[0] ?? null;
  const auto = parsed.flags.has("--auto");
  const watch = parsed.flags.has("--watch");
  const noAutoSwitch = parsed.flags.has("--no-auto-switch");
  const autoSwitchEtaHours = parseAutoSwitchEtaHours(
    parsed.optionValues.get("--auto-switch-eta-hours"),
  );

  if (
    parsed.positionals.length > 1 ||
    (auto && name) ||
    (noAutoSwitch && !watch) ||
    (autoSwitchEtaHours !== null && !watch) ||
    (noAutoSwitch && autoSwitchEtaHours !== null)
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
  const watchAutoSwitch = !noAutoSwitch;
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

  let detachedWatchResult:
    | Awaited<ReturnType<typeof ensureDetachedWatch>>
    | null = null;
  if (watch) {
    detachedWatchResult = await ensureDetachedWatch(watchProcessManager, {
      autoSwitch: watchAutoSwitch,
      autoSwitchEtaHours,
      debug,
    });
  }

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
      watch:
        detachedWatchResult === null
          ? null
          : {
              action: detachedWatchResult.action,
              pid: detachedWatchResult.state.pid,
              started_at: detachedWatchResult.state.started_at,
              log_path: detachedWatchResult.state.log_path,
              auto_switch: detachedWatchResult.state.auto_switch,
              auto_switch_eta_hours: detachedWatchResult.state.auto_switch_eta_hours,
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
    if (detachedWatchResult) {
      if (detachedWatchResult.action === "reused") {
        streams.stdout.write(
          `Background watch already running (pid ${detachedWatchResult.state.pid}).\n`,
        );
      } else {
        streams.stdout.write(
          `Started background watch (pid ${detachedWatchResult.state.pid}).\n`,
        );
      }
      streams.stdout.write(`Log: ${detachedWatchResult.state.log_path}\n`);
    }
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
  watchProcessManager: WatchProcessManager;
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
    watchProcessManager,
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
  const detach = parsed.flags.has("--detach");
  const status = parsed.flags.has("--status");
  const stop = parsed.flags.has("--stop");
  const autoSwitchEtaHours = parseAutoSwitchEtaHours(
    parsed.optionValues.get("--auto-switch-eta-hours"),
  );
  const modeCount = [detach, status, stop].filter(Boolean).length;

  if (
    modeCount > 1 ||
    ((status || stop) &&
      (parsed.flags.has("--no-auto-switch") || autoSwitchEtaHours !== null)) ||
    (!autoSwitch && autoSwitchEtaHours !== null)
  ) {
    throw new Error(`Usage: ${getUsage("watch")}`);
  }

  if (status) {
    const watchStatus = await watchProcessManager.getStatus();
    if (!watchStatus.running || !watchStatus.state) {
      streams.stdout.write("Watch: not running\n");
    } else {
      streams.stdout.write(`Watch: running (pid ${watchStatus.state.pid})\n`);
      streams.stdout.write(`Started at: ${watchStatus.state.started_at}\n`);
      streams.stdout.write(
        `Auto-switch: ${watchStatus.state.auto_switch ? "enabled" : "disabled"}\n`,
      );
      if (watchStatus.state.auto_switch_eta_hours !== null) {
        streams.stdout.write(
          `Auto-switch ETA threshold: ${watchStatus.state.auto_switch_eta_hours}h\n`,
        );
      }
      streams.stdout.write(`Log: ${watchStatus.state.log_path}\n`);
    }
    return 0;
  }

  if (stop) {
    const stopResult = await watchProcessManager.stop();
    if (!stopResult.stopped || !stopResult.state) {
      streams.stdout.write("Watch: not running\n");
    } else {
      streams.stdout.write(`Stopped background watch (pid ${stopResult.state.pid}).\n`);
    }
    return 0;
  }

  const desktopRunning = await desktopLauncher.isManagedDesktopRunning();
  if (!desktopRunning && detach) {
    throw new Error(
      "Detached CLI watch is not yet supported. Run \"codexm watch\" in the foreground instead.",
    );
  }

  if (!desktopRunning) {
    return await runCliWatchSession({
      store,
      desktopLauncher,
      streams,
      interruptSignal,
      autoSwitch,
      autoSwitchEtaHours,
      debug,
      debugLog,
      watchQuotaMinReadIntervalMs,
      managedDesktopWaitStatusDelayMs,
      managedDesktopWaitStatusIntervalMs,
    });
  }

  if (detach) {
    const detachedState = await watchProcessManager.startDetached({
      autoSwitch,
      autoSwitchEtaHours,
      debug,
    });
    streams.stdout.write(`Started background watch (pid ${detachedState.pid}).\n`);
    streams.stdout.write(`Log: ${detachedState.log_path}\n`);
    return 0;
  }

  return await runManagedDesktopWatchSession({
    store,
    desktopLauncher,
    streams,
    interruptSignal,
    autoSwitch,
    autoSwitchEtaHours,
    debug,
    debugLog,
    managedDesktopWaitStatusDelayMs,
    managedDesktopWaitStatusIntervalMs,
    watchQuotaMinReadIntervalMs,
    watchQuotaIdleReadIntervalMs,
  });
}
