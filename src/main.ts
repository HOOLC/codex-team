import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from "node:process";
import { join } from "node:path";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import packageJson from "../package.json";

import { maskAccountId } from "./auth-snapshot.js";
import {
  AccountStore,
  type AccountQuotaSummary,
  createAccountStore,
} from "./account-store.js";
import {
  createCodexDesktopLauncher,
  type CodexDesktopLauncher,
  type ManagedCodexDesktopState,
  type ManagedQuotaSignal,
  type ManagedWatchActivitySignal,
  type ManagedWatchStatusEvent,
  type RuntimeQuotaSnapshot,
  type RunningCodexDesktop,
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
} from "./codex-desktop-launch.js";
import {
  createWatchProcessManager,
  type WatchProcessState,
  type WatchProcessManager,
} from "./watch-process.js";
import {
  createCodexLoginProvider,
  type CodexLoginProvider,
} from "./codex-login.js";
import {
  CliUsageError,
  parseArgs,
  type ParsedArgs,
  validateParsedArgs,
} from "./cli/args.js";
import {
  printHelp,
} from "./cli/help.js";
import {
  describeAutoSwitchNoop,
  describeAutoSwitchSelection,
  isTerminalWatchQuota,
  rankAutoSwitchCandidates,
  toCliQuotaSummary,
  toCliQuotaSummaryFromRuntimeQuota,
  type AutoSwitchCandidate,
} from "./cli/quota.js";
import { writeJson } from "./cli/output.js";
import {
  handleAddCommand,
  handleRemoveCommand,
  handleRenameCommand,
  handleSaveCommand,
  handleUpdateCommand,
} from "./commands/account-management.js";
import { handleCompletionCommand } from "./commands/completion.js";
import {
  handleCurrentCommand,
  handleDoctorCommand,
  handleListCommand,
} from "./commands/inspection.js";

import { getPlatform } from "./platform.js";
import {
  createCliProcessManager,
  type CliProcessManager,
} from "./codex-cli-watcher.js";

export { rankAutoSwitchCandidates } from "./cli/quota.js";

dayjs.extend(utc);
dayjs.extend(timezone);

interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

interface RunCliOptions extends Partial<CliStreams> {
  store?: AccountStore;
  desktopLauncher?: CodexDesktopLauncher;
  authLogin?: CodexLoginProvider;
  watchProcessManager?: WatchProcessManager;
  interruptSignal?: AbortSignal;
  managedDesktopWaitStatusDelayMs?: number;
  managedDesktopWaitStatusIntervalMs?: number;
  watchQuotaMinReadIntervalMs?: number;
  watchQuotaIdleReadIntervalMs?: number;
}

interface AutoSwitchSelection {
  refreshResult: Awaited<ReturnType<AccountStore["refreshAllQuotas"]>>;
  selected: AutoSwitchCandidate;
  candidates: AutoSwitchCandidate[];
  quota: ReturnType<typeof toCliQuotaSummary> | null;
  warnings: string[];
}

interface SwitchLockOwner {
  pid: number;
  command: string;
  started_at: string;
}
const SWITCH_LOCKS_DIR_NAME = "locks";
const SWITCH_LOCK_DIR_NAME = "switch.lock";

const NON_MANAGED_DESKTOP_WARNING_PREFIX =
  '"codexm switch" updates local auth, but running Codex Desktop may still use the previous login state.';
const NON_MANAGED_DESKTOP_FOLLOWUP_WARNING =
  'Use "codexm launch" to start Codex Desktop with the selected auth; future switches can apply immediately to that session.';
const INTERNAL_LAUNCH_REFUSAL_MESSAGE =
  'Refusing to run "codexm launch" from inside Codex Desktop because quitting the app would terminate this session. Run this command from an external terminal instead.';

function stripManagedDesktopWarning(warnings: string[]): string[] {
  return warnings.filter(
    (warning) =>
      warning !== NON_MANAGED_DESKTOP_WARNING_PREFIX &&
      warning !== NON_MANAGED_DESKTOP_FOLLOWUP_WARNING,
  );
}

const DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS = 1_000;
const DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS = 5_000;
const WATCH_AUTO_SWITCH_TIMEOUT_MS = 600_000;
const DEFAULT_WATCH_QUOTA_MIN_READ_INTERVAL_MS = 30_000;
const DEFAULT_WATCH_QUOTA_IDLE_READ_INTERVAL_MS = 120_000;

function startManagedDesktopWaitReporter(
  stream: NodeJS.WriteStream,
  options: {
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

  const timeoutHandle = setTimeout(() => {
    started = true;
    stream.write(
      "Waiting for the current Codex Desktop thread to finish before applying the switch...\n",
    );

    intervalHandle = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      stream.write(
        `Still waiting for the current Codex Desktop thread to finish (${elapsedSeconds}s elapsed)...\n`,
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
        stream.write("Applied the switch to the managed Codex Desktop session.\n");
      }
    },
  };
}

async function refreshManagedDesktopAfterSwitch(
  warnings: string[],
  desktopLauncher: CodexDesktopLauncher,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    statusStream?: NodeJS.WriteStream;
    statusDelayMs?: number;
    statusIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  let reporter: ReturnType<typeof startManagedDesktopWaitReporter> | null = null;
  if (options.force !== true && options.statusStream) {
    try {
      if (await desktopLauncher.isManagedDesktopRunning()) {
        reporter = startManagedDesktopWaitReporter(options.statusStream, {
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
      return;
    }
  } catch (error) {
    reporter?.stop("cancelled");
    if ((error as Error).name === "AbortError") {
      warnings.push(
        "Refreshing the running codexm-managed Codex Desktop session was interrupted after the local auth switched. Relaunch Codex Desktop or rerun switch --force to apply the change immediately.",
      );
      return;
    }

    warnings.push(
      `Failed to refresh the running codexm-managed Codex Desktop session: ${(error as Error).message}`,
    );
    return;
  }

  reporter?.stop("cancelled");

  try {
    const runningApps = await desktopLauncher.listRunningApps();
    if (runningApps.length === 0) {
      return;
    }

    if (runningApps.length > 0) {
      warnings.push(NON_MANAGED_DESKTOP_WARNING_PREFIX);
      warnings.push(NON_MANAGED_DESKTOP_FOLLOWUP_WARNING);
    }
  } catch {
    // Keep Desktop detection best-effort so switch success does not depend on local process inspection.
  }
}

function describeWatchQuotaUpdate(quota: ReturnType<typeof toCliQuotaSummary> | null): string {
  if (!quota) {
    return "Quota update: Usage: unavailable";
  }

  if (quota.refresh_status !== "ok") {
    if (quota.refresh_status === "unsupported") {
      return "Quota update: Usage: unsupported";
    }

    return `Quota update: Usage: ${quota.refresh_status}${quota.error_message ? ` | ${quota.error_message}` : ""}`;
  }

  return `Quota update: Usage: ${quota.available ?? "unknown"} | 5H ${quota.five_hour?.used_percent ?? "-"}% used | 1W ${quota.one_week?.used_percent ?? "-"}% used`;
}

function formatWatchLogLine(message: string): string {
  return `[${dayjs().format("HH:mm:ss")}] ${message}`;
}

function formatWatchField(key: string, value: string | number): string {
  if (typeof value === "number") {
    return `${key}=${value}`;
  }

  return `${key}=${JSON.stringify(value)}`;
}

function computeRemainingPercent(usedPercent: number | undefined): number | null {
  if (typeof usedPercent !== "number") {
    return null;
  }

  return Math.max(0, 100 - usedPercent);
}

function describeWatchQuotaEvent(
  accountLabel: string,
  quota: ReturnType<typeof toCliQuotaSummary> | null,
): string {
  if (!quota || quota.refresh_status !== "ok") {
    return `quota ${formatWatchField("account", accountLabel)} status=${
      quota?.refresh_status ?? "unavailable"
    }`;
  }

  return [
    "quota",
    formatWatchField("account", accountLabel),
    `usage=${quota.available ?? "unknown"}`,
    `5H=${computeRemainingPercent(quota.five_hour?.used_percent) ?? "-"}% left`,
    `1W=${computeRemainingPercent(quota.one_week?.used_percent) ?? "-"}% left`,
  ].join(" ");
}

function describeWatchStatusEvent(accountLabel: string, event: ManagedWatchStatusEvent): string {
  if (event.type === "reconnected") {
    return [
      "reconnect-ok",
      formatWatchField("account", accountLabel),
      formatWatchField("attempt", event.attempt),
    ].join(" ");
  }

  const fields = [
    "reconnect-lost",
    formatWatchField("account", accountLabel),
    formatWatchField("attempt", event.attempt),
  ];
  if (event.error) {
    fields.push(formatWatchField("error", event.error));
  }
  return fields.join(" ");
}

function describeWatchAutoSwitchEvent(fromAccount: string, toAccount: string, warnings: string[]): string {
  const fields = [
    "auto-switch",
    formatWatchField("from", fromAccount),
    formatWatchField("to", toAccount),
  ];
  if (warnings.length > 0) {
    fields.push(formatWatchField("warnings", warnings.length));
  }
  return fields.join(" ");
}

function describeWatchAutoSwitchSkippedEvent(accountLabel: string, reason: string): string {
  return [
    "auto-switch-skipped",
    formatWatchField("account", accountLabel),
    `reason=${reason}`,
  ].join(" ");
}

async function resolveWatchAccountLabel(store: AccountStore): Promise<string> {
  try {
    const current = await store.getCurrentStatus();
    if (current.matched_accounts.length === 1) {
      return current.matched_accounts[0];
    }
  } catch {
    // Keep watch logging best-effort when local current-state inspection fails.
  }

  return "current";
}

async function resolveManagedAccountByName(
  store: AccountStore,
  name: string,
): Promise<Awaited<ReturnType<AccountStore["listAccounts"]>>["accounts"][number] | null> {
  const { accounts } = await store.listAccounts();
  return accounts.find((account) => account.name === name) ?? null;
}

async function ensureDetachedWatch(
  watchProcessManager: WatchProcessManager,
  options: { autoSwitch: boolean; debug: boolean },
): Promise<
  | { action: "started" | "restarted"; state: WatchProcessState }
  | { action: "reused"; state: WatchProcessState }
> {
  const status = await watchProcessManager.getStatus();
  if (status.running && status.state) {
    if (
      status.state.auto_switch === options.autoSwitch &&
      status.state.debug === options.debug
    ) {
      return {
        action: "reused",
        state: status.state,
      };
    }

    await watchProcessManager.stop();
    return {
      action: "restarted",
      state: await watchProcessManager.startDetached(options),
    };
  }

  return {
    action: "started",
    state: await watchProcessManager.startDetached(options),
  };
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

function createDebugLogger(
  stream: NodeJS.WriteStream,
  enabled: boolean,
): (message: string) => void {
  if (!enabled) {
    return () => undefined;
  }

  return (message: string) => {
    stream.write(`[debug] ${message}\n`);
  };
}

async function tryReadManagedDesktopQuota(
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

interface AutoSwitchExecutionResult {
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

async function performAutoSwitch(
  store: AccountStore,
  desktopLauncher: CodexDesktopLauncher,
  options: {
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
  options.debugLog?.(`switch: mode=auto dry_run=${options.dryRun} force=${options.force}`);
  const selection = await selectAutoSwitchAccount(store);
  const { refreshResult, selected, candidates, quota, warnings } = selection;
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

  return performSelectedAutoSwitch(store, desktopLauncher, selection, options);
}

async function selectAutoSwitchAccount(store: AccountStore): Promise<AutoSwitchSelection> {
  const refreshResult = await store.refreshAllQuotas();
  const candidates = rankAutoSwitchCandidates(refreshResult.successes);
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

async function performSelectedAutoSwitch(
  store: AccountStore,
  desktopLauncher: CodexDesktopLauncher,
  selection: AutoSwitchSelection,
  options: {
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
  const { refreshResult, selected, candidates, quota, warnings } = selection;

  const currentStatus = await store.getCurrentStatus();
  if (
    selected.available === "available" &&
    currentStatus.matched_accounts.includes(selected.name)
  ) {
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

  const result = await store.switchAccount(selected.name);
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

async function readSwitchLockOwner(store: AccountStore): Promise<SwitchLockOwner | null> {
  try {
    const raw = await readFile(getSwitchLockOwnerPath(store), "utf8");
    const parsed = JSON.parse(raw) as Partial<SwitchLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.command === "string" &&
      typeof parsed.started_at === "string"
    ) {
      return {
        pid: parsed.pid,
        command: parsed.command,
        started_at: parsed.started_at,
      };
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      return null;
    }
  }

  return null;
}

async function tryAcquireSwitchLock(
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
    if (!existingOwner || !isProcessAlive(existingOwner.pid)) {
      await rm(lockPath, { recursive: true, force: true });
      created = await tryCreateLock();
    }
  }

  if (!created) {
    return {
      acquired: false,
      lockPath,
      owner: await readSwitchLockOwner(store),
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

function describeBusySwitchLock(lockPath: string, owner: SwitchLockOwner | null): string {
  let message = `Another codexm switch or launch operation is already in progress. Lock: ${lockPath}`;
  if (owner) {
    message += ` (pid ${owner.pid}, command ${JSON.stringify(owner.command)}, started ${owner.started_at})`;
  }
  return message;
}

async function confirmDesktopRelaunch(
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunningDesktopFromApp(
  app: RunningCodexDesktop,
  appPath: string,
): boolean {
  return app.command.includes(`${appPath}/Contents/MacOS/Codex`);
}

function isOnlyManagedDesktopInstanceRunning(
  runningApps: RunningCodexDesktop[],
  managedState: ManagedCodexDesktopState | null,
): boolean {
  if (!managedState || runningApps.length === 0) {
    return false;
  }

  return (
    runningApps.length === 1 &&
    runningApps[0].pid === managedState.pid &&
    isRunningDesktopFromApp(runningApps[0], managedState.app_path)
  );
}

async function resolveManagedDesktopState(
  desktopLauncher: CodexDesktopLauncher,
  appPath: string,
  existingApps: RunningCodexDesktop[],
): Promise<ManagedCodexDesktopState | null> {
  const existingPids = new Set(existingApps.map((app) => app.pid));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runningApps = await desktopLauncher.listRunningApps();
    const launchedApp =
      runningApps
        .filter(
          (app) =>
            isRunningDesktopFromApp(app, appPath) && !existingPids.has(app.pid),
        )
        .sort((left, right) => right.pid - left.pid)[0] ??
      runningApps
        .filter((app) => isRunningDesktopFromApp(app, appPath))
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

async function restoreLaunchBackup(
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

export async function runCli(
  argv: string[],
  options: RunCliOptions = {},
): Promise<number> {
  const streams: CliStreams = {
    stdin: options.stdin ?? defaultStdin,
    stdout: options.stdout ?? defaultStdout,
    stderr: options.stderr ?? defaultStderr,
  };
  const store = options.store ?? createAccountStore();
  const desktopLauncher = options.desktopLauncher ?? createCodexDesktopLauncher();
  const authLogin = options.authLogin ?? createCodexLoginProvider();
  const watchProcessManager =
    options.watchProcessManager ?? createWatchProcessManager(store.paths.codexTeamDir);
  const interruptSignal = options.interruptSignal;
  const managedDesktopWaitStatusDelayMs =
    options.managedDesktopWaitStatusDelayMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS;
  const managedDesktopWaitStatusIntervalMs =
    options.managedDesktopWaitStatusIntervalMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS;
  const watchQuotaMinReadIntervalMs =
    options.watchQuotaMinReadIntervalMs ?? DEFAULT_WATCH_QUOTA_MIN_READ_INTERVAL_MS;
  const watchQuotaIdleReadIntervalMs =
    options.watchQuotaIdleReadIntervalMs ?? DEFAULT_WATCH_QUOTA_IDLE_READ_INTERVAL_MS;
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("--json");
  const debug = parsed.flags.has("--debug");
  const debugLog = createDebugLogger(streams.stderr, debug);

  try {
    validateParsedArgs(parsed);

    if (parsed.flags.has("--version")) {
      streams.stdout.write(`${packageJson.version}\n`);
      return 0;
    }

    if (!parsed.command || parsed.flags.has("--help")) {
      printHelp(streams.stdout);
      return 0;
    }

    switch (parsed.command) {
      case "completion": {
        return await handleCompletionCommand({
          store,
          positionals: parsed.positionals,
          flags: parsed.flags,
          stdout: streams.stdout,
        });
      }

      case "current": {
        return await handleCurrentCommand({
          store,
          desktopLauncher,
          stdout: streams.stdout,
          debugLog,
          json,
          refresh: parsed.flags.has("--refresh"),
        });
      }

      case "doctor": {
        return await handleDoctorCommand({
          store,
          desktopLauncher,
          stdout: streams.stdout,
          debugLog,
          json,
        });
      }

      case "list": {
        return await handleListCommand({
          store,
          stdout: streams.stdout,
          debugLog,
          json,
          targetName: parsed.positionals[0],
          verbose: parsed.flags.has("--verbose"),
        });
      }

      case "add": {
        return await handleAddCommand({
          name: parsed.positionals[0],
          positionals: parsed.positionals,
          deviceAuth: parsed.flags.has("--device-auth"),
          withApiKey: parsed.flags.has("--with-api-key"),
          force: parsed.flags.has("--force"),
          json,
          store,
          authLogin,
          streams,
          debugLog,
        });
      }

      case "save": {
        return await handleSaveCommand({
          name: parsed.positionals[0],
          json,
          force: parsed.flags.has("--force"),
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "update": {
        return await handleUpdateCommand({
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "switch": {
        const auto = parsed.flags.has("--auto");
        const dryRun = parsed.flags.has("--dry-run");
        const force = parsed.flags.has("--force");
        const name = parsed.positionals[0];

        if (dryRun && !auto) {
          throw new Error("Usage: codexm switch --auto [--dry-run] [--force] [--json]");
        }

        if (auto) {
          if (name) {
            throw new Error("Usage: codexm switch --auto [--dry-run] [--force] [--json]");
          }

          const autoSwitch = dryRun
            ? await performAutoSwitch(store, desktopLauncher, {
                dryRun,
                force,
                signal: interruptSignal,
                statusStream: streams.stderr,
                statusDelayMs: managedDesktopWaitStatusDelayMs,
                statusIntervalMs: managedDesktopWaitStatusIntervalMs,
                debugLog,
              })
            : await (async () => {
                const autoSwitchCommand = "switch --auto";
                const lock = await tryAcquireSwitchLock(store, autoSwitchCommand);
                if (!lock.acquired) {
                  throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
                }

                try {
                  return await performAutoSwitch(store, desktopLauncher, {
                    dryRun,
                    force,
                    signal: interruptSignal,
                    statusStream: streams.stderr,
                    statusDelayMs: managedDesktopWaitStatusDelayMs,
                    statusIntervalMs: managedDesktopWaitStatusIntervalMs,
                    debugLog,
                  });
                } finally {
                  await lock.release();
                }
              })();
          const {
            refreshResult,
            selected,
            candidates,
            quota: selectedQuota,
            skipped,
            result,
            warnings,
          } = autoSwitch;

          if (dryRun) {
            const payload = {
              ok: true,
              action: "switch",
              mode: "auto",
              dry_run: true,
              selected,
              candidates,
              warnings,
            };

            if (json) {
              writeJson(streams.stdout, payload);
            } else {
              streams.stdout.write(
                `${describeAutoSwitchSelection(selected, true, null, warnings)}\n`,
              );
            }
            return refreshResult.failures.length === 0 ? 0 : 1;
          }

          if (skipped) {
            const payload = {
              ok: true,
              action: "switch",
              mode: "auto",
              skipped: true,
              reason: "already_current_best",
              account: {
                name: selected.name,
                account_id: selected.account_id,
                identity: selected.identity,
              },
              selected,
              candidates,
              quota: selectedQuota,
              warnings,
            };

            if (json) {
              writeJson(streams.stdout, payload);
            } else {
              streams.stdout.write(`${describeAutoSwitchNoop(selected, warnings)}\n`);
            }
            return refreshResult.failures.length === 0 ? 0 : 1;
          }
          if (!result) {
            throw new Error("Auto switch completed without a target account result.");
          }

          const payload = {
            ok: true,
            action: "switch",
            mode: "auto",
            account: {
              name: result.account.name,
              account_id: result.account.account_id,
              user_id: result.account.user_id ?? null,
              identity: result.account.identity,
              auth_mode: result.account.auth_mode,
            },
            selected,
            candidates,
            quota: selectedQuota,
            backup_path: result.backup_path,
            warnings: result.warnings,
          };

          if (json) {
            writeJson(streams.stdout, payload);
          } else {
            streams.stdout.write(
              `${describeAutoSwitchSelection(selected, false, result.backup_path, result.warnings)}\n`,
            );
          }
          return refreshResult.failures.length === 0 ? 0 : 1;
        }

        if (!name) {
          throw new Error("Usage: codexm switch <name> [--force]");
        }

        debugLog(`switch: mode=manual target=${name} force=${force}`);
        const switchCommand = `switch ${name}`;
        const lock = await tryAcquireSwitchLock(store, switchCommand);
        if (!lock.acquired) {
          throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
        }

        const result = await (async () => {
          try {
            const switched = await store.switchAccount(name);
            switched.warnings = stripManagedDesktopWarning(switched.warnings);
            await refreshManagedDesktopAfterSwitch(switched.warnings, desktopLauncher, {
              force,
              signal: interruptSignal,
              statusStream: streams.stderr,
              statusDelayMs: managedDesktopWaitStatusDelayMs,
              statusIntervalMs: managedDesktopWaitStatusIntervalMs,
            });
            return switched;
          } finally {
            await lock.release();
          }
        })();
        let quota: ReturnType<typeof toCliQuotaSummary> | null = null;
        try {
          await store.refreshQuotaForAccount(result.account.name);
          const quotaList = await store.listQuotaSummaries();
          const matched =
            quotaList.accounts.find((account) => account.name === result.account.name) ?? null;
          quota = matched ? toCliQuotaSummary(matched) : null;
        } catch (error) {
          result.warnings.push((error as Error).message);
        }
        debugLog(
          `switch: completed target=${result.account.name} warnings=${result.warnings.length} quota_refreshed=${quota !== null}`,
        );
        const payload = {
          ok: true,
          action: "switch",
          account: {
            name: result.account.name,
            account_id: result.account.account_id,
            user_id: result.account.user_id ?? null,
            identity: result.account.identity,
            auth_mode: result.account.auth_mode,
          },
          quota,
          backup_path: result.backup_path,
          warnings: result.warnings,
        };

        if (json) {
          writeJson(streams.stdout, payload);
        } else {
          streams.stdout.write(
            `Switched to "${result.account.name}" (${maskAccountId(result.account.identity)}).\n`,
          );
          if (result.backup_path) {
            streams.stdout.write(`Backup: ${result.backup_path}\n`);
          }
          for (const warning of result.warnings) {
            streams.stdout.write(`Warning: ${warning}\n`);
          }
        }
        return 0;
      }

      case "launch": {
        const name = parsed.positionals[0] ?? null;
        const auto = parsed.flags.has("--auto");
        const watch = parsed.flags.has("--watch");
        const noAutoSwitch = parsed.flags.has("--no-auto-switch");

        if (
          parsed.positionals.length > 1 ||
          (auto && name) ||
          (noAutoSwitch && !watch)
        ) {
          throw new Error("Usage: codexm launch [name] [--auto] [--watch] [--no-auto-switch] [--json]");
        }

        if (await desktopLauncher.isRunningInsideDesktopShell()) {
          throw new Error(INTERNAL_LAUNCH_REFUSAL_MESSAGE);
        }

        const warnings: string[] = [];
        const watchAutoSwitch = !noAutoSwitch;
        const appPath = await desktopLauncher.findInstalledApp();
        if (!appPath) {
          throw new Error("Codex Desktop not found at /Applications/Codex.app.");
        }
        debugLog(`launch: requested_account=${name ?? "current"}`);
        debugLog(`launch: using app path ${appPath}`);

        const runningApps = await desktopLauncher.listRunningApps();
        debugLog(`launch: running_desktop_instances=${runningApps.length}`);
        if (runningApps.length > 0) {
          const managedDesktopState = await desktopLauncher.readManagedState();
          const canRelaunchGracefully = isOnlyManagedDesktopInstanceRunning(
            runningApps,
            managedDesktopState,
          );
          const confirmed = await confirmDesktopRelaunch(
            streams,
            canRelaunchGracefully
              ? "Codex Desktop is already running. Close it and relaunch with the selected auth? [y/N] "
              : "Codex Desktop is already running outside codexm. Force-kill it and relaunch with the selected auth? [y/N] ",
          );
          if (!confirmed) {
            if (json) {
              writeJson(streams.stdout, {
                ok: false,
                action: "launch",
                cancelled: true,
              });
            } else {
              streams.stdout.write("Aborted.\n");
            }
            return 1;
          }

          await desktopLauncher.quitRunningApps({ force: !canRelaunchGracefully });
        }

        let switchedAccount: Awaited<ReturnType<AccountStore["switchAccount"]>>["account"] | null =
          null;
        let switchBackupPath: string | null = null;
        const requestedTargetName = name;
        if (auto || requestedTargetName) {
          const launchCommand = auto ? "launch --auto" : `launch ${requestedTargetName}`;
          const lock = await tryAcquireSwitchLock(store, launchCommand);
          if (!lock.acquired) {
            throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
          }

          try {
            const targetName = auto
              ? (await selectAutoSwitchAccount(store)).selected.name
              : requestedTargetName;
            if (auto) {
              debugLog(`launch: auto-selected account=${targetName ?? "current"}`);
            }
            const currentStatus = await store.getCurrentStatus();
            if (targetName && !currentStatus.matched_accounts.includes(targetName)) {
              const switchResult = await store.switchAccount(targetName);
              warnings.push(...stripManagedDesktopWarning(switchResult.warnings));
              switchedAccount = switchResult.account;
              switchBackupPath = switchResult.backup_path;
              debugLog(`launch: pre-switched account=${switchResult.account.name}`);
            } else if (targetName) {
              switchedAccount = await resolveManagedAccountByName(store, targetName);
            }

            try {
              await desktopLauncher.launch(appPath);
              const managedState = await resolveManagedDesktopState(
                desktopLauncher,
                appPath,
                runningApps,
              );
              if (!managedState) {
                await desktopLauncher.clearManagedState().catch(() => undefined);
                throw new Error(
                  "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
                );
              }
              await desktopLauncher.writeManagedState(managedState);
              debugLog(
                `launch: recorded managed desktop pid=${managedState.pid} port=${managedState.remote_debugging_port}`,
              );
            } catch (error) {
              if (switchedAccount) {
                await restoreLaunchBackup(store, switchBackupPath).catch(() => undefined);
                debugLog(
                  `launch: restored previous auth after failure for account=${switchedAccount.name}`,
                );
              }
              throw error;
            }
          } finally {
            await lock.release();
          }
        } else {
          try {
            await desktopLauncher.launch(appPath);
            const managedState = await resolveManagedDesktopState(
              desktopLauncher,
              appPath,
              runningApps,
            );
            if (!managedState) {
              await desktopLauncher.clearManagedState().catch(() => undefined);
              throw new Error(
                "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
              );
            }
            await desktopLauncher.writeManagedState(managedState);
            debugLog(
              `launch: recorded managed desktop pid=${managedState.pid} port=${managedState.remote_debugging_port}`,
            );
          } catch (error) {
            throw error;
          }
        }

        let detachedWatchResult:
          | Awaited<ReturnType<typeof ensureDetachedWatch>>
          | null = null;
        if (watch) {
          detachedWatchResult = await ensureDetachedWatch(watchProcessManager, {
            autoSwitch: watchAutoSwitch,
            debug,
          });
        }

        if (json) {
          writeJson(streams.stdout, {
            ok: true,
            action: "launch",
            account: switchedAccount
              ? {
                  name: switchedAccount.name,
                  account_id: switchedAccount.account_id,
                  user_id: switchedAccount.user_id ?? null,
                  identity: switchedAccount.identity,
                  auth_mode: switchedAccount.auth_mode,
                }
              : null,
            launched_with_current_auth: switchedAccount === null,
            app_path: appPath,
            relaunched: runningApps.length > 0,
            watch:
              detachedWatchResult === null
                ? null
                : {
                    action: detachedWatchResult.action,
                    pid: detachedWatchResult.state.pid,
                    started_at: detachedWatchResult.state.started_at,
                    log_path: detachedWatchResult.state.log_path,
                    auto_switch: detachedWatchResult.state.auto_switch,
                  },
            warnings,
          });
        } else {
          if (switchedAccount) {
            streams.stdout.write(
              `Switched to "${switchedAccount.name}" (${maskAccountId(switchedAccount.identity)}).\n`,
            );
          }
          if (runningApps.length > 0) {
            streams.stdout.write("Closed existing Codex Desktop instance and launched a new one.\n");
          }
          streams.stdout.write(
            switchedAccount
              ? `Launched Codex Desktop with "${switchedAccount.name}" (${maskAccountId(switchedAccount.identity)}).\n`
              : "Launched Codex Desktop with current auth.\n",
          );
          if (detachedWatchResult) {
            if (detachedWatchResult.action === "reused") {
              streams.stdout.write(
                `Background watch already running (pid ${detachedWatchResult.state.pid}).\n`,
              );
            } else {
              streams.stdout.write(
                `Started background watch (pid ${detachedWatchResult.state.pid}).\n`,
              );
              streams.stdout.write(`Log: ${detachedWatchResult.state.log_path}\n`);
            }
          }
          for (const warning of warnings) {
            streams.stdout.write(`Warning: ${warning}\n`);
          }
        }
        return 0;
      }

      case "watch": {
        if (parsed.positionals.length > 0) {
          throw new Error("Usage: codexm watch [--no-auto-switch] [--detach] [--status] [--stop]");
        }

        const autoSwitch = !parsed.flags.has("--no-auto-switch");
        const detach = parsed.flags.has("--detach");
        const status = parsed.flags.has("--status");
        const stop = parsed.flags.has("--stop");
        const modeCount = [detach, status, stop].filter(Boolean).length;

        if (modeCount > 1 || ((status || stop) && parsed.flags.has("--no-auto-switch"))) {
          throw new Error("Usage: codexm watch [--no-auto-switch] [--detach] [--status] [--stop]");
        }

        if (status) {
          const watchStatus = await watchProcessManager.getStatus();
          if (!watchStatus.running || !watchStatus.state) {
            streams.stdout.write("Watch: not running\n");
          } else {
            streams.stdout.write(`Watch: running (pid ${watchStatus.state.pid})\n`);
            streams.stdout.write(`Started at: ${watchStatus.state.started_at}\n`);
            streams.stdout.write(
              `Auto-switch: ${watchStatus.state.auto_switch ? "enabled" : "disabled"}\n`,
            );
            streams.stdout.write(`Log: ${watchStatus.state.log_path}\n`);
          }
          return 0;
        }

        if (stop) {
          const stopResult = await watchProcessManager.stop();
          if (!stopResult.stopped || !stopResult.state) {
            streams.stdout.write("Watch: not running\n");
          } else {
            streams.stdout.write(`Stopped background watch (pid ${stopResult.state.pid}).\n`);
          }
          return 0;
        }

        const desktopRunning = await desktopLauncher.isManagedDesktopRunning();

        if (!desktopRunning && detach) {
          throw new Error(
            "Detached CLI watch is not yet supported. Run \"codexm watch\" in the foreground instead.",
          );
        }

        // ── CLI-mode watch (no Desktop running) ──
        if (!desktopRunning) {
          const platform = await getPlatform();
          debugLog(`watch: no managed Desktop detected, entering CLI watch mode (platform=${platform})`);
          streams.stderr.write(
            `${formatWatchLogLine("No managed Codex Desktop session — entering CLI watch mode")}\n`,
          );

          const cliManager = createCliProcessManager({
            pollIntervalMs: watchQuotaMinReadIntervalMs,
          });

          // Discover and register existing CLI processes
          const discovered = await cliManager.findRunningCliProcesses();
          if (discovered.length > 0) {
            streams.stderr.write(
              `${formatWatchLogLine(`Found ${discovered.length} running codex CLI process(es)`)}\n`,
            );
            for (const proc of discovered) {
              debugLog(`watch: discovered CLI process pid=${proc.pid} command=${proc.command}`);
            }
          }

          let cliWatchExitCode = 0;
          let cliSwitchInFlight = false;
          let cliLastSwitchStartedAt = 0;
          let cliLastQuotaUpdateLine: string | null = null;
          let cliCurrentAccountLabel = await resolveWatchAccountLabel(store);
          const CLI_WATCH_SWITCH_COOLDOWN_MS = 5_000;

          const handleCliQuotaResult = async (options: {
            requestId: string;
            quota: ReturnType<typeof toCliQuotaSummary> | null;
            shouldAutoSwitch: boolean;
          }) => {
            const quota = options.quota;
            const quotaUpdateLine = describeWatchQuotaEvent(cliCurrentAccountLabel, quota);
            if (quotaUpdateLine !== cliLastQuotaUpdateLine) {
              streams.stdout.write(`${formatWatchLogLine(quotaUpdateLine)}\n`);
              cliLastQuotaUpdateLine = quotaUpdateLine;
            }

            if (!autoSwitch || !options.shouldAutoSwitch) {
              return;
            }

            const lock = await tryAcquireSwitchLock(store, "watch-cli");
            if (!lock.acquired) {
              streams.stdout.write(
                `${formatWatchLogLine(
                  describeWatchAutoSwitchSkippedEvent(cliCurrentAccountLabel, "lock-busy"),
                )}\n`,
              );
              return;
            }

            const now = Date.now();
            if (cliSwitchInFlight || now - cliLastSwitchStartedAt < CLI_WATCH_SWITCH_COOLDOWN_MS) {
              await lock.release();
              return;
            }

            cliSwitchInFlight = true;
            cliLastSwitchStartedAt = now;

            try {
              const switchResult = await performAutoSwitch(store, desktopLauncher, {
                dryRun: false,
                force: false,
                signal: interruptSignal,
                statusStream: streams.stderr,
                statusDelayMs: managedDesktopWaitStatusDelayMs,
                statusIntervalMs: managedDesktopWaitStatusIntervalMs,
                timeoutMs: WATCH_AUTO_SWITCH_TIMEOUT_MS,
                debugLog,
              });

              if (switchResult.skipped) {
                cliCurrentAccountLabel = switchResult.selected.name;
                streams.stdout.write(
                  `${formatWatchLogLine(
                    describeWatchAutoSwitchSkippedEvent(cliCurrentAccountLabel, "already-best"),
                  )}\n`,
                );
              } else if (switchResult.result) {
                const previousLabel = cliCurrentAccountLabel;
                cliCurrentAccountLabel = switchResult.result.account.name;
                streams.stdout.write(
                  `${formatWatchLogLine(
                    describeWatchAutoSwitchEvent(
                      previousLabel,
                      cliCurrentAccountLabel,
                      switchResult.result.warnings,
                    ),
                  )}\n`,
                );

                // Signal CLI processes to reload auth for the switched account
                const restartResult = await cliManager.restartCliProcess({
                  accountId: switchResult.selected.account_id ?? undefined,
                  signal: interruptSignal,
                });
                if (restartResult.restarted > 0) {
                  streams.stderr.write(
                    `${formatWatchLogLine(
                      `Signalled ${restartResult.restarted} CLI process(es) to reload auth`,
                    )}\n`,
                  );
                }
                if (restartResult.failed > 0) {
                  streams.stderr.write(
                    `${formatWatchLogLine(
                      `Failed to signal ${restartResult.failed} CLI process(es)`,
                    )}\n`,
                  );
                }
              }

              if (switchResult.refreshResult.failures.length > 0) {
                cliWatchExitCode = 1;
              }
            } finally {
              cliSwitchInFlight = false;
              await lock.release();
            }
          };

          try {
            await cliManager.watchCliQuotaSignals({
              pollIntervalMs: watchQuotaMinReadIntervalMs,
              signal: interruptSignal,
              debugLogger: debug
                ? (line) => {
                    streams.stderr.write(`${line}\n`);
                  }
                : undefined,
              onStatus: async (event) => {
                if (event.type === "disconnected") {
                  streams.stderr.write(
                    `${formatWatchLogLine(`CLI connection lost (attempt ${event.attempt}): ${event.error ?? "unknown"}`)}\n`,
                  );
                } else if (event.type === "reconnected") {
                  streams.stderr.write(
                    `${formatWatchLogLine("CLI connection established")}\n`,
                  );
                }
              },
              onQuotaSignal: async (quotaSignal) => {
                const quota = quotaSignal.quota
                  ? toCliQuotaSummaryFromRuntimeQuota(quotaSignal.quota)
                  : null;
                await handleCliQuotaResult({
                  requestId: quotaSignal.requestId,
                  quota,
                  shouldAutoSwitch: quotaSignal.shouldAutoSwitch,
                });
              },
            });
          } catch (error) {
            if (!interruptSignal?.aborted) {
              streams.stderr.write(`Error: ${(error as Error).message}\n`);
              cliWatchExitCode = 1;
            }
          }

          return cliWatchExitCode;
        }



        if (detach) {
          const detachedState = await watchProcessManager.startDetached({
            autoSwitch,
            debug,
          });
          streams.stdout.write(`Started background watch (pid ${detachedState.pid}).\n`);
          streams.stdout.write(`Log: ${detachedState.log_path}\n`);
          return 0;
        }

        let watchExitCode = 0;
        let switchInFlight = false;
        let lastSwitchStartedAt = 0;
        let lastQuotaUpdateLine: string | null = null;
        let currentWatchAccountLabel = await resolveWatchAccountLabel(store);
        const WATCH_SWITCH_COOLDOWN_MS = 5_000;

        debugLog("watch: starting managed desktop quota watch");
        debugLog(`watch: auto-switch ${autoSwitch ? "enabled" : "disabled"}`);

        const handleQuotaReadResult = async (options: {
          requestId: string;
          quota: ReturnType<typeof toCliQuotaSummary> | null;
          shouldAutoSwitch: boolean;
        }) => {
          const quota = options.quota;
          const quotaUpdateLine = describeWatchQuotaEvent(currentWatchAccountLabel, quota);
          if (quotaUpdateLine !== lastQuotaUpdateLine) {
            streams.stdout.write(`${formatWatchLogLine(quotaUpdateLine)}\n`);
            lastQuotaUpdateLine = quotaUpdateLine;
          } else {
            debugLog(`watch: quota output unchanged for requestId=${options.requestId}`);
          }
          if (!autoSwitch) {
            return;
          }

          if (!options.shouldAutoSwitch) {
            debugLog(
              `watch: skipping auto switch for requestId=${options.requestId} because the event is informational only`,
            );
            return;
          }

          const lock = await tryAcquireSwitchLock(store, "watch");
          if (!lock.acquired) {
            debugLog(`watch: switch lock is busy at ${lock.lockPath}`);
            streams.stdout.write(
              `${formatWatchLogLine(
                describeWatchAutoSwitchSkippedEvent(currentWatchAccountLabel, "lock-busy"),
              )}\n`,
            );
            return;
          }

          const now = Date.now();
          if (switchInFlight || now - lastSwitchStartedAt < WATCH_SWITCH_COOLDOWN_MS) {
            await lock.release();
            debugLog(
              `watch: skipped auto switch for requestId=${options.requestId} because another switch is already in progress`,
            );
            return;
          }

          switchInFlight = true;
          lastSwitchStartedAt = now;

          try {
            const autoSwitch = await performAutoSwitch(store, desktopLauncher, {
              dryRun: false,
              force: false,
              signal: interruptSignal,
              statusStream: streams.stderr,
              statusDelayMs: managedDesktopWaitStatusDelayMs,
              statusIntervalMs: managedDesktopWaitStatusIntervalMs,
              timeoutMs: WATCH_AUTO_SWITCH_TIMEOUT_MS,
              debugLog,
            });

            if (autoSwitch.skipped) {
              currentWatchAccountLabel = autoSwitch.selected.name;
              streams.stdout.write(
                `${formatWatchLogLine(
                  describeWatchAutoSwitchSkippedEvent(currentWatchAccountLabel, "already-best"),
                )}\n`,
              );
            } else if (autoSwitch.result) {
              const previousAccountLabel = currentWatchAccountLabel;
              currentWatchAccountLabel = autoSwitch.result.account.name;
              streams.stdout.write(
                `${formatWatchLogLine(
                  describeWatchAutoSwitchEvent(
                    previousAccountLabel,
                    currentWatchAccountLabel,
                    autoSwitch.result.warnings,
                  ),
                )}\n`,
              );
            }

            if (autoSwitch.refreshResult.failures.length > 0) {
              watchExitCode = 1;
            }
          } finally {
            switchInFlight = false;
            await lock.release();
          }
        };

        let quotaReadTimer: NodeJS.Timeout | null = null;
        let idleQuotaReadTimer: NodeJS.Timeout | null = null;
        let quotaReadInFlight = false;
        let lastQuotaReadStartedAt = 0;
        let pendingQuotaReadReason: string | null = null;
        let watchStopped = false;

        const clearQuotaReadTimer = () => {
          if (quotaReadTimer) {
            clearTimeout(quotaReadTimer);
            quotaReadTimer = null;
          }
        };

        const readManagedQuotaForWatch = async (reason: string) => {
          if (watchStopped || interruptSignal?.aborted) {
            return;
          }

          if (quotaReadInFlight) {
            pendingQuotaReadReason = reason;
            return;
          }

          quotaReadInFlight = true;
          lastQuotaReadStartedAt = Date.now();
          debugLog(`watch: reading managed Desktop quota reason=${reason}`);
          try {
            const quota = await tryReadManagedDesktopQuota(desktopLauncher, debugLog);
            if (watchStopped || interruptSignal?.aborted) {
              return;
            }
            await handleQuotaReadResult({
              requestId: `poll:${reason}`,
              quota,
              shouldAutoSwitch: isTerminalWatchQuota(quota),
            });
          } finally {
            quotaReadInFlight = false;
            const nextReason = pendingQuotaReadReason;
            pendingQuotaReadReason = null;
            if (nextReason && !watchStopped && !interruptSignal?.aborted) {
              scheduleQuotaRead(nextReason);
            }
          }
        };

        function scheduleQuotaRead(reason: string): void {
          if (watchStopped || interruptSignal?.aborted) {
            return;
          }

          pendingQuotaReadReason = reason;
          if (quotaReadTimer || quotaReadInFlight) {
            return;
          }

          const elapsedMs =
            lastQuotaReadStartedAt === 0
              ? watchQuotaMinReadIntervalMs
              : Date.now() - lastQuotaReadStartedAt;
          const delayMs = Math.max(0, watchQuotaMinReadIntervalMs - elapsedMs);
          debugLog(`watch: scheduled quota read reason=${reason} delay_ms=${delayMs}`);
          quotaReadTimer = setTimeout(() => {
            quotaReadTimer = null;
            const queuedReason = pendingQuotaReadReason ?? reason;
            pendingQuotaReadReason = null;
            void readManagedQuotaForWatch(queuedReason).catch((error) => {
              watchExitCode = 1;
              streams.stderr.write(`Error: ${(error as Error).message}\n`);
            });
          }, delayMs);
        }

        const scheduleIdleQuotaRead = () => {
          if (watchStopped || interruptSignal?.aborted || watchQuotaIdleReadIntervalMs <= 0) {
            return;
          }

          idleQuotaReadTimer = setTimeout(() => {
            idleQuotaReadTimer = null;
            scheduleQuotaRead("idle");
            scheduleIdleQuotaRead();
          }, watchQuotaIdleReadIntervalMs);
        };

        try {
          await readManagedQuotaForWatch("startup");
          scheduleIdleQuotaRead();

          await desktopLauncher.watchManagedQuotaSignals({
            signal: interruptSignal,
            debugLogger: debug
              ? (line) => {
                  streams.stderr.write(`${line}\n`);
                }
              : undefined,
            onStatus: (event) => {
              streams.stderr.write(
                `${formatWatchLogLine(describeWatchStatusEvent(currentWatchAccountLabel, event))}\n`,
              );
            },
            onActivitySignal: (activitySignal: ManagedWatchActivitySignal) => {
              debugLog(
                `watch: activity signal matched reason=${activitySignal.reason} requestId=${activitySignal.requestId}`,
              );
              scheduleQuotaRead(activitySignal.reason);
            },
            onQuotaSignal: async (quotaSignal: ManagedQuotaSignal) => {
              debugLog(
                `watch: quota signal matched reason=${quotaSignal.reason} requestId=${quotaSignal.requestId}`,
              );

              const quota = await tryReadManagedDesktopQuota(
                desktopLauncher,
                debugLog,
                quotaSignal.quota,
              );
              await handleQuotaReadResult({
                requestId: quotaSignal.requestId,
                quota,
                shouldAutoSwitch: quotaSignal.shouldAutoSwitch,
              });
            },
          });
        } finally {
          watchStopped = true;
          clearQuotaReadTimer();
          if (idleQuotaReadTimer) {
            clearTimeout(idleQuotaReadTimer);
          }
        }

        return watchExitCode;
      }

      case "remove": {
        return await handleRemoveCommand({
          name: parsed.positionals[0],
          json,
          yes: parsed.flags.has("--yes"),
          store,
          streams,
          debugLog,
        });
      }

      case "rename": {
        return await handleRenameCommand({
          oldName: parsed.positionals[0],
          newName: parsed.positionals[1],
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      default:
        throw new CliUsageError(`Unknown command "${parsed.command}".`);
    }
  } catch (error) {
    const message = (error as Error).message;
    const suggestion = error instanceof CliUsageError ? error.suggestion : null;
    if (json) {
      writeJson(streams.stderr, {
        ok: false,
        error: message,
        ...(suggestion ? { suggestion } : {}),
      });
    } else {
      streams.stderr.write(`Error: ${message}\n`);
      if (suggestion) {
        streams.stderr.write(`Did you mean "${suggestion}"?\n`);
      }
    }
    return 1;
  }
}
