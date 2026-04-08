import { copyFile, rm, stat } from "node:fs/promises";
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
  type RunningCodexDesktop,
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
} from "./codex-desktop-launch.js";

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
  interruptSignal?: AbortSignal;
  managedDesktopWaitStatusDelayMs?: number;
  managedDesktopWaitStatusIntervalMs?: number;
}

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Set<string>;
}

interface AutoSwitchCandidate {
  name: string;
  account_id: string;
  identity: string;
  plan_type: string | null;
  available: string | null;
  refresh_status: "ok";
  effective_score: number;
  remain_5h: number;
  remain_1w_eq_5h: number;
  five_hour_used: number;
  one_week_used: number;
  five_hour_reset_at: string | null;
  one_week_reset_at: string | null;
}

class CliUsageError extends Error {
  suggestion: string | null;

  constructor(message: string, suggestion: string | null = null) {
    super(message);
    this.name = "CliUsageError";
    this.suggestion = suggestion;
  }
}

const COMMAND_NAMES = [
  "current",
  "list",
  "save",
  "update",
  "switch",
  "launch",
  "remove",
  "rename",
] as const;

const GLOBAL_FLAGS = new Set(["--help", "--version"]);

const COMMAND_FLAGS: Record<(typeof COMMAND_NAMES)[number], Set<string>> = {
  current: new Set(["--json"]),
  list: new Set(["--json"]),
  save: new Set(["--force", "--json"]),
  update: new Set(["--json"]),
  switch: new Set(["--auto", "--dry-run", "--force", "--json"]),
  launch: new Set(["--json"]),
  remove: new Set(["--yes", "--json"]),
  rename: new Set(["--json"]),
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }

  return {
    command: positionals[0] ?? null,
    positionals: positionals.slice(1),
    flags,
  };
}

function writeJson(stream: NodeJS.WriteStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const nextDiagonal = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      );
      diagonal = nextDiagonal;
    }
  }

  return previous[right.length];
}

function findClosestSuggestion(value: string, candidates: string[]): string | null {
  let bestCandidate: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = levenshteinDistance(value, candidate);
    if (distance < bestDistance) {
      bestCandidate = candidate;
      bestDistance = distance;
    }
  }

  const threshold = Math.max(2, Math.ceil(value.length / 3));
  return bestDistance <= threshold ? bestCandidate : null;
}

function validateParsedArgs(parsed: ParsedArgs): void {
  if (parsed.command && !COMMAND_NAMES.includes(parsed.command as (typeof COMMAND_NAMES)[number])) {
    throw new CliUsageError(
      `Unknown command "${parsed.command}".`,
      findClosestSuggestion(parsed.command, [...COMMAND_NAMES]),
    );
  }

  const allowedFlags = new Set<string>(GLOBAL_FLAGS);
  if (parsed.command) {
    for (const flag of COMMAND_FLAGS[parsed.command as keyof typeof COMMAND_FLAGS]) {
      allowedFlags.add(flag);
    }
  }

  for (const flag of parsed.flags) {
    if (!allowedFlags.has(flag)) {
      const commandContext = parsed.command ? ` for command "${parsed.command}"` : "";
      throw new CliUsageError(
        `Unknown flag "${flag}"${commandContext}.`,
        findClosestSuggestion(flag, [...allowedFlags]),
      );
    }
  }
}

function formatTable(
  rows: Array<Record<string, string>>,
  columns: Array<{ key: string; label: string }>,
): string {
  if (rows.length === 0) {
    return "";
  }

  const widths = columns.map(({ key, label }) =>
    Math.max(label.length, ...rows.map((row) => row[key].length)),
  );

  const renderRow = (row: Record<string, string>) =>
    columns
      .map(({ key }, index) => row[key].padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  const header = renderRow(
    Object.fromEntries(columns.map(({ key, label }) => [key, label])),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("  ");

  return [header, separator, ...rows.map(renderRow)].join("\n");
}

function describeCurrentListStatus(
  status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
): string {
  if (!status.exists) {
    return "Current auth: missing";
  }

  if (status.matched_accounts.length === 0) {
    return "Current auth: unmanaged";
  }

  if (status.matched_accounts.length === 1) {
    return `Current managed account: ${status.matched_accounts[0]}`;
  }

  return `Current managed account: multiple (${status.matched_accounts.join(", ")})`;
}

function printHelp(stream: NodeJS.WriteStream): void {
  stream.write(`codexm - manage multiple Codex ChatGPT auth snapshots

Usage:
  codexm --version
  codexm --help
  codexm current [--json]
  codexm list [name] [--json]
  codexm save <name> [--force] [--json]
  codexm update [--json]
  codexm switch <name> [--force] [--json]
  codexm switch --auto [--dry-run] [--force] [--json]
  codexm launch [name] [--json]
  codexm remove <name> [--yes] [--json]
  codexm rename <old> <new> [--json]

Notes:
  codexm list refreshes quota data, shows the current managed account, and marks current rows with "*".
  Run codexm launch from an external terminal if you need to restart Codex Desktop.
  Unknown commands and flags fail fast; close matches include a suggestion.

Account names must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.
`);
}

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
        timeoutMs: DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
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

function describeCurrentStatus(status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>): string {
  const lines: string[] = [];

  if (!status.exists) {
    lines.push("Current auth: missing");
  } else {
    lines.push("Current auth: present");
    lines.push(`Auth mode: ${status.auth_mode}`);
    lines.push(`Identity: ${maskAccountId(status.identity ?? "")}`);
    if (status.matched_accounts.length === 0) {
      lines.push("Managed account: no (unmanaged)");
    } else if (status.matched_accounts.length === 1) {
      lines.push(`Managed account: ${status.matched_accounts[0]}`);
    } else {
      lines.push(`Managed account: multiple (${status.matched_accounts.join(", ")})`);
    }
  }

  for (const warning of status.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

function formatUsagePercent(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window) {
    return "-";
  }

  return `${window.used_percent}%`;
}

function formatResetAt(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window?.reset_at) {
    return "-";
  }

  return dayjs.utc(window.reset_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm");
}

function computeAvailability(account: AccountQuotaSummary): string | null {
  if (account.status !== "ok") {
    return null;
  }

  const usedPercents = [account.five_hour?.used_percent, account.one_week?.used_percent].filter(
    (value): value is number => typeof value === "number",
  );

  if (usedPercents.length === 0) {
    return null;
  }

  if (usedPercents.some((value) => value >= 100)) {
    return "unavailable";
  }

  if (usedPercents.some((value) => 100 - value < 10)) {
    return "almost unavailable";
  }

  return "available";
}

function toCliQuotaSummary(account: AccountQuotaSummary) {
  const { status, ...rest } = account;
  return {
    ...rest,
    available: computeAvailability(account),
    refresh_status: status,
  };
}

function toCliQuotaRefreshResult(result: {
  successes: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
}) {
  return {
    successes: result.successes.map(toCliQuotaSummary),
    failures: result.failures,
  };
}

function computeRemainingPercent(usedPercent: number | undefined): number | null {
  if (typeof usedPercent !== "number") {
    return null;
  }

  return Math.max(0, 100 - usedPercent);
}

function toAutoSwitchCandidate(account: AccountQuotaSummary): AutoSwitchCandidate | null {
  if (account.status !== "ok") {
    return null;
  }

  const remain5h = computeRemainingPercent(account.five_hour?.used_percent);
  const remain1w = computeRemainingPercent(account.one_week?.used_percent);
  if (remain5h === null || remain1w === null) {
    return null;
  }

  return {
    name: account.name,
    account_id: account.account_id,
    identity: account.identity,
    plan_type: account.plan_type,
    available: computeAvailability(account),
    refresh_status: "ok",
    effective_score: Math.min(remain5h, remain1w * 3),
    remain_5h: remain5h,
    remain_1w_eq_5h: remain1w * 3,
    five_hour_used: account.five_hour?.used_percent ?? 0,
    one_week_used: account.one_week?.used_percent ?? 0,
    five_hour_reset_at: account.five_hour?.reset_at ?? null,
    one_week_reset_at: account.one_week?.reset_at ?? null,
  };
}

function compareNullableDateAscending(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left.localeCompare(right);
}

function rankAutoSwitchCandidates(accounts: AccountQuotaSummary[]): AutoSwitchCandidate[] {
  return accounts
    .map(toAutoSwitchCandidate)
    .filter((candidate): candidate is AutoSwitchCandidate => candidate !== null)
    .sort((left, right) => {
      if (right.effective_score !== left.effective_score) {
        return right.effective_score - left.effective_score;
      }
      if (right.remain_5h !== left.remain_5h) {
        return right.remain_5h - left.remain_5h;
      }
      if (right.remain_1w_eq_5h !== left.remain_1w_eq_5h) {
        return right.remain_1w_eq_5h - left.remain_1w_eq_5h;
      }

      const fiveHourResetOrder = compareNullableDateAscending(
        left.five_hour_reset_at,
        right.five_hour_reset_at,
      );
      if (fiveHourResetOrder !== 0) {
        return fiveHourResetOrder;
      }

      const oneWeekResetOrder = compareNullableDateAscending(
        left.one_week_reset_at,
        right.one_week_reset_at,
      );
      if (oneWeekResetOrder !== 0) {
        return oneWeekResetOrder;
      }

      return left.name.localeCompare(right.name);
    });
}

function describeAutoSwitchSelection(
  candidate: AutoSwitchCandidate,
  dryRun: boolean,
  backupPath: string | null,
  warnings: string[],
): string {
  const lines = [
    dryRun
      ? `Best account: "${candidate.name}" (${maskAccountId(candidate.identity)}).`
      : `Auto-switched to "${candidate.name}" (${maskAccountId(candidate.identity)}).`,
    `Score: ${candidate.effective_score}`,
    `5H remaining: ${candidate.remain_5h}%`,
    `1W remaining (5H-equivalent): ${candidate.remain_1w_eq_5h}%`,
  ];

  if (backupPath) {
    lines.push(`Backup: ${backupPath}`);
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

function describeAutoSwitchNoop(candidate: AutoSwitchCandidate, warnings: string[]): string {
  const lines = [
    `Current account "${candidate.name}" (${maskAccountId(candidate.identity)}) is already the best available account.`,
    `Score: ${candidate.effective_score}`,
    `5H remaining: ${candidate.remain_5h}%`,
    `1W remaining (5H-equivalent): ${candidate.remain_1w_eq_5h}%`,
  ];

  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

function describeQuotaAccounts(
  accounts: AccountQuotaSummary[],
  currentStatus: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
  warnings: string[],
): string {
  if (accounts.length === 0) {
    const lines = [describeCurrentListStatus(currentStatus), "No saved accounts."];
    for (const warning of warnings) {
      lines.push(`Warning: ${warning}`);
    }

    return lines.join("\n");
  }

  const currentAccounts = new Set(currentStatus.matched_accounts);

  const table = formatTable(
    accounts.map((account) => ({
      name: `${currentAccounts.has(account.name) ? "*" : " "} ${account.name}`,
      account_id: maskAccountId(account.identity),
      plan_type: account.plan_type ?? "-",
      available: computeAvailability(account) ?? "-",
      five_hour: formatUsagePercent(account.five_hour),
      five_hour_reset: formatResetAt(account.five_hour),
      one_week: formatUsagePercent(account.one_week),
      one_week_reset: formatResetAt(account.one_week),
      refresh_status: account.status,
    })),
    [
      { key: "name", label: "  NAME" },
      { key: "account_id", label: "IDENTITY" },
      { key: "plan_type", label: "PLAN TYPE" },
      { key: "available", label: "AVAILABLE" },
      { key: "five_hour", label: "5H USED" },
      { key: "five_hour_reset", label: "5H RESET AT" },
      { key: "one_week", label: "1W USED" },
      { key: "one_week_reset", label: "1W RESET AT" },
      { key: "refresh_status", label: "REFRESH STATUS" },
    ],
  );

  const lines = [describeCurrentListStatus(currentStatus), "Refreshed quotas:", table];
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

function describeQuotaRefresh(result: {
  successes: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
}, currentStatus: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>): string {
  const lines: string[] = [];

  if (result.successes.length > 0) {
    lines.push(describeQuotaAccounts(result.successes, currentStatus, []));
  } else {
    lines.push(describeQuotaAccounts([], currentStatus, []));
  }

  for (const failure of result.failures) {
    lines.push(`Failure: ${failure.name}: ${failure.error}`);
  }

  if (lines.length === 0) {
    lines.push(describeQuotaAccounts([], currentStatus, []));
  }

  return lines.join("\n");
}

async function confirmRemoval(
  name: string,
  streams: CliStreams,
): Promise<boolean> {
  if (!streams.stdin.isTTY) {
    throw new Error(`Refusing to remove "${name}" without --yes in a non-interactive terminal.`);
  }

  streams.stdout.write(`Remove saved account "${name}"? [y/N] `);

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

async function confirmDesktopRelaunch(streams: CliStreams): Promise<boolean> {
  if (!streams.stdin.isTTY) {
    throw new Error("Refusing to relaunch Codex Desktop in a non-interactive terminal.");
  }

  streams.stdout.write(
    "Codex Desktop is already running. Close it and relaunch with the selected auth? [y/N] ",
  );

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

function isRunningDesktopFromApp(
  app: RunningCodexDesktop,
  appPath: string,
): boolean {
  return app.command.includes(`${appPath}/Contents/MacOS/Codex`);
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
  const interruptSignal = options.interruptSignal;
  const managedDesktopWaitStatusDelayMs =
    options.managedDesktopWaitStatusDelayMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS;
  const managedDesktopWaitStatusIntervalMs =
    options.managedDesktopWaitStatusIntervalMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS;
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("--json");

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
      case "current": {
        const result = await store.getCurrentStatus();
        if (json) {
          writeJson(streams.stdout, result);
        } else {
          streams.stdout.write(`${describeCurrentStatus(result)}\n`);
        }
        return 0;
      }

      case "list": {
        const targetName = parsed.positionals[0];
        const result = await store.refreshAllQuotas(targetName);
        const current = await store.getCurrentStatus();
        const currentAccounts = new Set(current.matched_accounts);
        if (json) {
          writeJson(streams.stdout, {
            ...toCliQuotaRefreshResult(result),
            current,
            successes: result.successes.map((account) => ({
              ...toCliQuotaSummary(account),
              is_current: currentAccounts.has(account.name),
            })),
          });
        } else {
          streams.stdout.write(`${describeQuotaRefresh(result, current)}\n`);
        }
        return result.failures.length === 0 ? 0 : 1;
      }

      case "save": {
        const name = parsed.positionals[0];
        if (!name) {
          throw new Error("Usage: codexm save <name> [--force]");
        }

        const account = await store.saveCurrentAccount(name, parsed.flags.has("--force"));
        const payload = {
          ok: true,
          action: "save",
          account: {
            name: account.name,
            account_id: account.account_id,
            user_id: account.user_id ?? null,
            identity: account.identity,
            auth_mode: account.auth_mode,
          },
        };

        if (json) {
          writeJson(streams.stdout, payload);
        } else {
          streams.stdout.write(
            `Saved account "${account.name}" (${maskAccountId(account.identity)}).\n`,
          );
        }
        return 0;
      }

      case "update": {
        const result = await store.updateCurrentManagedAccount();
        const warnings: string[] = [];
        let quota: ReturnType<typeof toCliQuotaSummary> | null = null;

        try {
          const quotaResult = await store.refreshQuotaForAccount(result.account.name);
          const quotaList = await store.listQuotaSummaries();
          const matched =
            quotaList.accounts.find((account) => account.name === quotaResult.account.name) ??
            null;
          quota = matched ? toCliQuotaSummary(matched) : null;
        } catch (error) {
          warnings.push((error as Error).message);
        }

        const payload = {
          ok: true,
          action: "update",
          account: {
            name: result.account.name,
            account_id: result.account.account_id,
            user_id: result.account.user_id ?? null,
            identity: result.account.identity,
            auth_mode: result.account.auth_mode,
          },
          quota,
          warnings,
        };

        if (json) {
          writeJson(streams.stdout, payload);
        } else {
          streams.stdout.write(
            `Updated managed account "${result.account.name}" (${maskAccountId(result.account.identity)}).\n`,
          );
          for (const warning of warnings) {
            streams.stdout.write(`Warning: ${warning}\n`);
          }
        }
        return 0;
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

          const refreshResult = await store.refreshAllQuotas();
          const candidates = rankAutoSwitchCandidates(refreshResult.successes);
          if (candidates.length === 0) {
            throw new Error("No auto-switch candidate has both 5H and 1W quota data available.");
          }

          const selected = candidates[0];
          const selectedQuota =
            refreshResult.successes.find((account) => account.name === selected.name) ?? null;
          const warnings = refreshResult.failures.map(
            (failure) => `${failure.name}: ${failure.error}`,
          );

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

          const currentStatus = await store.getCurrentStatus();
          if (
            selected.available === "available" &&
            currentStatus.matched_accounts.includes(selected.name)
          ) {
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
              quota: selectedQuota ? toCliQuotaSummary(selectedQuota) : null,
              warnings,
            };

            if (json) {
              writeJson(streams.stdout, payload);
            } else {
              streams.stdout.write(`${describeAutoSwitchNoop(selected, warnings)}\n`);
            }
            return refreshResult.failures.length === 0 ? 0 : 1;
          }

          const result = await store.switchAccount(selected.name);
          for (const warning of warnings) {
            result.warnings.push(warning);
          }
          result.warnings = stripManagedDesktopWarning(result.warnings);

          await refreshManagedDesktopAfterSwitch(result.warnings, desktopLauncher, {
            force,
            signal: interruptSignal,
            statusStream: streams.stderr,
            statusDelayMs: managedDesktopWaitStatusDelayMs,
            statusIntervalMs: managedDesktopWaitStatusIntervalMs,
          });

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
            quota: selectedQuota ? toCliQuotaSummary(selectedQuota) : null,
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

        const result = await store.switchAccount(name);
        result.warnings = stripManagedDesktopWarning(result.warnings);
        await refreshManagedDesktopAfterSwitch(result.warnings, desktopLauncher, {
          force,
          signal: interruptSignal,
          statusStream: streams.stderr,
          statusDelayMs: managedDesktopWaitStatusDelayMs,
          statusIntervalMs: managedDesktopWaitStatusIntervalMs,
        });
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

        if (parsed.positionals.length > 1) {
          throw new Error("Usage: codexm launch [name] [--json]");
        }

        if (await desktopLauncher.isRunningInsideDesktopShell()) {
          throw new Error(INTERNAL_LAUNCH_REFUSAL_MESSAGE);
        }

        const warnings: string[] = [];
        const appPath = await desktopLauncher.findInstalledApp();
        if (!appPath) {
          throw new Error("Codex Desktop not found at /Applications/Codex.app.");
        }

        const runningApps = await desktopLauncher.listRunningApps();
        if (runningApps.length > 0) {
          const confirmed = await confirmDesktopRelaunch(streams);
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

          await desktopLauncher.quitRunningApps();
        }

        let switchedAccount: Awaited<ReturnType<AccountStore["switchAccount"]>>["account"] | null =
          null;
        let switchBackupPath: string | null = null;
        if (name) {
          const switchResult = await store.switchAccount(name);
          warnings.push(...stripManagedDesktopWarning(switchResult.warnings));
          switchedAccount = switchResult.account;
          switchBackupPath = switchResult.backup_path;
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
        } catch (error) {
          if (switchedAccount) {
            await restoreLaunchBackup(store, switchBackupPath).catch(() => undefined);
          }
          throw error;
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
          for (const warning of warnings) {
            streams.stdout.write(`Warning: ${warning}\n`);
          }
        }
        return 0;
      }

      case "remove": {
        const name = parsed.positionals[0];
        if (!name) {
          throw new Error("Usage: codexm remove <name> [--yes]");
        }

        const confirmed =
          parsed.flags.has("--yes") || (await confirmRemoval(name, streams));
        if (!confirmed) {
          if (json) {
            writeJson(streams.stdout, {
              ok: false,
              action: "remove",
              account: name,
              cancelled: true,
            });
          } else {
            streams.stdout.write("Cancelled.\n");
          }
          return 1;
        }

        await store.removeAccount(name);
        if (json) {
          writeJson(streams.stdout, { ok: true, action: "remove", account: name });
        } else {
          streams.stdout.write(`Removed account "${name}".\n`);
        }
        return 0;
      }

      case "rename": {
        const oldName = parsed.positionals[0];
        const newName = parsed.positionals[1];
        if (!oldName || !newName) {
          throw new Error("Usage: codexm rename <old> <new>");
        }

        const account = await store.renameAccount(oldName, newName);
        if (json) {
          writeJson(streams.stdout, {
            ok: true,
            action: "rename",
            account: {
              name: account.name,
              account_id: account.account_id,
              user_id: account.user_id ?? null,
              identity: account.identity,
              auth_mode: account.auth_mode,
            },
          });
        } else {
          streams.stdout.write(`Renamed "${oldName}" to "${newName}".\n`);
        }
        return 0;
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
