import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AccountQuotaSummary,
  AccountStore,
} from "./account-store/index.js";
import type {
  CodexDesktopLauncher,
  RuntimeQuotaSnapshot,
} from "./desktop/launcher.js";
import { isSyntheticProxyRuntimeActive, markProxyRoutingDisabled } from "./proxy/runtime.js";
import {
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
} from "./desktop/launcher.js";
import {
  rankAutoSwitchCandidates,
  toCliQuotaSummary,
  toCliQuotaSummaryFromRuntimeQuota,
  type AutoSwitchCandidate,
} from "./cli/quota.js";
import { appendEventLog, buildEventPayload, shortenErrorMessage } from "./logging.js";

export interface AutoSwitchSelection {
  refreshResult: Awaited<ReturnType<AccountStore["refreshAllQuotas"]>>;
  selected: AutoSwitchCandidate;
  candidates: AutoSwitchCandidate[];
  quota: ReturnType<typeof toCliQuotaSummary> | null;
  warnings: string[];
}

export interface AutoSwitchExecutionResult {
  refreshResult: {
    successes: AccountQuotaSummary[];
    failures: Array<{ name: string; error: string }>;
  };
  selected: AutoSwitchCandidate;
  candidates: AutoSwitchCandidate[];
  quota: ReturnType<typeof toCliQuotaSummary> | null;
  skipped: boolean;
  result: Awaited<ReturnType<AccountStore["switchAccount"]>> | null;
  warnings: string[];
}

export interface SwitchLockOwner {
  pid: number;
  command: string;
  started_at: string;
}

type SwitchLockOwnerReadResult =
  | { status: "ok"; owner: SwitchLockOwner }
  | { status: "missing" | "invalid"; owner: null };

const SWITCH_LOCKS_DIR_NAME = "locks";
const SWITCH_LOCK_DIR_NAME = "switch.lock";
const DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS = 1_000;
const DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS = 5_000;

export const NON_MANAGED_DESKTOP_WARNING_PREFIX =
  '"codexm switch" updates local auth, but running Codex Desktop may still use the previous login state.';
export const NON_MANAGED_DESKTOP_FOLLOWUP_WARNING =
  'Use "codexm launch" to start Codex Desktop with the selected auth; future switches can apply immediately to that session.';

export function stripManagedDesktopWarning(warnings: string[]): string[] {
  return warnings.filter(
    (warning) =>
      warning !== NON_MANAGED_DESKTOP_WARNING_PREFIX &&
      warning !== NON_MANAGED_DESKTOP_FOLLOWUP_WARNING,
  );
}

function startManagedDesktopWaitReporter(
  options: {
    stream?: NodeJS.WriteStream;
    onStatusMessage?: (message: string) => void;
    delayMs?: number;
    intervalMs?: number;
  } = {},
): {
  stop: (result: "success" | "cancelled") => void;
} {
  const delayMs = options.delayMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS;
  const startedAt = Date.now();
  let started = false;
  let intervalHandle: NodeJS.Timeout | null = null;
  const emitStatusMessage = (message: string) => {
    options.stream?.write(`${message}\n`);
    options.onStatusMessage?.(message);
  };

  const timeoutHandle = setTimeout(() => {
    started = true;
    emitStatusMessage("Waiting for the current Codex Desktop thread to finish before applying the switch...");

    intervalHandle = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      emitStatusMessage(
        `Still waiting for the current Codex Desktop thread to finish (${elapsedSeconds}s elapsed)...`,
      );
    }, intervalMs);
    intervalHandle.unref?.();
  }, delayMs);
  timeoutHandle.unref?.();

  return {
    stop: (result) => {
      clearTimeout(timeoutHandle);
      if (intervalHandle) {
        clearInterval(intervalHandle);
      }

      if (started && result === "success") {
        emitStatusMessage("Applied the switch to the managed Codex Desktop session.");
      }
    },
  };
}

export async function refreshManagedDesktopAfterSwitch(
  warnings: string[],
  desktopLauncher: CodexDesktopLauncher,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    statusStream?: NodeJS.WriteStream;
    onStatusMessage?: (message: string) => void;
    statusDelayMs?: number;
    statusIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<"applied" | "killed" | "none" | "other-running" | "failed"> {
  let reporter: ReturnType<typeof startManagedDesktopWaitReporter> | null = null;
  if (options.force !== true && (options.statusStream || options.onStatusMessage)) {
    try {
      if (await desktopLauncher.isManagedDesktopRunning()) {
        reporter = startManagedDesktopWaitReporter({
          stream: options.statusStream,
          onStatusMessage: options.onStatusMessage,
          delayMs: options.statusDelayMs,
          intervalMs: options.statusIntervalMs,
        });
      }
    } catch {
      // Keep status reporting best-effort, same as the rest of Desktop inspection.
    }
  }

  try {
    if (
      await desktopLauncher.applyManagedSwitch({
        force: options.force === true,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
      })
    ) {
      reporter?.stop("success");
      return "applied";
    }
  } catch (error) {
    reporter?.stop("cancelled");
    if ((error as Error).name === "AbortError") {
      warnings.push(
        "Refreshing the running codexm-managed Codex Desktop session was interrupted after the local auth switched. Relaunch Codex Desktop or rerun switch --force to apply the change immediately.",
      );
      return "failed";
    }

    if (options.force === true) {
      try {
        await desktopLauncher.quitRunningApps({ force: true });
        warnings.push(
          `Force-killed the running codexm-managed Codex Desktop session because the immediate refresh path failed: ${(error as Error).message} Relaunch Codex Desktop to continue with the new auth.`,
        );
        return "killed";
      } catch (fallbackError) {
        warnings.push(
          `Failed to refresh the running codexm-managed Codex Desktop session: ${(error as Error).message} Fallback force-kill also failed: ${(fallbackError as Error).message}`,
        );
        return "failed";
      }
    }

    warnings.push(
      `Failed to refresh the running codexm-managed Codex Desktop session: ${(error as Error).message}`,
    );
    return "failed";
  }

  reporter?.stop("cancelled");

  try {
    const runningApps = await desktopLauncher.listRunningApps();
    if (runningApps.length === 0) {
      return "none";
    }

    if (runningApps.length > 0) {
      warnings.push(NON_MANAGED_DESKTOP_WARNING_PREFIX);
      warnings.push(NON_MANAGED_DESKTOP_FOLLOWUP_WARNING);
      return "other-running";
    }
  } catch {
    // Keep Desktop detection best-effort so switch success does not depend on local process inspection.
  }

  return "failed";
}

export async function resolveManagedAccountByName(
  store: AccountStore,
  name: string,
): Promise<Awaited<ReturnType<AccountStore["listAccounts"]>>["accounts"][number] | null> {
  const { accounts } = await store.listAccounts();
  return accounts.find((account) => account.name === name) ?? null;
}

export async function tryReadManagedDesktopQuota(
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: (message: string) => void,
  fallbackQuota?: RuntimeQuotaSnapshot | null,
): Promise<ReturnType<typeof toCliQuotaSummary> | null> {
  if (fallbackQuota) {
    debugLog?.("watch: using quota carried by Desktop bridge signal");
    return toCliQuotaSummaryFromRuntimeQuota(fallbackQuota);
  }

  try {
    const quota = await desktopLauncher.readManagedCurrentQuota();
    if (!quota) {
      debugLog?.("watch: managed Desktop quota unavailable");
      return null;
    }

    debugLog?.("watch: using managed Desktop quota");
    return toCliQuotaSummaryFromRuntimeQuota(quota);
  } catch (error) {
    debugLog?.(`watch: managed Desktop quota read failed: ${(error as Error).message}`);
    return null;
  }
}

export async function selectAutoSwitchAccount(store: AccountStore): Promise<AutoSwitchSelection> {
  const refreshResult = await store.refreshAllQuotas();
  const candidates = rankAutoSwitchCandidates(
    refreshResult.successes.filter((account) => account.auto_switch_eligible ?? true),
  );
  if (candidates.length === 0) {
    throw new Error("No auto-switch candidate has usable 5H or 1W quota data available.");
  }

  const selected = candidates[0];
  const selectedQuota =
    refreshResult.successes.find((account) => account.name === selected.name) ?? null;
  const quota = selectedQuota ? toCliQuotaSummary(selectedQuota) : null;
  const warnings = refreshResult.failures.map((failure) => `${failure.name}: ${failure.error}`);

  return {
    refreshResult,
    selected,
    candidates,
    quota,
    warnings,
  };
}

export async function performAutoSwitch(
  store: AccountStore,
  desktopLauncher: CodexDesktopLauncher,
  selectionOrOptions:
    | AutoSwitchSelection
    | {
        dryRun: boolean;
        force: boolean;
        signal?: AbortSignal;
        statusStream?: NodeJS.WriteStream;
        statusDelayMs?: number;
        statusIntervalMs?: number;
        timeoutMs?: number;
        debugLog?: (message: string) => void;
      },
  maybeOptions?: {
    dryRun: boolean;
    force: boolean;
    signal?: AbortSignal;
    statusStream?: NodeJS.WriteStream;
    statusDelayMs?: number;
    statusIntervalMs?: number;
    timeoutMs?: number;
    debugLog?: (message: string) => void;
  },
): Promise<AutoSwitchExecutionResult> {
  const selection = maybeOptions
    ? selectionOrOptions as AutoSwitchSelection
    : await selectAutoSwitchAccount(store);
  const options = (maybeOptions ?? selectionOrOptions) as {
    dryRun: boolean;
    force: boolean;
    signal?: AbortSignal;
    statusStream?: NodeJS.WriteStream;
    statusDelayMs?: number;
    statusIntervalMs?: number;
    timeoutMs?: number;
    debugLog?: (message: string) => void;
  };

  options.debugLog?.(`switch: mode=auto dry_run=${options.dryRun} force=${options.force}`);
  const { refreshResult, selected, candidates, quota, warnings } = selection;
  await appendEventLog(store.paths.codexTeamDir, buildEventPayload({
    component: "switch",
    event: "account.autoswitch.selected",
    trigger: "cli",
    fields: {
      target_account_name: selected.name,
      candidate_count: candidates.length,
      dry_run: options.dryRun,
      force: options.force,
    },
  }));
  if (options.dryRun) {
    options.debugLog?.(
      `switch: auto-selected target=${selected.name} candidates=${candidates.length} warnings=${warnings.length} dry_run=true`,
    );
    return {
      refreshResult,
      selected,
      candidates,
      quota,
      skipped: false,
      result: null,
      warnings,
    };
  }

  const currentStatus = await store.getCurrentStatus();
  if (
    selected.available === "available" &&
    currentStatus.matched_accounts.includes(selected.name)
  ) {
    await appendEventLog(store.paths.codexTeamDir, buildEventPayload({
      component: "switch",
      event: "account.autoswitch.skipped",
      trigger: "cli",
      fields: {
        account_name: selected.name,
        reason: "already-best",
      },
    }));
    options.debugLog?.(
      `switch: auto-selected target=${selected.name} candidates=${candidates.length} skipped=already_current_best`,
    );
    return {
      refreshResult,
      selected,
      candidates,
      quota,
      skipped: true,
      result: null,
      warnings,
    };
  }

  let result: Awaited<ReturnType<AccountStore["switchAccount"]>>;
  try {
    const proxyModeWasActive = await isSyntheticProxyRuntimeActive(store);
    result = await store.switchAccount(selected.name);
    if (proxyModeWasActive) {
      await markProxyRoutingDisabled(store);
    }
  } catch (error) {
    await appendEventLog(store.paths.codexTeamDir, buildEventPayload({
      component: "switch",
      event: "account.switch.failed",
      trigger: "cli",
      level: "error",
      errorMessageShort: shortenErrorMessage((error as Error).message),
      fields: {
        target_account_name: selected.name,
        mode: "auto",
      },
    }));
    throw error;
  }
  for (const warning of warnings) {
    result.warnings.push(warning);
  }
  result.warnings = stripManagedDesktopWarning(result.warnings);

  await refreshManagedDesktopAfterSwitch(result.warnings, desktopLauncher, {
    force: options.force,
    signal: options.signal,
    statusStream: options.statusStream,
    statusDelayMs: options.statusDelayMs,
    statusIntervalMs: options.statusIntervalMs,
    timeoutMs: options.timeoutMs,
  });
  options.debugLog?.(
    `switch: completed mode=auto target=${result.account.name} candidates=${candidates.length} warnings=${result.warnings.length}`,
  );
  await appendEventLog(store.paths.codexTeamDir, buildEventPayload({
    component: "switch",
    event: "account.switch.completed",
    trigger: "cli",
    fields: {
      target_account_name: result.account.name,
      mode: "auto",
      warning_count: result.warnings.length,
    },
  }));

  return {
    refreshResult,
    selected,
    candidates,
    quota,
    skipped: false,
    result,
    warnings: result.warnings,
  };
}

function getSwitchLockDir(store: AccountStore): string {
  return join(store.paths.codexTeamDir, SWITCH_LOCKS_DIR_NAME, SWITCH_LOCK_DIR_NAME);
}

function getSwitchLockOwnerPath(store: AccountStore): string {
  return join(getSwitchLockDir(store), "owner.json");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function readSwitchLockOwner(store: AccountStore): Promise<SwitchLockOwnerReadResult> {
  try {
    const raw = await readFile(getSwitchLockOwnerPath(store), "utf8");
    const parsed = JSON.parse(raw) as Partial<SwitchLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.command === "string" &&
      typeof parsed.started_at === "string"
    ) {
      return {
        status: "ok",
        owner: {
          pid: parsed.pid,
          command: parsed.command,
          started_at: parsed.started_at,
        },
      };
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {
        status: "missing",
        owner: null,
      };
    }

    return {
      status: "invalid",
      owner: null,
    };
  }

  return {
    status: "invalid",
    owner: null,
  };
}

export async function tryAcquireSwitchLock(
  store: AccountStore,
  command: string,
): Promise<
  | { acquired: true; lockPath: string; release: () => Promise<void> }
  | { acquired: false; lockPath: string; owner: SwitchLockOwner | null }
> {
  const locksDir = join(store.paths.codexTeamDir, SWITCH_LOCKS_DIR_NAME);
  const lockPath = getSwitchLockDir(store);
  const ownerPath = getSwitchLockOwnerPath(store);
  await mkdir(locksDir, { recursive: true, mode: 0o700 });

  const tryCreateLock = async (): Promise<boolean> => {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  };

  let created = await tryCreateLock();
  if (!created) {
    const existingOwner = await readSwitchLockOwner(store);
    if (existingOwner.status === "ok" && !isProcessAlive(existingOwner.owner.pid)) {
      await rm(lockPath, { recursive: true, force: true });
      created = await tryCreateLock();
    }
  }

  if (!created) {
    const existingOwner = await readSwitchLockOwner(store);
    return {
      acquired: false,
      lockPath,
      owner: existingOwner.owner,
    };
  }

  const owner: SwitchLockOwner = {
    pid: process.pid,
    command,
    started_at: new Date().toISOString(),
  };

  try {
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    acquired: true,
    lockPath,
    release: async () => {
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

export function describeBusySwitchLock(lockPath: string, owner: SwitchLockOwner | null): string {
  let message = `Another codexm switch or launch operation is already in progress. Lock: ${lockPath}`;
  if (owner) {
    message += ` (pid ${owner.pid}, command ${JSON.stringify(owner.command)}, started ${owner.started_at})`;
  } else {
    message += " (owner metadata unavailable; if no switch or launch is running, remove the stale lock and retry)";
  }
  return message;
}
