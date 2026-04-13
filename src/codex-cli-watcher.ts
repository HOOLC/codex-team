/**
 * codex-cli-watcher.ts
 *
 * Provides quota monitoring and account hot-switching capabilities for the
 * Codex CLI (non-Desktop) mode. This is the counterpart to the Desktop
 * DevTools-based monitoring in codex-desktop-launch.ts.
 *
 * In CLI mode, the user runs `codex` directly in the terminal (common in
 * WSL / Linux environments). This module enables:
 *
 * 1. Quota polling via the codex-direct-client JSON-RPC channel
 * 2. Graceful restart of the codex CLI process after an account switch
 *
 * ## Multi-process support
 *
 * WSL users often run multiple `codex` CLI instances simultaneously — each
 * potentially bound to a different account. This module tracks the mapping
 * between OS processes and accounts so that:
 *
 * - `watch` monitors quota for **all** tracked processes independently.
 * - `switch` / `restart` targets **only** the process(es) using the
 *   affected account, leaving other instances untouched.
 *
 * The mapping is persisted in `~/.codex-team/cli-processes.json` so that
 * a separate `codexm switch` invocation can look up which PIDs to signal.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  createCodexDirectClient,
  type CodexDirectClient,
} from "./codex-direct-client.js";

import type {
  RuntimeQuotaSnapshot,
  RuntimeAccountSnapshot,
  ManagedQuotaSignal,
  ManagedWatchActivitySignal,
  ManagedWatchStatusEvent,
} from "./codex-desktop-launch.js";

// ── Constants ──

const DEFAULT_CLI_PROCESSES_PATH = join(
  homedir(),
  ".codex-team",
  "cli-processes.json",
);

// ── Types ──

export interface CodexCliProcess {
  pid: number;
  command: string;
  args: readonly string[];
}

/**
 * A CLI process with its resolved account identity.
 * Used for targeted operations (restart only the processes that use a
 * specific account, not all of them).
 */
export interface TrackedCliProcess extends CodexCliProcess {
  /** Account identifier (account_id or API key fingerprint). */
  accountId: string | null;
  /** Email associated with the account, if known. */
  email: string | null;
  /** When this mapping was last confirmed. */
  confirmedAt: string;
}

/** On-disk format for cli-processes.json. */
interface CliProcessRegistryData {
  processes: TrackedCliProcess[];
  updatedAt: string;
}

export interface CliWatcherOptions {
  /** Polling interval for quota checks in milliseconds. Default 30_000 (30s). */
  pollIntervalMs?: number;
  /** AbortSignal to stop the watcher. */
  signal?: AbortSignal;
  /** Debug logger. */
  debugLogger?: (line: string) => void;
  /** Callback when a quota signal is detected. */
  onQuotaSignal?: (signal: ManagedQuotaSignal) => Promise<void> | void;
  /** Callback when an activity signal is detected. */
  onActivitySignal?: (signal: ManagedWatchActivitySignal) => Promise<void> | void;
  /** Callback when watcher status changes. */
  onStatus?: (event: ManagedWatchStatusEvent) => Promise<void> | void;
}

export interface CliProcessManager {
  /**
   * Find running codex CLI processes (non-Desktop).
   */
  findRunningCliProcesses(): Promise<CodexCliProcess[]>;

  /**
   * Read the current quota from a running codex CLI via direct client.
   */
  readDirectQuota(): Promise<RuntimeQuotaSnapshot | null>;

  /**
   * Read the current account from a running codex CLI via direct client.
   */
  readDirectAccount(): Promise<RuntimeAccountSnapshot | null>;

  /**
   * Watch quota by polling the direct client at regular intervals.
   * This is the CLI-mode equivalent of watchManagedQuotaSignals().
   */
  watchCliQuotaSignals(options?: CliWatcherOptions): Promise<void>;

  /**
   * Register a codex CLI process with its account identity.
   * Called when a new codex CLI is launched or discovered.
   */
  registerProcess(process: CodexCliProcess, accountId: string | null, email: string | null): Promise<void>;

  /**
   * Remove stale entries from the process registry (PIDs that no longer exist).
   */
  pruneStaleProcesses(): Promise<TrackedCliProcess[]>;

  /**
   * Get all tracked processes, optionally filtered by account.
   * Prunes stale entries before returning.
   */
  getTrackedProcesses(accountId?: string): Promise<TrackedCliProcess[]>;

  /**
   * Gracefully restart codex CLI processes after an account switch.
   *
   * When `accountId` is provided, **only** the processes using that
   * specific account are restarted. Other codex CLI instances are left
   * untouched. When omitted, falls back to restarting all CLI processes
   * (legacy behavior).
   *
   * Sends SIGTERM to trigger process exit. When the codex CLI was started
   * via `codexm run`, the runner wrapper will detect the exit and
   * automatically re-spawn with the updated auth.
   *
   * Note: SIGUSR1 is NOT supported by codex CLI (it has no signal handlers).
   * The kill+restart pattern via `codexm run` is the only reliable approach.
   */
  restartCliProcess(options?: {
    accountId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ restarted: number; skipped: number; failed: number }>;
}

// ── Helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function epochSecondsToIsoString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

function normalizeManagedQuotaWindow(
  value: unknown,
  fallbackWindowSeconds: number,
): RuntimeQuotaSnapshot["five_hour"] {
  if (!isRecord(value) || typeof value.usedPercent !== "number") {
    return null;
  }

  const windowDurationMins =
    typeof value.windowDurationMins === "number" && Number.isFinite(value.windowDurationMins)
      ? value.windowDurationMins
      : null;

  return {
    used_percent: value.usedPercent,
    window_seconds: windowDurationMins === null ? fallbackWindowSeconds : windowDurationMins * 60,
    reset_at: epochSecondsToIsoString(value.resetsAt),
  };
}

function normalizeDirectQuotaSnapshot(value: unknown): RuntimeQuotaSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const rateLimits = isRecord(value.rateLimits) ? value.rateLimits : null;
  if (!rateLimits) {
    return null;
  }

  const credits = isRecord(rateLimits.credits) ? rateLimits.credits : null;
  const balanceValue = credits?.balance;
  const creditsBalance =
    typeof balanceValue === "string" && balanceValue.trim() !== ""
      ? Number(balanceValue)
      : typeof balanceValue === "number"
        ? balanceValue
        : null;

  return {
    plan_type: typeof rateLimits.planType === "string" ? rateLimits.planType : null,
    credits_balance: Number.isFinite(creditsBalance) ? creditsBalance : null,
    unlimited: credits?.unlimited === true,
    five_hour: normalizeManagedQuotaWindow(rateLimits.primary ?? rateLimits.primaryWindow, 18_000),
    one_week: normalizeManagedQuotaWindow(
      rateLimits.secondary ?? rateLimits.secondaryWindow,
      604_800,
    ),
    fetched_at: new Date().toISOString(),
  };
}

function normalizeDirectAccountSnapshot(value: unknown): RuntimeAccountSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const account = isRecord(value.account) ? value.account : null;
  const accountType = account?.type;
  const authMode =
    accountType === "apiKey"
      ? "apikey"
      : accountType === "chatgpt"
        ? "chatgpt"
        : null;

  return {
    auth_mode: authMode,
    email: typeof account?.email === "string" ? account.email : null,
    plan_type: typeof account?.planType === "string" ? account.planType : null,
    requires_openai_auth:
      typeof value.requiresOpenaiAuth === "boolean" ? value.requiresOpenaiAuth : null,
  };
}

function hasExhaustedRateLimit(value: unknown, depth = 0): boolean {
  if (depth > 8) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasExhaustedRateLimit(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return false;
  }

  const usedPercent = value.usedPercent ?? value.used_percent;
  if (typeof usedPercent === "number" && usedPercent >= 100) {
    return true;
  }

  return Object.values(value).some((entry) => hasExhaustedRateLimit(entry, depth + 1));
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Process Registry (on-disk) ──

async function readProcessRegistry(
  registryPath: string,
): Promise<TrackedCliProcess[]> {
  try {
    const raw = await readFile(registryPath, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || !Array.isArray(data.processes)) {
      return [];
    }
    return data.processes.filter(
      (entry: unknown): entry is TrackedCliProcess =>
        isRecord(entry) &&
        typeof entry.pid === "number" &&
        typeof entry.command === "string",
    );
  } catch {
    return [];
  }
}

async function writeProcessRegistry(
  registryPath: string,
  processes: TrackedCliProcess[],
): Promise<void> {
  const data: CliProcessRegistryData = {
    processes,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  await writeFile(registryPath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Factory ──

export interface ExecFileLike {
  (
    file: string,
    args?: readonly string[],
  ): Promise<{ stdout: string; stderr: string }>;
}

export function createCliProcessManager(options: {
  execFileImpl?: ExecFileLike;
  createDirectClientImpl?: () => Promise<CodexDirectClient>;
  pollIntervalMs?: number;
  registryPath?: string;
  isProcessAliveImpl?: (pid: number) => boolean;
} = {}): CliProcessManager {
  const execFileImpl = options.execFileImpl;
  const createDirectClientImpl =
    options.createDirectClientImpl ?? (() => createCodexDirectClient());
  const defaultPollIntervalMs = options.pollIntervalMs ?? 30_000;
  const registryPath = options.registryPath ?? DEFAULT_CLI_PROCESSES_PATH;
  const processAlive = options.isProcessAliveImpl ?? isProcessAlive;

  // ── Process discovery ──

  async function findRunningCliProcesses(): Promise<CodexCliProcess[]> {
    if (!execFileImpl) {
      return [];
    }

    try {
      const { stdout } = await execFileImpl("ps", ["-Ao", "pid=,command="]);
      const processes: CodexCliProcess[] = [];

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

        // Match codex CLI processes (not Desktop / not remote-debugging-port)
        const parts = command.trim().split(/\s+/);
        const binary = parts[0]?.split("/").pop() ?? "";

        if (
          binary === "codex" &&
          !command.includes("--remote-debugging-port")
        ) {
          processes.push({
            pid,
            command,
            args: parts.slice(1),
          });
        }
      }

      return processes;
    } catch {
      return [];
    }
  }

  // ── Process registry ──

  async function registerProcess(
    proc: CodexCliProcess,
    accountId: string | null,
    email: string | null,
  ): Promise<void> {
    const existing = await readProcessRegistry(registryPath);

    // Remove any previous entry for the same PID
    const filtered = existing.filter((entry) => entry.pid !== proc.pid);

    const tracked: TrackedCliProcess = {
      ...proc,
      accountId,
      email,
      confirmedAt: new Date().toISOString(),
    };

    filtered.push(tracked);
    await writeProcessRegistry(registryPath, filtered);
  }

  async function pruneStaleProcesses(): Promise<TrackedCliProcess[]> {
    const existing = await readProcessRegistry(registryPath);
    const alive = existing.filter((entry) => processAlive(entry.pid));

    if (alive.length !== existing.length) {
      await writeProcessRegistry(registryPath, alive);
    }

    return alive;
  }

  async function getTrackedProcesses(accountId?: string): Promise<TrackedCliProcess[]> {
    const alive = await pruneStaleProcesses();

    if (accountId === undefined) {
      return alive;
    }

    return alive.filter((entry) => entry.accountId === accountId);
  }

  // ── Direct client operations ──

  async function readDirectQuota(): Promise<RuntimeQuotaSnapshot | null> {
    let client: CodexDirectClient | null = null;
    try {
      client = await createDirectClientImpl();
      const result = await client.request("account/rateLimits/read", {});
      return normalizeDirectQuotaSnapshot(result);
    } catch {
      return null;
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }

  async function readDirectAccount(): Promise<RuntimeAccountSnapshot | null> {
    let client: CodexDirectClient | null = null;
    try {
      client = await createDirectClientImpl();
      const result = await client.request("account/read", { refreshToken: false });
      return normalizeDirectAccountSnapshot(result);
    } catch {
      return null;
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }

  // ── Quota watch ──

  async function watchCliQuotaSignals(watchOptions?: CliWatcherOptions): Promise<void> {
    const pollInterval = watchOptions?.pollIntervalMs ?? defaultPollIntervalMs;
    const signal = watchOptions?.signal;
    const debugLogger = watchOptions?.debugLogger;
    const onQuotaSignal = watchOptions?.onQuotaSignal;
    const onActivitySignal = watchOptions?.onActivitySignal;
    const onStatus = watchOptions?.onStatus;

    let attempt = 0;
    let lastQuotaJson = "";

    while (!signal?.aborted) {
      try {
        let client: CodexDirectClient | null = null;
        try {
          client = await createDirectClientImpl();

          await onStatus?.({
            type: "reconnected",
            attempt,
            error: null,
          });

          // Main polling loop with this client
          while (!signal?.aborted) {
            const rawResult = await client.request("account/rateLimits/read", {});
            const quota = normalizeDirectQuotaSnapshot(rawResult);
            const currentJson = JSON.stringify(quota);

            if (currentJson !== lastQuotaJson) {
              lastQuotaJson = currentJson;

              const shouldAutoSwitch = hasExhaustedRateLimit(rawResult);

              if (onQuotaSignal) {
                await onQuotaSignal({
                  requestId: `cli-poll:${Date.now()}`,
                  url: "mcp:account/rateLimits/read",
                  status: null,
                  reason: "rpc_response",
                  bodySnippet: currentJson?.slice(0, 2_000) ?? null,
                  shouldAutoSwitch,
                  quota,
                });
              }

              // Also emit activity signal on quota change
              if (onActivitySignal) {
                await onActivitySignal({
                  requestId: `cli-poll:${Date.now()}`,
                  method: "account/rateLimits/updated",
                  reason: "quota_dirty",
                  bodySnippet: currentJson?.slice(0, 2_000) ?? null,
                });
              }
            }

            debugLogger?.(`CLI poll: quota=${currentJson?.slice(0, 200)}`);

            // Wait for next poll interval
            await delay(pollInterval, signal);
          }
        } finally {
          if (client) {
            await client.close().catch(() => {});
          }
        }
      } catch (error) {
        attempt += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);

        debugLogger?.(`CLI watch error (attempt ${attempt}): ${errorMessage}`);

        await onStatus?.({
          type: "disconnected",
          attempt,
          error: errorMessage,
        });

        if (signal?.aborted) {
          break;
        }

        // Exponential backoff, max 60s
        const backoffMs = Math.min(1_000 * Math.pow(2, attempt - 1), 60_000);
        await delay(backoffMs, signal);
      }
    }
  }

  // ── Targeted restart ──

  async function restartCliProcess(restartOptions?: {
    accountId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ restarted: number; skipped: number; failed: number }> {
    const accountId = restartOptions?.accountId;
    const timeoutMs = restartOptions?.timeoutMs ?? 5_000;

    let targets: Array<{ pid: number; command: string }>;

    if (accountId) {
      // Targeted restart: only processes using the specified account
      const tracked = await getTrackedProcesses(accountId);
      targets = tracked;
    } else {
      // Legacy fallback: restart all discovered CLI processes
      targets = await findRunningCliProcesses();
    }

    if (targets.length === 0) {
      return { restarted: 0, skipped: 0, failed: 0 };
    }

    let restarted = 0;
    let skipped = 0;
    let failed = 0;

    for (const proc of targets) {
      // Skip if already dead
      if (!processAlive(proc.pid)) {
        skipped += 1;
        continue;
      }

      try {
        // Send SIGTERM — codex CLI has no SIGUSR1 handler.
        // If started via `codexm run`, the runner wrapper will detect
        // the exit and re-spawn with updated auth automatically.
        process.kill(proc.pid, "SIGTERM");

        // Wait for the process to exit
        await delay(Math.min(timeoutMs, 3_000), restartOptions?.signal);

        if (processAlive(proc.pid)) {
          // Still running after SIGTERM — try SIGKILL
          try {
            process.kill(proc.pid, "SIGKILL");
          } catch {
            // Already gone
          }
        }

        restarted += 1;
      } catch {
        // Process already gone or permission denied
        failed += 1;
      }
    }

    // Clean up the registry
    await pruneStaleProcesses();

    return { restarted, skipped, failed };
  }

  return {
    findRunningCliProcesses,
    readDirectQuota,
    readDirectAccount,
    watchCliQuotaSignals,
    registerProcess,
    pruneStaleProcesses,
    getTrackedProcesses,
    restartCliProcess,
  };
}
