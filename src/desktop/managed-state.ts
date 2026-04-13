import { copyFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getSnapshotEmail, parseAuthSnapshot } from "../auth-snapshot.js";
import type { AccountStore } from "../account-store/index.js";
import {
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  type CodexDesktopLauncher,
  type ManagedCodexDesktopState,
  type RunningCodexDesktop,
} from "../desktop/launcher.js";
import { isCodexDesktopCommand, type CodexmPlatform } from "../platform.js";

interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function confirmDesktopRelaunch(
  streams: CliStreams,
  prompt: string,
): Promise<boolean> {
  if (!streams.stdin.isTTY) {
    throw new Error("Refusing to relaunch Codex Desktop in a non-interactive terminal.");
  }

  streams.stdout.write(prompt);

  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      streams.stdin.off("data", onData);
      streams.stdin.pause();
    };

    const onData = (buffer: Buffer) => {
      const answer = buffer.toString("utf8").trim().toLowerCase();
      cleanup();
      streams.stdout.write("\n");
      resolve(answer === "y" || answer === "yes");
    };

    streams.stdin.resume();
    streams.stdin.on("data", onData);
  });
}

export function isRunningDesktopFromApp(
  app: RunningCodexDesktop,
  appPath: string,
  platform: CodexmPlatform = "darwin",
): boolean {
  if (platform === "darwin") {
    return app.command.includes(`${appPath}/Contents/MacOS/Codex`);
  }

  return isCodexDesktopCommand(app.command, platform);
}

export function isOnlyManagedDesktopInstanceRunning(
  runningApps: RunningCodexDesktop[],
  managedState: ManagedCodexDesktopState | null,
  platform: CodexmPlatform = "darwin",
): boolean {
  if (!managedState || runningApps.length === 0) {
    return false;
  }

  return (
    runningApps.length === 1 &&
    runningApps[0].pid === managedState.pid &&
    isRunningDesktopFromApp(runningApps[0], managedState.app_path, platform)
  );
}

export async function resolveManagedDesktopState(
  desktopLauncher: CodexDesktopLauncher,
  appPath: string,
  existingApps: RunningCodexDesktop[],
  platform: CodexmPlatform,
): Promise<ManagedCodexDesktopState | null> {
  const existingPids = new Set(existingApps.map((app) => app.pid));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runningApps = await desktopLauncher.listRunningApps();
    const launchedApp =
      runningApps
        .filter(
          (app) =>
            isRunningDesktopFromApp(app, appPath, platform) && !existingPids.has(app.pid),
        )
        .sort((left, right) => right.pid - left.pid)[0] ??
      runningApps
        .filter((app) => isRunningDesktopFromApp(app, appPath, platform))
        .sort((left, right) => right.pid - left.pid)[0] ??
      null;

    if (launchedApp) {
      return {
        pid: launchedApp.pid,
        app_path: appPath,
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: new Date().toISOString(),
      };
    }

    await sleep(300);
  }

  return null;
}

export async function restoreLaunchBackup(
  store: AccountStore,
  backupPath: string | null,
): Promise<void> {
  if (backupPath && await pathExists(backupPath)) {
    await copyFile(backupPath, store.paths.currentAuthPath);
  } else {
    await rm(store.paths.currentAuthPath, { force: true });
  }

  const configBackupPath = join(store.paths.backupsDir, "last-active-config.toml");
  if (await pathExists(configBackupPath)) {
    await copyFile(configBackupPath, store.paths.currentConfigPath);
  } else {
    await rm(store.paths.currentConfigPath, { force: true });
  }
}

export async function shouldSkipManagedDesktopRefresh(
  store: AccountStore,
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: (message: string) => void,
): Promise<boolean> {
  try {
    const runtimeAccount = await desktopLauncher.readManagedCurrentAccount();
    if (!runtimeAccount?.email || !runtimeAccount.auth_mode) {
      debugLog?.("switch: managed Desktop runtime identity unavailable");
      return false;
    }

    const rawAuth = await readFile(store.paths.currentAuthPath, "utf8");
    const currentSnapshot = parseAuthSnapshot(rawAuth);
    const currentEmail = getSnapshotEmail(currentSnapshot);
    if (!currentEmail) {
      debugLog?.("switch: current auth email unavailable");
      return false;
    }

    const sameAuthMode = runtimeAccount.auth_mode === currentSnapshot.auth_mode;
    const sameEmail = runtimeAccount.email.trim().toLowerCase() === currentEmail.trim().toLowerCase();
    if (!sameAuthMode || !sameEmail) {
      debugLog?.("switch: managed Desktop runtime differs from target auth");
      return false;
    }

    debugLog?.("switch: skipping managed Desktop refresh because runtime already matches target auth");
    return true;
  } catch (error) {
    debugLog?.(`switch: managed Desktop refresh skip check failed: ${(error as Error).message}`);
    return false;
  }
}
