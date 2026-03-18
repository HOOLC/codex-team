#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from "node:process";

import { maskAccountId } from "./auth-snapshot.js";
import { AccountStore, type DoctorReport, type ManagedAccount, createAccountStore } from "./account-store.js";

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
  codexm current [--json]
  codexm list [--json]
  codexm save <name> [--force] [--json]
  codexm switch <name> [--json]
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
    lines.push(`Account ID: ${maskAccountId(status.account_id ?? "")}`);
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

function describeAccounts(accounts: ManagedAccount[], warnings: string[]): string {
  if (accounts.length === 0) {
    return warnings.length === 0 ? "No saved accounts." : warnings.map((warning) => `Warning: ${warning}`).join("\n");
  }

  const table = formatTable(
    accounts.map((account) => ({
      name: account.name,
      account_id: maskAccountId(account.account_id),
      auth_mode: account.auth_mode,
      saved: account.created_at,
      switched: account.last_switched_at ?? "-",
      flags: account.duplicateAccountId ? "duplicate-account-id" : "-",
    })),
    [
      { key: "name", label: "NAME" },
      { key: "account_id", label: "ACCOUNT ID" },
      { key: "auth_mode", label: "AUTH MODE" },
      { key: "saved", label: "SAVED AT" },
      { key: "switched", label: "LAST SWITCHED" },
      { key: "flags", label: "FLAGS" },
    ],
  );

  const lines = [table];
  for (const warning of warnings) {
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

async function confirmRemoval(
  name: string,
  streams: CliStreams,
): Promise<boolean> {
  if (!streams.stdin.isTTY) {
    throw new Error(`Refusing to remove "${name}" without --yes in a non-interactive terminal.`);
  }

  streams.stdout.write(`Remove saved account "${name}"? [y/N] `);

  return await new Promise<boolean>((resolve) => {
    const onData = (buffer: Buffer) => {
      const answer = buffer.toString("utf8").trim().toLowerCase();
      streams.stdin.off("data", onData);
      streams.stdout.write("\n");
      resolve(answer === "y" || answer === "yes");
    };

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
        return result.warnings.length > 0 ? 0 : 0;
      }

      case "list": {
        const result = await store.listAccounts();
        if (json) {
          writeJson(streams.stdout, result);
        } else {
          streams.stdout.write(`${describeAccounts(result.accounts, result.warnings)}\n`);
        }
        return 0;
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

      case "switch": {
        const name = parsed.positionals[0];
        if (!name) {
          throw new Error("Usage: codexm switch <name>");
        }

        const result = await store.switchAccount(name);
        const payload = {
          ok: true,
          action: "switch",
          account: {
            name: result.account.name,
            account_id: result.account.account_id,
            auth_mode: result.account.auth_mode,
          },
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

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
