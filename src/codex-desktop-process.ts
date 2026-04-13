import { spawn as spawnCallback } from "node:child_process";

import type {
  ExecFileLike,
  ManagedCodexDesktopState,
  RunningCodexDesktop,
} from "./codex-desktop-types.js";
import { CODEX_BINARY_SUFFIX } from "./codex-desktop-shared.js";

export type LaunchProcessLike = (options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
}) => Promise<void>;

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

export async function launchManagedDesktopProcess(options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnCallback(options.binaryPath, [...options.args], {
      cwd: options.appPath,
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
