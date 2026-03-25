import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from "node:process";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import packageJson from "../package.json";

import { maskAccountId } from "./auth-snapshot.js";
import {
  AccountStore,
  type AccountQuotaSummary,
  type DoctorReport,
  createAccountStore,
} from "./account-store.js";

dayjs.extend(utc);
dayjs.extend(timezone);

interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

interface RunCliOptions extends Partial<CliStreams> {
  store?: AccountStore;
}

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Set<string>;
}

interface AutoSwitchCandidate {
  name: string;
  account_id: string;
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

function printHelp(stream: NodeJS.WriteStream): void {
  stream.write(`codexm - manage multiple Codex ChatGPT auth snapshots

Usage:
  codexm --version
  codexm --help
  codexm current [--json]
  codexm list [name] [--json]
  codexm save <name> [--force] [--json]
  codexm update [--json]
  codexm quota refresh [name] [--json]
  codexm switch <name> [--json]
  codexm switch --auto [--dry-run] [--json]
  codexm remove <name> [--yes] [--json]
  codexm rename <old> <new> [--json]
  codexm doctor [--json]

Account names must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.
`);
}

function describeCurrentStatus(status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>): string {
  const lines: string[] = [];

  if (!status.exists) {
    lines.push("Current auth: missing");
  } else {
    lines.push("Current auth: present");
    lines.push(`Auth mode: ${status.auth_mode}`);
    lines.push(`Identity: ${maskAccountId(status.account_id ?? "")}`);
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

function describeDoctor(report: DoctorReport): string {
  const lines = [
    report.healthy ? "Doctor checks passed." : "Doctor checks found issues.",
    `Saved accounts: ${report.account_count}`,
    `Current auth present: ${report.current_auth_present ? "yes" : "no"}`,
  ];

  for (const issue of report.issues) {
    lines.push(`Issue: ${issue}`);
  }

  for (const warning of report.warnings) {
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
      ? `Best account: "${candidate.name}" (${maskAccountId(candidate.account_id)}).`
      : `Auto-switched to "${candidate.name}" (${maskAccountId(candidate.account_id)}).`,
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
    `Current account "${candidate.name}" (${maskAccountId(candidate.account_id)}) is already the best available account.`,
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
  warnings: string[],
): string {
  if (accounts.length === 0) {
    return warnings.length === 0
      ? "No saved accounts."
      : warnings.map((warning) => `Warning: ${warning}`).join("\n");
  }

  const table = formatTable(
    accounts.map((account) => ({
      name: account.name,
      account_id: maskAccountId(account.account_id),
      plan_type: account.plan_type ?? "-",
      available: computeAvailability(account) ?? "-",
      five_hour: formatUsagePercent(account.five_hour),
      five_hour_reset: formatResetAt(account.five_hour),
      one_week: formatUsagePercent(account.one_week),
      one_week_reset: formatResetAt(account.one_week),
      refresh_status: account.status,
    })),
    [
      { key: "name", label: "NAME" },
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

  const lines = [table];
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

function describeQuotaRefresh(result: {
  successes: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
}): string {
  const lines: string[] = [];

  if (result.successes.length > 0) {
    lines.push("Refreshed quotas:");
    lines.push(describeQuotaAccounts(result.successes, []));
  }

  for (const failure of result.failures) {
    lines.push(`Failure: ${failure.name}: ${failure.error}`);
  }

  if (lines.length === 0) {
    lines.push("No accounts were refreshed.");
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
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("--json");

  try {
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
        if (json) {
          writeJson(streams.stdout, toCliQuotaRefreshResult(result));
        } else {
          streams.stdout.write(`${describeQuotaRefresh(result)}\n`);
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
            auth_mode: account.auth_mode,
          },
        };

        if (json) {
          writeJson(streams.stdout, payload);
        } else {
          streams.stdout.write(
            `Saved account "${account.name}" (${maskAccountId(account.account_id)}).\n`,
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
            auth_mode: result.account.auth_mode,
          },
          quota,
          warnings,
        };

        if (json) {
          writeJson(streams.stdout, payload);
        } else {
          streams.stdout.write(
            `Updated managed account "${result.account.name}" (${maskAccountId(result.account.account_id)}).\n`,
          );
          for (const warning of warnings) {
            streams.stdout.write(`Warning: ${warning}\n`);
          }
        }
        return 0;
      }

      case "quota": {
        const quotaCommand = parsed.positionals[0];

        if (quotaCommand === "refresh") {
          const targetName = parsed.positionals[1];
          const result = await store.refreshAllQuotas(targetName);
          if (json) {
            writeJson(streams.stdout, toCliQuotaRefreshResult(result));
          } else {
            streams.stdout.write(`${describeQuotaRefresh(result)}\n`);
          }
          return result.failures.length === 0 ? 0 : 1;
        }

        throw new Error("Usage: codexm quota refresh [name] [--json]");
      }

      case "switch": {
        const auto = parsed.flags.has("--auto");
        const dryRun = parsed.flags.has("--dry-run");
        const name = parsed.positionals[0];

        if (dryRun && !auto) {
          throw new Error("Usage: codexm switch --auto [--dry-run] [--json]");
        }

        if (auto) {
          if (name) {
            throw new Error("Usage: codexm switch --auto [--dry-run] [--json]");
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

          const payload = {
            ok: true,
            action: "switch",
            mode: "auto",
            account: {
              name: result.account.name,
              account_id: result.account.account_id,
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
          throw new Error("Usage: codexm switch <name>");
        }

        const result = await store.switchAccount(name);
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
            `Switched to "${result.account.name}" (${maskAccountId(result.account.account_id)}).\n`,
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
              auth_mode: account.auth_mode,
            },
          });
        } else {
          streams.stdout.write(`Renamed "${oldName}" to "${newName}".\n`);
        }
        return 0;
      }

      case "doctor": {
        const report = await store.doctor();
        if (json) {
          writeJson(streams.stdout, report);
        } else {
          streams.stdout.write(`${describeDoctor(report)}\n`);
        }
        return report.healthy ? 0 : 1;
      }

      default:
        throw new Error(`Unknown command "${parsed.command}".`);
    }
  } catch (error) {
    const message = (error as Error).message;
    if (json) {
      writeJson(streams.stderr, { ok: false, error: message });
    } else {
      streams.stderr.write(`Error: ${message}\n`);
    }
    return 1;
  }
}
