import { homedir } from "node:os";
import { join } from "node:path";

import {
  isManagedDesktopProcess,
  pathExistsViaStat,
  readProcessParentAndCommand,
  type LaunchProcessLike,
} from "./process.js";
import {
  CODEX_APP_NAME,
  CODEX_BINARY_SUFFIX,
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  delay,
} from "./shared.js";
import type { ExecFileLike, ManagedCodexDesktopState, RunningCodexDesktop } from "./types.js";

export async function findInstalledDesktopApp(execFileImpl: ExecFileLike): Promise<string | null> {
  const candidates = [
    "/Applications/Codex.app",
    join(homedir(), "Applications", "Codex.app"),
  ];

  for (const candidate of candidates) {
    if (await pathExistsViaStat(execFileImpl, candidate)) {
      return candidate;
    }
  }

  try {
    const { stdout } = await execFileImpl("mdfind", [
      'kMDItemFSName == "Codex.app"',
    ]);

    for (const line of stdout.split("\n")) {
      const candidate = line.trim();
      if (candidate === "") {
        continue;
      }

      if (await pathExistsViaStat(execFileImpl, candidate)) {
        return candidate;
      }
    }
  } catch {
    // Keep the lookup best-effort and fall back to null below.
  }

  return null;
}

export async function listRunningDesktopApps(execFileImpl: ExecFileLike): Promise<RunningCodexDesktop[]> {
  const { stdout } = await execFileImpl("ps", ["-Ao", "pid=,command="]);
  const running: RunningCodexDesktop[] = [];

  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const command = match[2];

    if (pid === process.pid || !command.includes(CODEX_BINARY_SUFFIX)) {
      continue;
    }

    running.push({ pid, command });
  }

  return running;
}

export async function isRunningInsideDesktopShell(execFileImpl: ExecFileLike): Promise<boolean> {
  let currentPid = process.ppid;
  const visited = new Set<number>();

  while (currentPid > 1 && !visited.has(currentPid)) {
    visited.add(currentPid);
    const processInfo = await readProcessParentAndCommand(execFileImpl, currentPid);
    if (!processInfo) {
      return false;
    }

    if (processInfo.command.includes(CODEX_BINARY_SUFFIX)) {
      return true;
    }

    currentPid = processInfo.ppid;
  }

  return false;
}

export async function quitRunningDesktopApps(
  execFileImpl: ExecFileLike,
  options?: { force?: boolean },
): Promise<void> {
  const running = await listRunningDesktopApps(execFileImpl);
  if (running.length === 0) {
    return;
  }

  if (options?.force === true) {
    const pids = running.map((app) => String(app.pid));
    await execFileImpl("kill", ["-TERM", ...pids]);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const remaining = await listRunningDesktopApps(execFileImpl);
      if (remaining.length === 0) {
        return;
      }

      await delay(300);
    }

    const remaining = await listRunningDesktopApps(execFileImpl);
    if (remaining.length === 0) {
      return;
    }

    await execFileImpl("kill", ["-KILL", ...remaining.map((app) => String(app.pid))]);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const stillRunning = await listRunningDesktopApps(execFileImpl);
      if (stillRunning.length === 0) {
        return;
      }

      await delay(100);
    }

    throw new Error("Timed out waiting for Codex Desktop to terminate.");
  }

  await execFileImpl("osascript", ["-e", `tell application "${CODEX_APP_NAME}" to quit`]);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const remaining = await listRunningDesktopApps(execFileImpl);
    if (remaining.length === 0) {
      return;
    }

    await delay(300);
  }

  throw new Error("Timed out waiting for Codex Desktop to quit.");
}

export async function launchDesktopApp(
  launchProcessImpl: LaunchProcessLike,
  appPath: string,
  options?: { apiBaseUrl?: string | null },
): Promise<void> {
  const binaryPath = `${appPath}${CODEX_BINARY_SUFFIX}`;

  await launchProcessImpl({
    appPath,
    binaryPath,
    args: [`--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`],
    env: options && Object.prototype.hasOwnProperty.call(options, "apiBaseUrl")
      ? {
          CODEX_API_BASE_URL: options.apiBaseUrl ?? "",
        }
      : undefined,
  });
}

export async function activateDesktopApp(
  execFileImpl: ExecFileLike,
  appPath: string,
): Promise<void> {
  if (appPath.trim() === "") {
    throw new Error("App path is required to activate Codex Desktop.");
  }

  await execFileImpl("osascript", ["-e", `tell application "${CODEX_APP_NAME}" to activate`]);
}

export async function isManagedDesktopStillRunning(
  execFileImpl: ExecFileLike,
  state: ManagedCodexDesktopState | null,
): Promise<boolean> {
  if (!state) {
    return false;
  }

  const runningApps = await listRunningDesktopApps(execFileImpl);
  return isManagedDesktopProcess(runningApps, state);
}
