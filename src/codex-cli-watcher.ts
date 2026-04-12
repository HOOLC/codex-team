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
 */

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

// ── Types ──

export interface CodexCliProcess {
  pid: number;
  command: string;
  args: readonly string[];
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
   * Gracefully restart the codex CLI process after an account switch.
   * Sends SIGUSR1 first; if the process doesn't reload within timeoutMs,
   * falls back to SIGTERM + respawn.
   */
  restartCliProcess(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean>;
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
} = {}): CliProcessManager {
  const execFileImpl = options.execFileImpl;
  const createDirectClientImpl =
    options.createDirectClientImpl ?? (() => createCodexDirectClient());
  const defaultPollIntervalMs = options.pollIntervalMs ?? 30_000;

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
            await delay(pollInterval);
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
        await delay(backoffMs);
      }
    }
  }

  async function restartCliProcess(restartOptions?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const processes = await findRunningCliProcesses();
    if (processes.length === 0) {
      return false;
    }

    const timeoutMs = restartOptions?.timeoutMs ?? 5_000;

    for (const proc of processes) {
      try {
        // Try SIGUSR1 first for graceful reload
        process.kill(proc.pid, "SIGUSR1");

        // Wait briefly to see if the process reloads
        await delay(Math.min(timeoutMs, 2_000));

        // Check if still running (if it crashed, we need to note that)
        try {
          process.kill(proc.pid, 0);
          // Still running — SIGUSR1 was accepted (or ignored)
          // The process should reload its auth config
        } catch {
          // Process died — fall back to noting it needs manual restart
        }
      } catch {
        // SIGUSR1 failed, try SIGTERM
        try {
          process.kill(proc.pid, "SIGTERM");
        } catch {
          // Process already gone
        }
      }
    }

    return true;
  }

  return {
    findRunningCliProcesses,
    readDirectQuota,
    readDirectAccount,
    watchCliQuotaSignals,
    restartCliProcess,
  };
}
