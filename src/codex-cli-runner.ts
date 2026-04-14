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
import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  /** Path to the codex sessions directory. Default: ~/.codex/sessions. */
  sessionsDirPath?: string;
  /** Working directory used to match Codex sessions. Default: process.cwd(). */
  cwd?: string;
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
  /** Directory read implementation override for tests. */
  readDirImpl?: typeof readdir;
  /** File stat implementation override for tests. */
  statImpl?: typeof stat;
  /** Attach process-level SIGINT/SIGTERM handlers. Default: true. */
  attachProcessSignalHandlers?: boolean;
  /** Session discovery timeout in ms. Default: 2000. */
  sessionDiscoveryTimeoutMs?: number;
  /** Session discovery poll interval in ms. Default: 100. */
  sessionDiscoveryPollIntervalMs?: number;
  /** Auth polling interval in ms. Default: 3000. */
  authPollIntervalMs?: number;
}

export interface RunnerResult {
  /** Final exit code. */
  exitCode: number;
  /** Number of times the codex process was restarted due to auth changes. */
  restartCount: number;
}

interface CodexResumePlan {
  resumable: boolean;
  resumeBaseArgs: string[];
  fallbackArgs: string[] | null;
  explicitSessionId: string | null;
}

interface SessionMetaRecord {
  id: string;
  cwd: string;
  mtimeMs: number;
}

const CODEX_SUBCOMMANDS = new Set([
  "exec",
  "review",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "app-server",
  "completion",
  "sandbox",
  "debug",
  "apply",
  "resume",
  "fork",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

const GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
]);

const GLOBAL_FLAG_OPTIONS = new Set([
  "--oss",
  "--full-auto",
  "--dangerously-bypass-approvals-and-sandbox",
  "--search",
  "--no-alt-screen",
]);

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

function hasEqualsValue(token: string, options: Set<string>): boolean {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex <= 0) {
    return false;
  }

  return options.has(token.slice(0, equalsIndex));
}

function parseResumeSubcommandSessionId(args: string[], startIndex: number): string | null {
  for (let index = startIndex; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--last" || token === "--all" || token === "--include-non-interactive") {
      continue;
    }
    if (GLOBAL_FLAG_OPTIONS.has(token) || hasEqualsValue(token, GLOBAL_OPTIONS_WITH_VALUES)) {
      continue;
    }
    if (GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token;
  }

  return null;
}

function buildCodexResumePlan(args: string[]): CodexResumePlan {
  const resumeBaseArgs: string[] = [];
  let index = 0;

  while (index < args.length) {
    const token = args[index]!;

    if (token === "--") {
      break;
    }

    if (hasEqualsValue(token, GLOBAL_OPTIONS_WITH_VALUES) || hasEqualsValue(token, GLOBAL_FLAG_OPTIONS)) {
      resumeBaseArgs.push(token);
      index += 1;
      continue;
    }

    if (GLOBAL_FLAG_OPTIONS.has(token)) {
      resumeBaseArgs.push(token);
      index += 1;
      continue;
    }

    if (GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
      resumeBaseArgs.push(token);
      if (index + 1 < args.length) {
        resumeBaseArgs.push(args[index + 1]!);
      }
      index += 2;
      continue;
    }

    break;
  }

  const firstPositional = args[index] ?? null;
  if (!firstPositional) {
    return {
      resumable: true,
      resumeBaseArgs,
      fallbackArgs: [...resumeBaseArgs, "resume", "--last"],
      explicitSessionId: null,
    };
  }

  if (!CODEX_SUBCOMMANDS.has(firstPositional)) {
    return {
      resumable: true,
      resumeBaseArgs,
      fallbackArgs: [...resumeBaseArgs, "resume", "--last"],
      explicitSessionId: null,
    };
  }

  if (firstPositional === "resume") {
    return {
      resumable: true,
      resumeBaseArgs,
      fallbackArgs: [...resumeBaseArgs, "resume", "--last"],
      explicitSessionId: parseResumeSubcommandSessionId(args, index + 1),
    };
  }

  if (firstPositional === "fork") {
    return {
      resumable: true,
      resumeBaseArgs,
      fallbackArgs: [...resumeBaseArgs, "resume", "--last"],
      explicitSessionId: null,
    };
  }

  return {
    resumable: false,
    resumeBaseArgs,
    fallbackArgs: null,
    explicitSessionId: null,
  };
}

function formatCommandForDisplay(binary: string, args: string[]): string {
  return [binary, ...args].join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function collectSessionFiles(
  directoryPath: string,
  readDirImpl: typeof readdir,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readDirImpl(directoryPath, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSessionFiles(entryPath, readDirImpl));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function readSessionMetaRecord(
  path: string,
  readFileImpl: typeof readFile,
  statImpl: typeof stat,
): Promise<SessionMetaRecord | null> {
  try {
    const [raw, fileStat] = await Promise.all([
      readFileImpl(path, "utf8"),
      statImpl(path),
    ]);
    const firstLine = raw.split("\n")[0]?.trim() ?? "";
    if (firstLine === "") {
      return null;
    }

    const parsed = JSON.parse(firstLine) as unknown;
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      return null;
    }

    const id = parsed.payload.id;
    const cwd = parsed.payload.cwd;
    if (typeof id !== "string" || id === "" || typeof cwd !== "string" || cwd === "") {
      return null;
    }

    return {
      id,
      cwd,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch {
    return null;
  }
}

async function findNewestSessionForCwd(options: {
  sessionsDirPath: string;
  cwd: string;
  readDirImpl: typeof readdir;
  readFileImpl: typeof readFile;
  statImpl: typeof stat;
  minMtimeMs?: number;
}): Promise<SessionMetaRecord | null> {
  const files = await collectSessionFiles(options.sessionsDirPath, options.readDirImpl);
  if (files.length === 0) {
    return null;
  }

  const records = await Promise.all(
    files.map((path) => readSessionMetaRecord(path, options.readFileImpl, options.statImpl)),
  );

  const matching = records
    .filter((record): record is SessionMetaRecord => record !== null && record.cwd === options.cwd)
    .filter((record) => options.minMtimeMs === undefined || record.mtimeMs >= options.minMtimeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return matching[0] ?? null;
}

// ── Main runner ──

export async function runCodexWithAutoRestart(
  options: RunnerOptions,
): Promise<RunnerResult> {
  const codexBinary = options.codexBinary ?? "codex";
  const codexArgs = options.codexArgs;
  const authFilePath =
    options.authFilePath ?? join(homedir(), ".codex", "auth.json");
  const sessionsDirPath =
    options.sessionsDirPath ?? join(homedir(), ".codex", "sessions");
  const cwd = options.cwd ?? process.cwd();
  const debounceMs = options.debounceMs ?? 500;
  const killTimeoutMs = options.killTimeoutMs ?? 5_000;
  const sessionDiscoveryTimeoutMs = options.sessionDiscoveryTimeoutMs ?? 2_000;
  const sessionDiscoveryPollIntervalMs = options.sessionDiscoveryPollIntervalMs ?? 100;
  const authPollIntervalMs = options.authPollIntervalMs ?? 3_000;
  const signal = options.signal;
  const debugLog = options.debugLog ?? (() => {});
  const stderr = options.stderr ?? process.stderr;
  const cliManager =
    options.cliManager ?? createCliProcessManager({});
  const spawnImpl = options.spawnImpl ?? spawn;
  const watchImpl = options.watchImpl ?? watch;
  const readFileImpl = options.readFileImpl ?? readFile;
  const readDirImpl = options.readDirImpl ?? readdir;
  const statImpl = options.statImpl ?? stat;
  const attachProcessSignalHandlers = options.attachProcessSignalHandlers ?? true;
  const authWatchDir = dirname(authFilePath);
  const authWatchFileName = basename(authFilePath);
  const resumePlan = buildCodexResumePlan(codexArgs);

  let currentProcess: ChildProcess | null = null;
  let currentAuthHash = await readAuthHash(authFilePath, readFileImpl);
  let restartCount = 0;
  let lastExitCode = 0;
  let isRestarting = false;
  let authWatcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let resolved = false;
  let currentSessionId = resumePlan.explicitSessionId;
  let sessionDiscoveryGeneration = 0;
  let currentSpawnStartedAt = Date.now();
  let lastResumeCommandForDisplay: string | null = null;

  const expectedExitChildren = new WeakSet<ChildProcess>();
  const childExitPromises = new WeakMap<ChildProcess, Promise<void>>();

  let resolveResult: ((result: RunnerResult) => void) | null = null;

  function finish(exitCode: number): void {
    lastExitCode = exitCode;
    if (resolved || !resolveResult) {
      return;
    }
    resolved = true;
    resolveResult({
      exitCode: lastExitCode,
      restartCount,
    });
  }

  function stopWatcherOnly(): void {
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

  function updateResumeCommandForDisplay(): void {
    if (!resumePlan.resumable) {
      lastResumeCommandForDisplay = null;
      return;
    }

    lastResumeCommandForDisplay = formatCommandForDisplay(
      codexBinary,
      currentSessionId
        ? [...resumePlan.resumeBaseArgs, "resume", currentSessionId]
        : (resumePlan.fallbackArgs ?? []),
    );
  }

  async function refreshCurrentSessionId(preferCurrentSpawnOnly: boolean): Promise<void> {
    if (!resumePlan.resumable || currentSessionId) {
      return;
    }

    const record = await findNewestSessionForCwd({
      sessionsDirPath,
      cwd,
      readDirImpl,
      readFileImpl,
      statImpl,
      minMtimeMs: preferCurrentSpawnOnly ? currentSpawnStartedAt - 1_000 : undefined,
    });
    if (record?.id) {
      currentSessionId = record.id;
      updateResumeCommandForDisplay();
      debugLog(`run: matched codex session id=${record.id}`);
    }
  }

  async function waitForCurrentSessionId(): Promise<void> {
    if (!resumePlan.resumable || currentSessionId) {
      return;
    }

    const generation = ++sessionDiscoveryGeneration;
    const deadline = Date.now() + sessionDiscoveryTimeoutMs;

    while (!stopped && generation === sessionDiscoveryGeneration && !currentSessionId) {
      await refreshCurrentSessionId(true);
      if (currentSessionId || Date.now() >= deadline) {
        return;
      }
      await delay(sessionDiscoveryPollIntervalMs);
    }
  }

  function scheduleSessionDiscovery(): void {
    if (!resumePlan.resumable || currentSessionId) {
      return;
    }

    void waitForCurrentSessionId().catch((error) => {
      debugLog(`run: failed to discover codex session id: ${(error as Error).message}`);
    });
  }

  async function buildResumeArgsForRestart(): Promise<string[] | null> {
    if (!resumePlan.resumable) {
      return null;
    }

    await refreshCurrentSessionId(false);
    if (currentSessionId) {
      return [...resumePlan.resumeBaseArgs, "resume", currentSessionId];
    }

    return resumePlan.fallbackArgs ? [...resumePlan.fallbackArgs] : null;
  }

  function handleChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    lastExitCode = code ?? 1;

    const expectedExit = expectedExitChildren.has(child);
    const wasCurrent = currentProcess === child;

    debugLog(
      `run: pid=${child.pid} exited code=${code ?? "null"} signal=${signal ?? "null"} expected=${expectedExit} current=${wasCurrent}`,
    );

    if (wasCurrent) {
      currentProcess = null;
    }

    if (expectedExit) {
      expectedExitChildren.delete(child);
      return;
    }

    if (stopped || !wasCurrent) {
      return;
    }

    debugLog(`run: codex exited naturally with code=${lastExitCode}`);
    if (lastResumeCommandForDisplay) {
      stderr.write(
        `[codexm run] Resume with: ${lastResumeCommandForDisplay}\n`,
      );
    }
    stopped = true;
    stopWatcherOnly();
    finish(lastExitCode);
  }

  function trackChild(child: ChildProcess): ChildProcess {
    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve();
        handleChildExit(child, code, signal ?? null);
      });
    });

    childExitPromises.set(child, exitPromise);
    return child;
  }

  async function waitForChildExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null) {
      return true;
    }

    const exitPromise =
      childExitPromises.get(child) ??
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });

    return await Promise.race([
      exitPromise.then(() => true),
      delay(timeoutMs).then(() => false),
    ]);
  }

  // ── Spawn codex ──

  function spawnCodex(args = codexArgs): ChildProcess {
    currentSpawnStartedAt = Date.now();
    if (!args.includes("resume") || args[args.indexOf("resume") + 1] !== currentSessionId) {
      sessionDiscoveryGeneration += 1;
    }
    if (args === codexArgs && !resumePlan.explicitSessionId) {
      currentSessionId = null;
    }
    updateResumeCommandForDisplay();

    debugLog(`run: spawning ${codexBinary} ${args.join(" ")}`);

    const child = trackChild(
      spawnImpl(codexBinary, args, {
        stdio: "inherit",
        env: process.env,
      }),
    );

    debugLog(`run: codex started with pid=${child.pid}`);

    // Register in process registry
    if (child.pid) {
      void cliManager
        .registerProcess(
          {
            pid: child.pid,
            command: codexBinary,
            args,
          },
          options.accountId ?? null,
          options.email ?? null,
        )
        .catch(() => {});
    }

    scheduleSessionDiscovery();
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
      const oldProcess = currentProcess;
      if (oldProcess && oldProcess.exitCode === null) {
        expectedExitChildren.add(oldProcess);
        debugLog(`run: sending SIGTERM to pid=${oldProcess.pid}`);
        oldProcess.kill("SIGTERM");

        const exitedAfterSigterm = await waitForChildExit(oldProcess, killTimeoutMs);
        if (!exitedAfterSigterm && oldProcess.exitCode === null) {
          debugLog(
            `run: SIGTERM timeout, sending SIGKILL to pid=${oldProcess.pid}`,
          );
          oldProcess.kill("SIGKILL");

          const exitedAfterSigkill = await waitForChildExit(
            oldProcess,
            Math.min(killTimeoutMs, 1_000),
          );
          if (!exitedAfterSigkill && oldProcess.exitCode === null) {
            debugLog(`run: pid=${oldProcess.pid} still running after SIGKILL`);
          }
        }

        if (currentProcess === oldProcess) {
          currentProcess = null;
        }
      }

      if (stopped) {
        return;
      }

      // Update auth hash
      currentAuthHash = await readAuthHash(authFilePath, readFileImpl);

      // Spawn new process
      const nextArgs = await buildResumeArgsForRestart();
      currentProcess = spawnCodex(nextArgs ?? codexArgs);
      restartCount++;

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
      authWatcher = watchImpl(authWatchDir, { persistent: false }, (_eventType, filename) => {
        const normalizedName =
          typeof filename === "string" || Buffer.isBuffer(filename)
            ? String(filename)
            : null;
        if (normalizedName && normalizedName !== authWatchFileName) {
          return;
        }

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

      debugLog(`run: watching ${authWatchDir} for ${authWatchFileName} changes`);
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

    pollTimer = setInterval(() => {
      void checkAuthChange();
    }, authPollIntervalMs);
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
    stopWatcherOnly();
  }

  // ── Cleanup ──

  function cleanup(): void {
    stopAuthWatcher();
    if (
      currentProcess &&
      currentProcess.exitCode === null
    ) {
      expectedExitChildren.add(currentProcess);
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
    resolveResult = resolve;

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          finish(lastExitCode);
        },
        { once: true },
      );
    }
  });
}
