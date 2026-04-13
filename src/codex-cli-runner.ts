/**
 * codex-cli-runner.ts
 *
 * Provides a managed wrapper for running `codex` CLI processes that
 * automatically restarts the process when the auth file changes.
 *
 * ## Problem
 *
 * The codex CLI (Rust binary) reads `~/.codex/auth.json` once at startup
 * and caches it in memory. There is no file watcher, no signal handler,
 * and no IPC mechanism to trigger a reload. When `codexm` switches
 * accounts (overwriting `auth.json`), the running codex process continues
 * using the old credentials until manually restarted.
 *
 * ## Solution
 *
 * `codexm run` wraps the codex process:
 *
 * 1. Spawns `codex` as a child process with inherited stdio (full PTY
 *    passthrough so interactive features work).
 * 2. Watches `~/.codex/auth.json` for changes via `fs.watch()`.
 * 3. When a change is detected (i.e., `codexm switch` or auto-switch
 *    overwrote the file), it:
 *    a. Prints a notice to stderr
 *    b. Sends SIGTERM to the old codex process
 *    c. Waits for it to exit (with a timeout)
 *    d. Spawns a new codex process with the same arguments
 * 4. Registers each spawned process in the CLI process registry so
 *    `codexm watch` can track it.
 *
 * The user runs `codexm run` instead of `codex` and gets automatic
 * account switching without manual Ctrl+C.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

import {
  createCliProcessManager,
  type CliProcessManager,
} from "./watch/cli-watcher.js";

// ── Types ──

export interface RunnerOptions {
  /** Arguments to pass to `codex`. */
  codexArgs: string[];
  /** Path to the codex binary. Default: "codex" (resolved from PATH). */
  codexBinary?: string;
  /** Path to the auth file to watch. Default: ~/.codex/auth.json. */
  authFilePath?: string;
  /** Account ID for process registry. */
  accountId?: string | null;
  /** Email for process registry. */
  email?: string | null;
  /** Debounce interval for auth file changes in ms. Default: 500. */
  debounceMs?: number;
  /** Timeout for waiting for the old process to exit in ms. Default: 5000. */
  killTimeoutMs?: number;
  /** AbortSignal to stop the runner. */
  signal?: AbortSignal;
  /** Debug logger. */
  debugLog?: (message: string) => void;
  /** Streams for output. */
  stderr?: NodeJS.WriteStream;
  /** Disable auth file watching (useful for testing). */
  disableAuthWatch?: boolean;
  /** CLI process manager instance (for DI/testing). */
  cliManager?: CliProcessManager;
  /** Spawn implementation override for tests. */
  spawnImpl?: typeof spawn;
  /** File watch implementation override for tests. */
  watchImpl?: typeof watch;
  /** File read implementation override for tests. */
  readFileImpl?: typeof readFile;
  /** Attach process-level SIGINT/SIGTERM handlers. Default: true. */
  attachProcessSignalHandlers?: boolean;
}

export interface RunnerResult {
  /** Final exit code. */
  exitCode: number;
  /** Number of times the codex process was restarted due to auth changes. */
  restartCount: number;
}

// ── Helpers ──

function hashFileContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readAuthHash(
  authFilePath: string,
  readFileImpl: typeof readFile,
): Promise<string | null> {
  try {
    const content = await readFileImpl(authFilePath, "utf-8");
    return hashFileContent(content);
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ── Main runner ──

export async function runCodexWithAutoRestart(
  options: RunnerOptions,
): Promise<RunnerResult> {
  const codexBinary = options.codexBinary ?? "codex";
  const codexArgs = options.codexArgs;
  const authFilePath =
    options.authFilePath ?? join(homedir(), ".codex", "auth.json");
  const debounceMs = options.debounceMs ?? 500;
  const killTimeoutMs = options.killTimeoutMs ?? 5_000;
  const signal = options.signal;
  const debugLog = options.debugLog ?? (() => {});
  const stderr = options.stderr ?? process.stderr;
  const cliManager =
    options.cliManager ?? createCliProcessManager({});
  const spawnImpl = options.spawnImpl ?? spawn;
  const watchImpl = options.watchImpl ?? watch;
  const readFileImpl = options.readFileImpl ?? readFile;
  const attachProcessSignalHandlers = options.attachProcessSignalHandlers ?? true;

  let currentProcess: ChildProcess | null = null;
  let currentAuthHash = await readAuthHash(authFilePath, readFileImpl);
  let restartCount = 0;
  let lastExitCode = 0;
  let isRestarting = false;
  let authWatcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  // ── Spawn codex ──

  function spawnCodex(): ChildProcess {
    debugLog(`run: spawning ${codexBinary} ${codexArgs.join(" ")}`);

    const child = spawnImpl(codexBinary, codexArgs, {
      stdio: "inherit",
      env: process.env,
    });

    debugLog(`run: codex started with pid=${child.pid}`);

    // Register in process registry
    if (child.pid) {
      void cliManager
        .registerProcess(
          {
            pid: child.pid,
            command: codexBinary,
            args: codexArgs,
          },
          options.accountId ?? null,
          options.email ?? null,
        )
        .catch(() => {});
    }

    return child;
  }

  // ── Kill and restart ──

  async function killAndRestart(reason: string): Promise<void> {
    if (isRestarting || stopped) {
      return;
    }

    isRestarting = true;

    try {
      stderr.write(
        `\n[${formatTimestamp()}] ⟳ ${reason}. Restarting codex...\n`,
      );

      // Kill the old process
      if (currentProcess && currentProcess.exitCode === null) {
        debugLog(`run: sending SIGTERM to pid=${currentProcess.pid}`);
        currentProcess.kill("SIGTERM");

        // Wait for exit with timeout
        await Promise.race([
          new Promise<void>((resolve) => {
            currentProcess!.once("exit", () => resolve());
          }),
          delay(killTimeoutMs).then(() => {
            if (
              currentProcess &&
              currentProcess.exitCode === null
            ) {
              debugLog(
                `run: SIGTERM timeout, sending SIGKILL to pid=${currentProcess.pid}`,
              );
              currentProcess.kill("SIGKILL");
            }
          }),
        ]);
      }

      // Update auth hash
      currentAuthHash = await readAuthHash(authFilePath, readFileImpl);

      // Spawn new process
      currentProcess = spawnCodex();
      restartCount++;

      // Attach exit handler
      currentProcess.once("exit", (code) => {
        lastExitCode = code ?? 1;
        if (!isRestarting && !stopped) {
          // Natural exit — stop the runner
          debugLog(
            `run: codex exited naturally with code=${lastExitCode}`,
          );
          stopped = true;
          cleanup();
        }
      });

      stderr.write(
        `[${formatTimestamp()}] ✓ codex restarted (pid=${currentProcess.pid})\n\n`,
      );
    } finally {
      isRestarting = false;
    }
  }

  // ── Auth file watcher ──

  function startAuthWatcher(): void {
    if (options.disableAuthWatch) {
      return;
    }

    try {
      authWatcher = watchImpl(authFilePath, { persistent: false }, () => {
        // Debounce: auth file may be written in multiple steps
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void checkAuthChange();
        }, debounceMs);
      });

      authWatcher.on("error", (err) => {
        debugLog(`run: auth watcher error: ${err.message}`);
        // Watcher may break after file replacement (atomic write)
        // Restart it after a delay
        setTimeout(() => {
          if (!stopped) {
            stopAuthWatcher();
            startAuthWatcher();
          }
        }, 1_000);
      });

      debugLog(`run: watching ${authFilePath} for changes`);
    } catch (err) {
      debugLog(
        `run: failed to start auth watcher: ${(err as Error).message}`,
      );
      // Fall back to polling
      startAuthPolling();
    }
  }

  // Polling fallback (for systems where fs.watch is unreliable)
  let pollTimer: NodeJS.Timeout | null = null;

  function startAuthPolling(): void {
    debugLog("run: falling back to polling for auth changes");

    const pollInterval = 3_000; // 3 seconds
    pollTimer = setInterval(() => {
      void checkAuthChange();
    }, pollInterval);
  }

  async function checkAuthChange(): Promise<void> {
    if (stopped || isRestarting) {
      return;
    }

    const newHash = await readAuthHash(authFilePath, readFileImpl);
    if (newHash && newHash !== currentAuthHash) {
      debugLog(
        `run: auth file changed (old=${currentAuthHash?.slice(0, 8)}, new=${newHash.slice(0, 8)})`,
      );
      await killAndRestart("Account switched");
    }
  }

  function stopAuthWatcher(): void {
    if (authWatcher) {
      authWatcher.close();
      authWatcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // ── Cleanup ──

  function cleanup(): void {
    stopAuthWatcher();
    if (
      currentProcess &&
      currentProcess.exitCode === null
    ) {
      currentProcess.kill("SIGTERM");
    }
  }

  // ── Signal handling ──

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        stopped = true;
        cleanup();
      },
      { once: true },
    );
  }

  // Forward SIGINT/SIGTERM to child
  const forwardSignal = (sig: NodeJS.Signals) => {
    if (currentProcess && currentProcess.exitCode === null) {
      currentProcess.kill(sig);
    }
  };

  if (attachProcessSignalHandlers) {
    process.on("SIGINT", () => forwardSignal("SIGINT"));
    process.on("SIGTERM", () => {
      forwardSignal("SIGTERM");
      stopped = true;
      cleanup();
    });
  }

  // ── Start ──

  currentProcess = spawnCodex();
  startAuthWatcher();

  // Wait for the process to complete
  return new Promise<RunnerResult>((resolve) => {
    const onExit = (code: number | null) => {
      lastExitCode = code ?? 1;
      if (!isRestarting && !stopped) {
        // Natural exit — stop everything
        stopped = true;
        cleanup();
        resolve({
          exitCode: lastExitCode,
          restartCount,
        });
      }
    };

    currentProcess!.once("exit", onExit);

    // Also resolve when stopped externally
    const checkStopped = setInterval(() => {
      if (stopped && !isRestarting) {
        clearInterval(checkStopped);
        // Give a moment for any pending restart
        setTimeout(() => {
          resolve({
            exitCode: lastExitCode,
            restartCount,
          });
        }, 100);
      }
    }, 200);

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(checkStopped);
          resolve({
            exitCode: lastExitCode,
            restartCount,
          });
        },
        { once: true },
      );
    }
  });
}
