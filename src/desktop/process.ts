import { spawn as spawnCallback } from "node:child_process";

import type {
  ExecFileLike,
  ManagedCodexDesktopState,
  RunningCodexDesktop,
} from "./types.js";
import { CODEX_BINARY_SUFFIX } from "./shared.js";

export type LaunchProcessLike = (options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
  env?: Record<string, string>;
}) => Promise<void>;

type SpawnLike = typeof spawnCallback;

export async function pathExistsViaStat(
  execFileImpl: ExecFileLike,
  path: string,
): Promise<boolean> {
  try {
    await execFileImpl("stat", ["-f", "%N", path]);
    return true;
  } catch {
    return false;
  }
}

export async function readProcessParentAndCommand(
  execFileImpl: ExecFileLike,
  pid: number,
): Promise<{ ppid: number; command: string } | null> {
  try {
    const { stdout } = await execFileImpl("ps", ["-o", "ppid=,command=", "-p", String(pid)]);
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry !== "");
    if (!line) {
      return null;
    }

    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      return null;
    }

    return {
      ppid: Number(match[1]),
      command: match[2],
    };
  } catch {
    return null;
  }
}

export async function readProcessEnvironmentVariable(
  execFileImpl: ExecFileLike,
  pid: number,
  name: string,
): Promise<string | null | undefined> {
  try {
    const { stdout } = await execFileImpl("ps", ["eww", "-p", String(pid)]);
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry !== "" && !entry.startsWith("PID "));
    if (!line) {
      return null;
    }

    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = line.match(new RegExp(`(?:^|\\s)${escapedName}=([^\\s]*)`, "u"));
    if (!match) {
      return null;
    }

    return match[1] === "" ? null : match[1];
  } catch {
    return undefined;
  }
}

export async function launchManagedDesktopProcess(options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
  env?: Record<string, string>;
}, spawnImpl: SpawnLike = spawnCallback): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Launch through LaunchServices so Electron's own update/restart flow can
    // quit and relaunch the app cleanly. Spawning the inner binary directly
    // makes the Desktop behave like an unmanaged executable and can wedge the
    // official "restart to update" path on macOS.
    const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);
    const child = spawnImpl("open", [...envArgs, "-na", options.appPath, "--args", ...options.args], {
      detached: true,
      stdio: "ignore",
    });

    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    child.once("error", (error) => {
      settle(() => reject(error));
    });

    child.once("spawn", () => {
      child.unref();
      settle(resolve);
    });
  });
}

export function isManagedDesktopProcess(
  runningApps: RunningCodexDesktop[],
  state: ManagedCodexDesktopState,
): boolean {
  const expectedBinaryPath = `${state.app_path}${CODEX_BINARY_SUFFIX}`;
  const expectedPort = `--remote-debugging-port=${state.remote_debugging_port}`;

  return runningApps.some(
    (entry) =>
      entry.pid === state.pid &&
      entry.command.includes(expectedBinaryPath) &&
      entry.command.includes(expectedPort),
  );
}
