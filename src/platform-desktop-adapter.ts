/**
 * platform-desktop-adapter.ts
 *
 * Platform-aware adapter for CodexDesktopLauncher that adds Linux and WSL
 * support to the macOS-centric codex-desktop-launch.ts module.
 *
 * On macOS: delegates to the original createCodexDesktopLauncher unchanged.
 * On Linux/WSL: provides alternative implementations for process discovery,
 *   app finding, and process management that work without macOS-specific
 *   tools (mdfind, osascript, BSD stat, .app bundles).
 */

import { access } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CodexmPlatform } from "./platform.js";
import { getPlatform } from "./platform.js";
import type {
  ExecFileLike,
  RunningCodexDesktop,
  CodexDesktopLauncher,
} from "./desktop/launcher.js";
import { createCodexDesktopLauncher } from "./desktop/launcher.js";

const execFile = promisify(execFileCallback);

// ── Linux/WSL path candidates ──

const LINUX_CODEX_PATHS = [
  "/usr/local/bin/codex",
  "/usr/bin/codex",
  join(homedir(), ".local", "bin", "codex"),
];

const WSL_WINDOWS_CODEX_PATHS_PATTERNS = [
  "/mnt/c/Users/*/AppData/Local/Programs/codex/Codex.exe",
  "/mnt/c/Program Files/Codex/Codex.exe",
  "/mnt/c/Program Files (x86)/Codex/Codex.exe",
];

// ── Helpers ──

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function whichCodex(execFileImpl: ExecFileLike): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl("which", ["codex"]);
    const result = stdout.trim();
    return result !== "" ? result : null;
  } catch {
    return null;
  }
}

async function findWslWindowsCodex(execFileImpl: ExecFileLike): Promise<string | null> {
  // Try to find Codex Desktop on the Windows side via WSL interop
  for (const pattern of WSL_WINDOWS_CODEX_PATHS_PATTERNS) {
    try {
      const { stdout } = await execFileImpl("bash", ["-c", `ls ${pattern} 2>/dev/null | head -1`]);
      const result = stdout.trim();
      if (result !== "") {
        return result;
      }
    } catch {
      // continue
    }
  }

  // Try wslpath + powershell as fallback
  try {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-Command",
      "Get-Command Codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
    ]);
    const winPath = stdout.trim();
    if (winPath !== "") {
      // Convert Windows path to WSL path
      const { stdout: wslPath } = await execFileImpl("wslpath", ["-u", winPath]);
      return wslPath.trim() || null;
    }
  } catch {
    // powershell.exe not available — that's fine
  }

  return null;
}

// ── Linux/WSL process listing ──

async function listRunningAppsLinux(
  execFileImpl: ExecFileLike,
): Promise<RunningCodexDesktop[]> {
  const running: RunningCodexDesktop[] = [];

  try {
    const { stdout } = await execFileImpl("ps", ["-Ao", "pid=,command="]);

    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }

      const pid = Number(match[1]);
      const command = match[2];

      if (pid === process.pid) {
        continue;
      }

      // Match Codex Desktop processes on Linux
      // Look for electron-based codex or codex with --remote-debugging-port
      if (
        command.includes("--remote-debugging-port") &&
        (command.includes("codex") || command.includes("Codex"))
      ) {
        running.push({ pid, command });
      }
    }
  } catch {
    // ps failed
  }

  return running;
}

async function listRunningAppsWsl(
  execFileImpl: ExecFileLike,
): Promise<RunningCodexDesktop[]> {
  // First check Linux-side processes
  const linuxApps = await listRunningAppsLinux(execFileImpl);

  // Also check Windows-side processes via powershell
  try {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-Command",
      'Get-Process -Name "Codex" -ErrorAction SilentlyContinue | Select-Object Id, Path | ConvertTo-Json',
    ]);

    if (stdout.trim()) {
      let processes: unknown;
      try {
        processes = JSON.parse(stdout.trim());
      } catch {
        processes = null;
      }

      const items = Array.isArray(processes) ? processes : processes ? [processes] : [];

      for (const proc of items) {
        if (
          proc &&
          typeof proc === "object" &&
          typeof (proc as Record<string, unknown>).Id === "number" &&
          typeof (proc as Record<string, unknown>).Path === "string"
        ) {
          const p = proc as { Id: number; Path: string };
          linuxApps.push({
            pid: p.Id,
            command: p.Path,
          });
        }
      }
    }
  } catch {
    // powershell not available
  }

  return linuxApps;
}

// ── Platform-aware find installed app ──

async function findInstalledAppLinux(
  execFileImpl: ExecFileLike,
): Promise<string | null> {
  // Check known paths
  for (const candidate of LINUX_CODEX_PATHS) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  // Try `which`
  return await whichCodex(execFileImpl);
}

async function findInstalledAppWsl(
  execFileImpl: ExecFileLike,
): Promise<string | null> {
  // First check if codex is installed in WSL itself
  const linuxApp = await findInstalledAppLinux(execFileImpl);
  if (linuxApp) {
    return linuxApp;
  }

  // Then check Windows side
  return await findWslWindowsCodex(execFileImpl);
}

// ── Platform-aware quit ──

async function quitRunningAppsLinux(
  execFileImpl: ExecFileLike,
  options?: { force?: boolean },
): Promise<void> {
  const running = await listRunningAppsLinux(execFileImpl);
  if (running.length === 0) {
    return;
  }

  const pids = running.map((app) => String(app.pid));

  // Always use signal-based termination on Linux (no osascript)
  await execFileImpl("kill", ["-TERM", ...pids]);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const remaining = await listRunningAppsLinux(execFileImpl);
    if (remaining.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (options?.force === true) {
    const remaining = await listRunningAppsLinux(execFileImpl);
    if (remaining.length > 0) {
      await execFileImpl("kill", ["-KILL", ...remaining.map((app) => String(app.pid))]);
    }
  }
}

// ── Main factory ──

export interface PlatformDesktopAdapterOptions {
  execFileImpl?: ExecFileLike;
  statePath?: string;
  readFileImpl?: (path: string) => Promise<string>;
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  createWebSocketImpl?: (url: string) => unknown;
  launchProcessImpl?: (options: { appPath: string; binaryPath: string; args: readonly string[] }) => Promise<void>;
  createDirectClientImpl?: () => Promise<unknown>;
  watchReconnectDelayMs?: number;
  watchHealthCheckIntervalMs?: number;
  watchHealthCheckTimeoutMs?: number;
  /** Override platform detection for testing. */
  platform?: CodexmPlatform;
}

/**
 * Create a platform-aware CodexDesktopLauncher.
 *
 * On macOS, delegates entirely to the original implementation.
 * On Linux/WSL, wraps it with platform-appropriate overrides for
 * findInstalledApp, listRunningApps, quitRunningApps, and pathExists.
 */
export async function createPlatformDesktopLauncher(
  options: PlatformDesktopAdapterOptions = {},
): Promise<CodexDesktopLauncher> {
  const platform = options.platform ?? (await getPlatform());

  if (platform === "darwin") {
    // macOS: use original implementation unchanged
    return createCodexDesktopLauncher(options as Parameters<typeof createCodexDesktopLauncher>[0]);
  }

  // Linux / WSL: create the base launcher, then override platform-specific methods
  const execFileImpl = options.execFileImpl ?? (promisify(execFileCallback) as unknown as ExecFileLike);

  // For Linux/WSL, we override pathExistsViaStat to use Node's fs.access
  // instead of BSD stat. We do this by creating a custom execFileImpl that
  // intercepts "stat" calls.
  const patchedExecFile: ExecFileLike = async (file, args) => {
    if (file === "stat" && args && args.length >= 2 && args[0] === "-f") {
      // BSD stat compatibility: replace with Node fs.access
      const targetPath = args[args.length - 1] as string;
      await access(targetPath);
      return { stdout: targetPath + "\n", stderr: "" };
    }

    if (file === "mdfind") {
      // mdfind is macOS Spotlight — not available on Linux
      throw new Error("mdfind is not available on Linux/WSL");
    }

    if (file === "osascript") {
      // osascript is AppleScript — not available on Linux
      throw new Error("osascript is not available on Linux/WSL");
    }

    return execFileImpl(file, args);
  };

  // Create the base launcher with our patched execFile
  const baseLauncher = createCodexDesktopLauncher({
    ...options,
    execFileImpl: patchedExecFile,
  } as Parameters<typeof createCodexDesktopLauncher>[0]);

  // Override platform-specific methods
  const listRunningApps =
    platform === "wsl" ? () => listRunningAppsWsl(execFileImpl) : () => listRunningAppsLinux(execFileImpl);

  const findInstalledApp =
    platform === "wsl" ? () => findInstalledAppWsl(execFileImpl) : () => findInstalledAppLinux(execFileImpl);

  const quitRunningApps = (quitOptions?: { force?: boolean }) =>
    quitRunningAppsLinux(execFileImpl, quitOptions);

  const isRunningInsideDesktopShell = async (): Promise<boolean> => {
    // On Linux/WSL, check parent process chain for codex with --remote-debugging-port
    let currentPid = process.ppid;
    const visited = new Set<number>();

    while (currentPid > 1 && !visited.has(currentPid)) {
      visited.add(currentPid);
      try {
        const { stdout } = await execFileImpl("ps", ["-o", "ppid=,command=", "-p", String(currentPid)]);
        const line = stdout
          .split("\n")
          .map((entry) => entry.trim())
          .find((entry) => entry !== "");
        if (!line) {
          return false;
        }

        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) {
          return false;
        }

        const command = match[2];
        if (
          command.includes("codex") &&
          command.includes("--remote-debugging-port")
        ) {
          return true;
        }

        currentPid = Number(match[1]);
      } catch {
        return false;
      }
    }

    return false;
  };

  // Return an enhanced launcher that overrides platform-specific methods
  return {
    ...baseLauncher,
    findInstalledApp,
    listRunningApps,
    isRunningInsideDesktopShell,
    quitRunningApps,
  };
}
