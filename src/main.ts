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
  type ManagedCurrentQuotaSnapshot,
  type ManagedCodexDesktopState,
  type ManagedQuotaSignal,
  type ManagedWatchStatusEvent,
  type RunningCodexDesktop,
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
} from "./codex-desktop-launch.js";
import {
  createWatchProcessManager,
  type WatchProcessState,
  type WatchProcessManager,
} from "./watch-process.js";

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
  watchProcessManager?: WatchProcessManager;
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
  current_score: number;
  score_1h: number;
  projected_5h_1h: number | null;
  projected_5h_in_1w_units_1h: number | null;
  projected_1w_1h: number | null;
  remain_5h: number | null;
  remain_5h_in_1w_units: number | null;
  remain_1w: number | null;
  five_hour_windows_per_week: number;
  five_hour_used: number | null;
  one_week_used: number | null;
  five_hour_reset_at: string | null;
  one_week_reset_at: string | null;
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
  "watch",
  "remove",
  "rename",
  "completion",
] as const;

const GLOBAL_FLAGS = new Set(["--help", "--version", "--debug"]);

const AUTO_SWITCH_SCORING = {
  // Approximate how many plan-relative 5H windows fit into the same 1W budget.
  // 1W is treated as the shared unit across plans; a larger factor means the
  // plan's 5H window is smaller, so the same weekly budget covers more 5H windows.
  defaultFiveHourWindowsPerWeek: 3,
  fiveHourWindowsPerWeekByPlan: {
    plus: 3,
    team: 8,
  },
} as const;

const AUTO_SWITCH_PROJECTION_HORIZON_SECONDS = 3_600;
const AUTO_SWITCH_CURRENT_SCORE_TIEBREAK_DELTA = 5;
const SWITCH_LOCKS_DIR_NAME = "locks";
const SWITCH_LOCK_DIR_NAME = "switch.lock";

const COMMAND_FLAGS: Record<(typeof COMMAND_NAMES)[number], Set<string>> = {
  current: new Set(["--json", "--refresh"]),
  list: new Set(["--json", "--verbose"]),
  save: new Set(["--force", "--json"]),
  update: new Set(["--json"]),
  switch: new Set(["--auto", "--dry-run", "--force", "--json"]),
  launch: new Set(["--auto", "--watch", "--no-auto-switch", "--json"]),
  watch: new Set(["--no-auto-switch", "--detach", "--status", "--stop"]),
  remove: new Set(["--yes", "--json"]),
  rename: new Set(["--json"]),
  completion: new Set(["--accounts"]),
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
  codexm completion <zsh|bash>
  codexm current [--refresh] [--json]
  codexm list [name] [--verbose] [--json]
  codexm save <name> [--force] [--json]
  codexm update [--json]
  codexm switch <name> [--force] [--json]
  codexm switch --auto [--dry-run] [--force] [--json]
  codexm launch [name] [--auto] [--watch] [--no-auto-switch] [--json]
  codexm watch [--no-auto-switch] [--detach] [--status] [--stop]
  codexm remove <name> [--yes] [--json]
  codexm rename <old> <new> [--json]

Global flags: --help, --version, --debug

Notes:
  codexm current shows live usage when a managed Codex Desktop session is available.
  codexm current --refresh prefers managed Desktop MCP quota, then falls back to the usage API.
  codexm list refreshes quota data, shows the current managed account, and marks current rows with "*"; use --verbose to expand score inputs.
  Run codexm launch from an external terminal if you need to restart Codex Desktop.
  Unknown commands and flags fail fast; close matches include a suggestion.

Account names must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.
`);
}

const COMPLETION_ACCOUNT_COMMANDS = new Set(["launch", "list", "remove", "rename", "switch"] as const);

function quoteBashWords(words: readonly string[]): string {
  return words.join(" ");
}

function describeCommandFlag(flag: string): string {
  switch (flag) {
    case "--accounts":
      return `${flag}[print saved account names for shell completion]`;
    case "--auto":
      return `${flag}[switch to the best available account]`;
    case "--debug":
      return `${flag}[enable debug logging]`;
    case "--detach":
      return `${flag}[run watch in the background]`;
    case "--no-auto-switch":
      return `${flag}[watch without switching accounts automatically]`;
    case "--dry-run":
      return `${flag}[show the selected account without switching]`;
    case "--force":
      return `${flag}[skip confirmation and force the action]`;
    case "--help":
      return `${flag}[show help]`;
    case "--json":
      return `${flag}[print JSON output]`;
    case "--refresh":
      return `${flag}[refresh quota data before printing]`;
    case "--status":
      return `${flag}[show background watch status]`;
    case "--stop":
      return `${flag}[stop the background watch]`;
    case "--watch":
      return `${flag}[start a detached watch after launch]`;
    case "--version":
      return `${flag}[print the installed version]`;
    case "--yes":
      return `${flag}[skip removal confirmation]`;
    default:
      return `${flag}[option]`;
  }
}

function buildCompletionZshScript(): string {
  const commands = COMMAND_NAMES.map((command) => `'${command}:${command} command'`).join("\n    ");
  const globalFlags = [...GLOBAL_FLAGS].map(describeCommandFlag).map((flag) => `'${flag}'`).join("\n    ");

  const commandCases = COMMAND_NAMES.map((command) => {
    const flags = [...COMMAND_FLAGS[command]]
      .map(describeCommandFlag)
      .map((flag) => `'${flag}'`)
      .join(" ");
    return `    ${command})
      command_flags=(${flags})
      ;;`;
  }).join("\n");

  const accountCommandPattern = [...COMPLETION_ACCOUNT_COMMANDS].join("|");

  return `#compdef codexm

_codexm() {
  local -a commands global_flags command_flags accounts
  local command=\${words[2]}

  commands=(
    ${commands}
  )
  global_flags=(
    ${globalFlags}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'command' commands
    _describe -t flags 'global flag' global_flags
    return 0
  fi

  if [[ \$command == completion ]]; then
    _describe -t completion-target 'completion target' \\
      'zsh:zsh completion script' \\
      'bash:bash completion script' \\
      '--accounts:print saved account names for completion'
    return 0
  fi

  if (( CURRENT == 3 )) && [[ \${words[CURRENT]} != --* ]]; then
    case \$command in
      ${accountCommandPattern}) ;;
      *) return 0 ;;
    esac

    accounts=(\${(@f)\$(codexm completion --accounts 2>/dev/null)})
    if (( \${#accounts[@]} > 0 )); then
      _describe -t accounts 'account' accounts
      return 0
    fi
  fi

  command_flags=()
  case \$command in
${commandCases}
  esac

  if [[ \${words[CURRENT]} == --* ]]; then
    _describe -t flags 'global flag' global_flags
    _describe -t flags 'command flag' command_flags
  fi
}

_codexm "$@"
`;
}

function buildCompletionBashScript(): string {
  const commands = COMMAND_NAMES.join(" ");
  const globalFlags = [...GLOBAL_FLAGS].join(" ");
  const commandCases = COMMAND_NAMES.map((command) => {
    const flags = [...COMMAND_FLAGS[command]].join(" ");
    return `    ${command}) command_flags="${flags}" ;;`;
  }).join("\n");

  const accountCommandCases = [...COMPLETION_ACCOUNT_COMMANDS]
    .map((command) => `    ${command})`)
    .join("|");

  return `_codexm() {
  local cur prev command command_flags global_flags commands accounts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"
  global_flags="${quoteBashWords([...GLOBAL_FLAGS])}"
  commands="${commands}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands} \${global_flags}" -- "\${cur}") )
    return 0
  fi

  if [[ "\${command}" == "completion" ]]; then
    COMPREPLY=( $(compgen -W "zsh bash --accounts" -- "\${cur}") )
    return 0
  fi

  if [[ \${COMP_CWORD} -eq 2 && "\${cur}" != --* ]]; then
    case "\${command}" in
      ${accountCommandCases})
        accounts="$(codexm completion --accounts 2>/dev/null)"
        COMPREPLY=( $(compgen -W "\${accounts}" -- "\${cur}") )
        return 0
        ;;
    esac
  fi

  command_flags=""
  case "\${command}" in
${commandCases}
  esac

  if [[ "\${cur}" == --* ]]; then
    COMPREPLY=( $(compgen -W "\${global_flags} \${command_flags}" -- "\${cur}") )
  fi
}

complete -F _codexm codexm
`;
}

async function listCompletionAccountNames(store: AccountStore): Promise<string[]> {
  const { accounts } = await store.listAccounts();
  return accounts.map((account) => account.name).sort((left, right) => left.localeCompare(right));
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
const WATCH_AUTO_SWITCH_TIMEOUT_MS = 600_000;

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

function describeCurrentUsageSummary(
  quota: ReturnType<typeof toCliQuotaSummary> | null,
  unavailableReason: string | null,
  sourceLabel?: string,
): string {
  if (quota === null) {
    return unavailableReason ? `Usage: ${unavailableReason}` : "Usage: unavailable";
  }

  if (quota.refresh_status !== "ok") {
    if (quota.refresh_status === "unsupported") {
      return "Usage: unsupported";
    }

    return `Usage: ${quota.refresh_status}${quota.error_message ? ` | ${quota.error_message}` : ""}`;
  }

  return [
    `Usage: ${quota.available ?? "unknown"}`,
    `5H ${quota.five_hour?.used_percent ?? "-"}% used`,
    `1W ${quota.one_week?.used_percent ?? "-"}% used`,
    sourceLabel ??
      `fetched ${
        quota.fetched_at
          ? dayjs.utc(quota.fetched_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm")
          : "unknown"
      }`,
  ].join(" | ");
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

function describeCurrentStatus(
  status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
  usage?: {
    quota: ReturnType<typeof toCliQuotaSummary> | null;
    unavailableReason: string | null;
    sourceLabel?: string;
  },
): string {
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

  if (usage) {
    lines.push(
      describeCurrentUsageSummary(usage.quota, usage.unavailableReason, usage.sourceLabel),
    );
  }

  return lines.join("\n");
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

async function tryReadManagedCurrentQuota(
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: (message: string) => void,
  fallbackQuota?: ManagedCurrentQuotaSnapshot | null,
): Promise<ReturnType<typeof toCliQuotaSummary> | null> {
  if (fallbackQuota) {
    debugLog?.("current: using quota from matched managed MCP signal");
    return toCliQuotaSummaryFromManagedCurrentQuota(fallbackQuota);
  }

  try {
    const quota = await desktopLauncher.readManagedCurrentQuota();
    if (!quota) {
      debugLog?.("current: managed MCP quota unavailable");
      return null;
    }

    debugLog?.("current: using managed MCP quota");
    return toCliQuotaSummaryFromManagedCurrentQuota(quota);
  } catch (error) {
    debugLog?.(`current: managed MCP quota read failed: ${(error as Error).message}`);
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

function toCliQuotaSummaryFromManagedCurrentQuota(quota: ManagedCurrentQuotaSnapshot) {
  const normalizeWindow = (
    window: ManagedCurrentQuotaSnapshot["five_hour"] | ManagedCurrentQuotaSnapshot["one_week"],
  ): AccountQuotaSummary["five_hour"] =>
    window
      ? {
          used_percent: window.used_percent,
          window_seconds: window.window_seconds,
          ...(window.reset_at ? { reset_at: window.reset_at } : {}),
        }
      : null;

  const account: AccountQuotaSummary = {
    name: "__current__",
    account_id: "__current__",
    user_id: null,
    identity: "__current__",
    plan_type: quota.plan_type,
    credits_balance: quota.credits_balance,
    status: "ok",
    fetched_at: quota.fetched_at,
    error_message: null,
    unlimited: quota.unlimited,
    five_hour: normalizeWindow(quota.five_hour),
    one_week: normalizeWindow(quota.one_week),
  };

  return toCliQuotaSummary(account);
}

function computeRemainingPercent(usedPercent: number | undefined): number | null {
  if (typeof usedPercent !== "number") {
    return null;
  }

  return Math.max(0, 100 - usedPercent);
}

function roundScore(value: number): number {
  return Number(value.toFixed(2));
}

function resolveFiveHourWindowsPerWeek(planType: string | null): number {
  if (!planType) {
    return AUTO_SWITCH_SCORING.defaultFiveHourWindowsPerWeek;
  }

  return (
    AUTO_SWITCH_SCORING.fiveHourWindowsPerWeekByPlan[
      planType as keyof typeof AUTO_SWITCH_SCORING.fiveHourWindowsPerWeekByPlan
    ] ?? AUTO_SWITCH_SCORING.defaultFiveHourWindowsPerWeek
  );
}

function convertFiveHourPercentToWeeklyEquivalent(
  fiveHourPercent: number | null,
  fiveHourWindowsPerWeek: number,
): number | null {
  if (fiveHourPercent === null) {
    return null;
  }

  return roundScore(fiveHourPercent / fiveHourWindowsPerWeek);
}

function computeProjectedRemainingPercent(
  fetchedAt: string | null,
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): number | null {
  if (!window || typeof window.used_percent !== "number") {
    return null;
  }

  const remaining = computeRemainingPercent(window.used_percent);
  if (remaining === null) {
    return null;
  }

  if (!fetchedAt || !window.reset_at) {
    return remaining;
  }

  const fetchedAtMs = Date.parse(fetchedAt);
  const resetAtMs = Date.parse(window.reset_at);
  if (Number.isNaN(fetchedAtMs) || Number.isNaN(resetAtMs)) {
    return remaining;
  }

  const horizonSeconds = AUTO_SWITCH_PROJECTION_HORIZON_SECONDS;
  const timeUntilResetSeconds = Math.max(0, (resetAtMs - fetchedAtMs) / 1000);
  if (timeUntilResetSeconds >= horizonSeconds) {
    return remaining;
  }

  const beforeResetSeconds = Math.min(horizonSeconds, timeUntilResetSeconds);
  const afterResetSeconds = horizonSeconds - beforeResetSeconds;
  return roundScore((remaining * beforeResetSeconds + 100 * afterResetSeconds) / horizonSeconds);
}

function compareNullableNumberDescending(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return right - left;
}

function resolveBottleneckScore(left: number | null, right: number | null): number | null {
  if (left !== null && right !== null) {
    return Math.min(left, right);
  }

  return left ?? right;
}

function toAutoSwitchCandidate(account: AccountQuotaSummary): AutoSwitchCandidate | null {
  if (account.status !== "ok") {
    return null;
  }

  const fiveHourWindowsPerWeek = resolveFiveHourWindowsPerWeek(account.plan_type);
  const remain5h = computeRemainingPercent(account.five_hour?.used_percent);
  const remain1w = computeRemainingPercent(account.one_week?.used_percent);
  if (remain5h === null && remain1w === null) {
    return null;
  }

  const remain5hEq1w = convertFiveHourPercentToWeeklyEquivalent(remain5h, fiveHourWindowsPerWeek);
  const projected5hScore = computeProjectedRemainingPercent(account.fetched_at, account.five_hour);
  const projected5hEq1wScore = convertFiveHourPercentToWeeklyEquivalent(
    projected5hScore,
    fiveHourWindowsPerWeek,
  );
  const projected1wScore = computeProjectedRemainingPercent(account.fetched_at, account.one_week);
  const currentScore = resolveBottleneckScore(remain5hEq1w, remain1w);
  const effectiveScore = resolveBottleneckScore(projected5hEq1wScore, projected1wScore);

  if (currentScore === null || effectiveScore === null) {
    return null;
  }

  return {
    name: account.name,
    account_id: account.account_id,
    identity: account.identity,
    plan_type: account.plan_type,
    available: computeAvailability(account),
    refresh_status: "ok",
    current_score: currentScore,
    score_1h: effectiveScore,
    projected_5h_1h: projected5hScore,
    projected_5h_in_1w_units_1h: projected5hEq1wScore,
    projected_1w_1h: projected1wScore,
    remain_5h: remain5h,
    remain_5h_in_1w_units: remain5hEq1w,
    remain_1w: remain1w,
    five_hour_windows_per_week: fiveHourWindowsPerWeek,
    five_hour_used: account.five_hour?.used_percent ?? null,
    one_week_used: account.one_week?.used_percent ?? null,
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

export function rankAutoSwitchCandidates(accounts: AccountQuotaSummary[]): AutoSwitchCandidate[] {
  return accounts
    .map(toAutoSwitchCandidate)
    .filter((candidate): candidate is AutoSwitchCandidate => candidate !== null)
    .sort((left, right) => {
      const currentScoreGap = Math.abs(right.current_score - left.current_score);
      if (currentScoreGap > AUTO_SWITCH_CURRENT_SCORE_TIEBREAK_DELTA) {
        return right.current_score - left.current_score;
      }
      if (right.score_1h !== left.score_1h) {
        return right.score_1h - left.score_1h;
      }
      if (right.current_score !== left.current_score) {
        return right.current_score - left.current_score;
      }
      const projected5hOrder = compareNullableNumberDescending(
        left.projected_5h_in_1w_units_1h,
        right.projected_5h_in_1w_units_1h,
      );
      if (projected5hOrder !== 0) {
        return projected5hOrder;
      }
      const projected1wOrder = compareNullableNumberDescending(
        left.projected_1w_1h,
        right.projected_1w_1h,
      );
      if (projected1wOrder !== 0) {
        return projected1wOrder;
      }
      const remain5hOrder = compareNullableNumberDescending(
        left.remain_5h_in_1w_units,
        right.remain_5h_in_1w_units,
      );
      if (remain5hOrder !== 0) {
        return remain5hOrder;
      }
      const remain1wOrder = compareNullableNumberDescending(
        left.remain_1w,
        right.remain_1w,
      );
      if (remain1wOrder !== 0) {
        return remain1wOrder;
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

function formatRemainingPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

function formatRawScore(value: number | null): string {
  return value === null ? "-" : String(value);
}

function normalizeDisplayedScore(rawScore: number | null, fiveHourWindowsPerWeek: number): number | null {
  if (rawScore === null) {
    return null;
  }

  return roundScore(Math.min(100, rawScore * fiveHourWindowsPerWeek));
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
    `Current score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.current_score, candidate.five_hour_windows_per_week))}`,
    `1H score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.score_1h, candidate.five_hour_windows_per_week))}`,
    `5H remaining: ${formatRemainingPercent(candidate.remain_5h)}`,
    `5H remaining (1W units): ${formatRawScore(candidate.remain_5h_in_1w_units)}`,
    `1W remaining: ${formatRemainingPercent(candidate.remain_1w)}`,
    `5H 1H projected score: ${formatRemainingPercent(candidate.projected_5h_1h)}`,
    `5H 1H projected score (1W units): ${formatRawScore(candidate.projected_5h_in_1w_units_1h)}`,
    `1W 1H projected score: ${formatRemainingPercent(candidate.projected_1w_1h)}`,
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
    `Current score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.current_score, candidate.five_hour_windows_per_week))}`,
    `1H score: ${formatRemainingPercent(normalizeDisplayedScore(candidate.score_1h, candidate.five_hour_windows_per_week))}`,
    `5H remaining: ${formatRemainingPercent(candidate.remain_5h)}`,
    `5H remaining (1W units): ${formatRawScore(candidate.remain_5h_in_1w_units)}`,
    `1W remaining: ${formatRemainingPercent(candidate.remain_1w)}`,
    `5H 1H projected score: ${formatRemainingPercent(candidate.projected_5h_1h)}`,
    `5H 1H projected score (1W units): ${formatRawScore(candidate.projected_5h_in_1w_units_1h)}`,
    `1W 1H projected score: ${formatRemainingPercent(candidate.projected_1w_1h)}`,
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
  options: { verbose?: boolean } = {},
): string {
  if (accounts.length === 0) {
    const lines = [describeCurrentListStatus(currentStatus), "No saved accounts."];
    for (const warning of warnings) {
      lines.push(`Warning: ${warning}`);
    }

    return lines.join("\n");
  }

  const currentAccounts = new Set(currentStatus.matched_accounts);
  const autoSwitchCandidates = new Map(
    rankAutoSwitchCandidates(accounts).map((candidate) => [candidate.name, candidate] as const),
  );
  const rows = accounts.map((account) => {
    const candidate = autoSwitchCandidates.get(account.name);
    const row: Record<string, string> = {
      name: `${currentAccounts.has(account.name) ? "*" : " "} ${account.name}`,
      account_id: maskAccountId(account.identity),
      plan_type: account.plan_type ?? "-",
      available: computeAvailability(account) ?? "-",
      score: candidate
        ? formatRemainingPercent(
            normalizeDisplayedScore(candidate.current_score, candidate.five_hour_windows_per_week),
          )
        : "-",
      five_hour: formatUsagePercent(account.five_hour),
      five_hour_reset: formatResetAt(account.five_hour),
      one_week: formatUsagePercent(account.one_week),
      one_week_reset: formatResetAt(account.one_week),
      refresh_status: account.status,
    };

    if (options.verbose) {
      row.projected_5h_in_1w_units_1h = candidate
        ? formatRawScore(candidate.projected_5h_in_1w_units_1h)
        : "-";
      row.score_1h = candidate
        ? formatRemainingPercent(
            normalizeDisplayedScore(candidate.score_1h, candidate.five_hour_windows_per_week),
          )
        : "-";
      row.projected_1w_1h = candidate ? formatRemainingPercent(candidate.projected_1w_1h) : "-";
      row.five_hour_windows_per_week = candidate ? String(candidate.five_hour_windows_per_week) : "-";
    }

    return row;
  });

  const columns = [
    { key: "name", label: "  NAME" },
    { key: "account_id", label: "IDENTITY" },
    { key: "plan_type", label: "PLAN TYPE" },
    { key: "available", label: "AVAILABLE" },
    { key: "score", label: "CURRENT SCORE" },
    { key: "five_hour", label: "5H USED" },
    { key: "five_hour_reset", label: "5H RESET AT" },
    { key: "one_week", label: "1W USED" },
    { key: "one_week_reset", label: "1W RESET AT" },
    { key: "refresh_status", label: "REFRESH STATUS" },
  ];

  if (options.verbose) {
    columns.splice(
      5,
      0,
      { key: "score_1h", label: "1H SCORE" },
      { key: "projected_5h_in_1w_units_1h", label: "5H->1W 1H RAW" },
      { key: "projected_1w_1h", label: "1W 1H" },
      { key: "five_hour_windows_per_week", label: "1W:5H" },
    );
  }

  const table = formatTable(rows, columns);

  const lines = [describeCurrentListStatus(currentStatus), "Refreshed quotas:", table];
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

function describeQuotaRefresh(result: {
  successes: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
}, currentStatus: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];

  if (result.successes.length > 0) {
    lines.push(describeQuotaAccounts(result.successes, currentStatus, [], options));
  } else {
    lines.push(describeQuotaAccounts([], currentStatus, [], options));
  }

  for (const failure of result.failures) {
    lines.push(`Failure: ${failure.name}: ${failure.error}`);
  }

  if (lines.length === 0) {
    lines.push(describeQuotaAccounts([], currentStatus, [], options));
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
  const watchProcessManager =
    options.watchProcessManager ?? createWatchProcessManager(store.paths.codexTeamDir);
  const interruptSignal = options.interruptSignal;
  const managedDesktopWaitStatusDelayMs =
    options.managedDesktopWaitStatusDelayMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS;
  const managedDesktopWaitStatusIntervalMs =
    options.managedDesktopWaitStatusIntervalMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS;
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
        if (parsed.flags.has("--accounts")) {
          if (parsed.positionals.length > 0) {
            throw new Error("Usage: codexm completion --accounts");
          }

          const accountNames = await listCompletionAccountNames(store);
          if (accountNames.length > 0) {
            streams.stdout.write(`${accountNames.join("\n")}\n`);
          }
          return 0;
        }

        const shell = parsed.positionals[0] ?? null;
        if (parsed.positionals.length !== 1 || (shell !== "zsh" && shell !== "bash")) {
          throw new Error("Usage: codexm completion <zsh|bash>");
        }

        streams.stdout.write(shell === "zsh" ? buildCompletionZshScript() : buildCompletionBashScript());
        return 0;
      }

      case "current": {
        const refresh = parsed.flags.has("--refresh");
        const result = await store.getCurrentStatus();
        let quota: ReturnType<typeof toCliQuotaSummary> | null = null;
        let usageUnavailableReason: string | null = null;
        let usageSourceLabel: string | null = null;

        if (!refresh && result.exists && result.matched_accounts.length === 1) {
          quota = await tryReadManagedCurrentQuota(desktopLauncher, debugLog);
          if (quota) {
            usageSourceLabel = "live";
          }
        }

        if (refresh) {
          if (!result.exists) {
            usageUnavailableReason = "unavailable (current auth is missing)";
          } else if (result.matched_accounts.length === 0) {
            usageUnavailableReason = "unavailable (current auth is unmanaged)";
          } else if (result.matched_accounts.length > 1) {
            usageUnavailableReason = "unavailable (current auth matches multiple managed accounts)";
          } else {
            const currentName = result.matched_accounts[0];
            quota = await tryReadManagedCurrentQuota(desktopLauncher, debugLog);
            if (quota) {
              usageSourceLabel = "refreshed via mcp";
            } else {
              const quotaResult = await store.refreshQuotaForAccount(currentName);
              const quotaList = await store.listQuotaSummaries();
              const matched =
                quotaList.accounts.find((account) => account.name === quotaResult.account.name) ??
                null;
              quota = matched ? toCliQuotaSummary(matched) : null;
              if (quota) {
                usageSourceLabel = "refreshed via api";
              }
            }
          }
        }

        debugLog(
          `current: exists=${result.exists} managed=${result.managed} matched_accounts=${result.matched_accounts.length} auth_mode=${result.auth_mode ?? "null"} refresh=${refresh} quota_refreshed=${quota !== null} quota_source=${usageSourceLabel ?? "none"}`,
        );
        if (json) {
          writeJson(
            streams.stdout,
            refresh || quota
              ? {
                  ...result,
                  quota,
                }
              : result,
          );
        } else {
          streams.stdout.write(
            `${describeCurrentStatus(
              result,
              refresh
                ? {
                    quota,
                    unavailableReason: usageUnavailableReason,
                    sourceLabel: usageSourceLabel ?? undefined,
                  }
                : quota
                  ? {
                      quota,
                      unavailableReason: usageUnavailableReason,
                      sourceLabel: usageSourceLabel ?? undefined,
                    }
                  : undefined,
            )}\n`,
          );
        }
        return 0;
      }

      case "list": {
        const targetName = parsed.positionals[0];
        const verbose = parsed.flags.has("--verbose");
        const result = await store.refreshAllQuotas(targetName);
        const current = await store.getCurrentStatus();
        const currentAccounts = new Set(current.matched_accounts);
        debugLog(
          `list: target=${targetName ?? "all"} successes=${result.successes.length} failures=${result.failures.length} current_matches=${current.matched_accounts.length}`,
        );
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
          streams.stdout.write(`${describeQuotaRefresh(result, current, { verbose })}\n`);
        }
        return result.failures.length === 0 ? 0 : 1;
      }

      case "save": {
        const name = parsed.positionals[0];
        if (!name) {
          throw new Error("Usage: codexm save <name> [--force]");
        }

        const account = await store.saveCurrentAccount(name, parsed.flags.has("--force"));
        debugLog(
          `save: name=${account.name} auth_mode=${account.auth_mode} identity=${maskAccountId(account.identity)}`,
        );
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
        debugLog(
          `update: name=${result.account.name} quota=${quota?.refresh_status ?? "unknown"} warnings=${warnings.length}`,
        );

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

        if (!(await desktopLauncher.isManagedDesktopRunning())) {
          throw new Error("No codexm-managed Codex Desktop session is running.");
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
          onQuotaSignal: async (quotaSignal: ManagedQuotaSignal) => {
            debugLog(
              `watch: quota signal matched reason=${quotaSignal.reason} requestId=${quotaSignal.requestId}`,
            );

            const quota = await tryReadManagedCurrentQuota(
              desktopLauncher,
              debugLog,
              quotaSignal.quota,
            );
            const quotaUpdateLine = describeWatchQuotaEvent(currentWatchAccountLabel, quota);
            if (quotaUpdateLine !== lastQuotaUpdateLine) {
              streams.stdout.write(`${formatWatchLogLine(quotaUpdateLine)}\n`);
              lastQuotaUpdateLine = quotaUpdateLine;
            } else {
              debugLog(`watch: quota output unchanged for requestId=${quotaSignal.requestId}`);
            }
            if (!autoSwitch) {
              return;
            }

            if (!quotaSignal.shouldAutoSwitch) {
              debugLog(
                `watch: skipping auto switch for requestId=${quotaSignal.requestId} because the event is informational only`,
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
                `watch: skipped auto switch for requestId=${quotaSignal.requestId} because another switch is already in progress`,
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
          },
        });

        return watchExitCode;
      }

      case "remove": {
        const name = parsed.positionals[0];
        if (!name) {
          throw new Error("Usage: codexm remove <name> [--yes]");
        }

        const confirmed =
          parsed.flags.has("--yes") || (await confirmRemoval(name, streams));
        debugLog(`remove: target=${name} confirmed=${confirmed}`);
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
        debugLog(`rename: from=${oldName} to=${newName} identity=${maskAccountId(account.identity)}`);
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
