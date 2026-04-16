import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import packageJson from "../package.json";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import { maskAccountId } from "../src/auth-snapshot.js";
import { parseArgs, validateParsedArgs } from "../src/cli/args.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  textResponse,
  writeCurrentApiKeyAuth,
  writeCurrentAuth,
  writeCurrentConfig,
} from "./test-helpers.js";
import {
  captureWritable,
  createDesktopLauncherStub,
} from "./cli-fixtures.js";

dayjs.extend(utc);
dayjs.extend(timezone);

async function seedWatchHistory(homeDir: string, accountName = "quota-main"): Promise<void> {
  await mkdir(join(homeDir, ".codex-team"), { recursive: true });
  await writeFile(
    join(homeDir, ".codex-team", "watch-quota-history.jsonl"),
    [
      JSON.stringify({
        recorded_at: "2026-04-10T10:00:00.000Z",
        account_name: accountName,
        account_id: "acct-c",
        identity: "acct-c:user-c",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 10, window_seconds: 18_000, reset_at: "2026-04-10T14:00:00.000Z" },
        one_week: { used_percent: 3, window_seconds: 604_800, reset_at: "2026-04-16T10:00:00.000Z" },
        source: "watch",
      }),
      JSON.stringify({
        recorded_at: "2026-04-10T10:30:00.000Z",
        account_name: accountName,
        account_id: "acct-c",
        identity: "acct-c:user-c",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 20, window_seconds: 18_000, reset_at: "2026-04-10T14:00:00.000Z" },
        one_week: { used_percent: 6, window_seconds: 604_800, reset_at: "2026-04-16T10:00:00.000Z" },
        source: "watch",
      }),
    ].join("\n") + "\n",
  );
}

async function seedRecentRatioWatchHistory(homeDir: string, accountName = "plus-main"): Promise<void> {
  const now = Date.now();
  const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();

  await mkdir(join(homeDir, ".codex-team"), { recursive: true });
  await writeFile(
    join(homeDir, ".codex-team", "watch-quota-history.jsonl"),
    [
      JSON.stringify({
        recorded_at: iso(-180),
        account_name: accountName,
        account_id: "acct-ratio",
        identity: "acct-ratio:user-ratio",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 10, window_seconds: 18_000, reset_at: iso(120) },
        one_week: { used_percent: 10, window_seconds: 604_800, reset_at: iso(7 * 24 * 60) },
        source: "watch",
      }),
      JSON.stringify({
        recorded_at: iso(-160),
        account_name: accountName,
        account_id: "acct-ratio",
        identity: "acct-ratio:user-ratio",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 16, window_seconds: 18_000, reset_at: iso(121) },
        one_week: { used_percent: 11, window_seconds: 604_800, reset_at: iso(7 * 24 * 60 + 1) },
        source: "watch",
      }),
      JSON.stringify({
        recorded_at: iso(-120),
        account_name: accountName,
        account_id: "acct-ratio",
        identity: "acct-ratio:user-ratio",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 0, window_seconds: 18_000, reset_at: iso(420) },
        one_week: { used_percent: 11, window_seconds: 604_800, reset_at: iso(7 * 24 * 60 + 2) },
        source: "watch",
      }),
      JSON.stringify({
        recorded_at: iso(-100),
        account_name: accountName,
        account_id: "acct-ratio",
        identity: "acct-ratio:user-ratio",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 7, window_seconds: 18_000, reset_at: iso(421) },
        one_week: { used_percent: 12, window_seconds: 604_800, reset_at: iso(7 * 24 * 60 + 3) },
        source: "watch",
      }),
      JSON.stringify({
        recorded_at: iso(-60),
        account_name: accountName,
        account_id: "acct-ratio",
        identity: "acct-ratio:user-ratio",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 0, window_seconds: 18_000, reset_at: iso(720) },
        one_week: { used_percent: 12, window_seconds: 604_800, reset_at: iso(7 * 24 * 60 + 4) },
        source: "watch",
      }),
      JSON.stringify({
        recorded_at: iso(-40),
        account_name: accountName,
        account_id: "acct-ratio",
        identity: "acct-ratio:user-ratio",
        plan_type: "plus",
        available: "available",
        five_hour: { used_percent: 6, window_seconds: 18_000, reset_at: iso(721) },
        one_week: { used_percent: 13, window_seconds: 604_800, reset_at: iso(7 * 24 * 60 + 5) },
        source: "watch",
      }),
    ].join("\n") + "\n",
  );
}

function labelCenter(line: string, label: string, fromIndex = 0): number {
  const start = line.indexOf(label, fromIndex);
  expect(start).toBeGreaterThanOrEqual(0);
  return start + (label.length - 1) / 2;
}

function labelEnd(line: string, label: string, fromIndex = 0): number {
  const start = line.indexOf(label, fromIndex);
  const resolvedStart = start >= 0 ? start : line.lastIndexOf(label);
  expect(resolvedStart).toBeGreaterThanOrEqual(0);
  return resolvedStart + label.length - 1;
}

describe("CLI Read Commands", () => {
  test("prints version from --version", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["--version"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toBe(`${packageJson.version}\n`);
    expect(stderr.read()).toBe("");
  });

  test("includes version flag in help output", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const output = await (async () => {
      const exitCode = await runCli(["--help"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      return stdout.read();
    })();

    expect(output).toContain("codexm --version");
    expect(output).toContain("codexm add <name> [--device-auth|--with-api-key] [--force] [--json]");
    expect(output).toContain("codexm doctor [--json]");
    expect(output).toContain("codexm launch [name] [--auto] [--watch] [--no-auto-switch] [--json]");
    expect(output).toContain("codexm watch [--no-auto-switch] [--detach] [--status] [--stop]");
    expect(output).toContain("codexm tui [query]");
    expect(output).toContain("codexm run [-- ...codexArgs]");
    expect(output).toContain("codexm completion <zsh|bash>");
    expect(output).toContain("Global flags: --help, --version, --debug");
    expect(output).toContain("Command aliases: ls=list");
    expect(output).toContain(
      "Flag aliases: -a=--auto, -d=--debug, -f=--force, -j=--json, -n=--dry-run, -v=--verbose, -y=--yes",
    );
    expect(stderr.read()).toBe("");
  });

  test("tui rejects non-interactive terminals", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["tui"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub(),
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain(
      'Error: codexm tui requires an interactive terminal. Use "codexm list" or "codexm list --json" instead.\n',
    );
  });

  test("run accepts passthrough codex args and delegates to the runner", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-run");
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let runnerOptions: { codexArgs: string[]; accountId?: string | null } | null = null;

      const exitCode = await runCli(["run", "--", "--model", "o3"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        runCodexCli: async (options) => {
          runnerOptions = {
            codexArgs: options.codexArgs,
            accountId: options.accountId,
          };
          return {
            exitCode: 7,
            restartCount: 0,
          };
        },
      });

      expect(exitCode).toBe(7);
      expect(runnerOptions).toEqual({
        codexArgs: ["--model", "o3"],
        accountId: "acct-run",
      });
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain("[codexm run] codex args: --model o3");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("prints a zsh completion script with dynamic account completion", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-completion-zsh");
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("plus-main");
      await writeCurrentAuth(homeDir, "acct-completion-zsh-team");
      await store.saveCurrentAccount("team.ops");

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["completion", "zsh"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      const script = stdout.read();
      expect(script).toContain("#compdef codexm");
      expect(script).toContain("add");
      expect(script).toContain("current");
      expect(script).toContain("doctor");
      expect(script).toContain("ls");
      expect(script).toContain("watch");
      expect(script).toContain("run");
      expect(script).toContain("completion");
      expect(script).toContain("--device-auth");
      expect(script).toContain("--no-auto-switch");
      expect(script).toContain("'--verbose:show expanded score inputs and diagnostics'");
      expect(script).toContain("'--debug:enable debug logging'");
      expect(script).toContain("'-j:print JSON output'");
      expect(script).not.toContain("'--debug[enable debug logging]'");
      expect(script).toContain("codexm completion --accounts");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("prints a bash completion script with dynamic account completion", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["completion", "bash"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      const script = stdout.read();
      expect(script).toContain("_codexm()");
      expect(script).toContain("COMPREPLY=");
      expect(script).toContain("codexm completion --accounts");
      expect(script).toContain("ls");
      expect(script).toContain("-j");
      expect(script).toContain("-v");
      expect(script).toContain("run");
      expect(script).toContain("--with-api-key");
      expect(script).toContain("--detach");
      expect(script).toContain("run");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("prints saved account names for hidden completion account queries", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-completion-accounts");
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("plus-main");
      await writeCurrentAuth(homeDir, "acct-completion-accounts-team");
      await store.saveCurrentAccount("team.ops");

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["completion", "--accounts"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stdout.read().trim().split("\n")).toEqual(["plus-main", "team.ops"]);
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("accepts --debug for existing commands and writes current debug output", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-debug-current");

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["current", "--debug"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readCurrentRuntimeAccountResult: async () => null,
          readCurrentRuntimeQuotaResult: async () => null,
        }),
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Current auth: present");
      expect(stderr.read()).toContain("[debug] current:");
      expect(stderr.read()).toContain("matched_accounts=0");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("parses codexm run passthrough args after -- without validating them as codexm flags", () => {
    const parsed = parseArgs(["run", "--", "--model", "o3"]);

    expect(parsed.command).toBe("run");
    expect(parsed.positionals).toEqual([]);
    expect(parsed.flags.size).toBe(0);
    expect(parsed.passthrough).toEqual(["--model", "o3"]);
    expect(() => validateParsedArgs(parsed)).not.toThrow();
  });

  test("normalizes common command and flag aliases before validation", () => {
    const parsed = parseArgs(["ls", "-j", "-v"]);

    expect(parsed.command).toBe("list");
    expect(parsed.positionals).toEqual([]);
    expect(parsed.flags).toEqual(new Set(["--json", "--verbose"]));
    expect(() => validateParsedArgs(parsed)).not.toThrow();
  });

  test("supports save and current in json mode", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli");

      const stdout = captureWritable();
      const stderr = captureWritable();

      const saveCode = await runCli(["save", "cli-main", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(saveCode).toBe(0);
      expect(JSON.parse(stdout.read()).account.name).toBe("cli-main");

      const currentStdout = captureWritable();
      const currentCode = await runCli(["current", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readCurrentRuntimeAccountResult: async () => null,
          readCurrentRuntimeQuotaResult: async () => null,
        }),
        stdout: currentStdout.stream,
        stderr: stderr.stream,
      });

      expect(currentCode).toBe(0);
      expect(JSON.parse(currentStdout.read())).toMatchObject({
        exists: true,
        managed: true,
        matched_accounts: ["cli-main"],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("current best-effort shows Desktop runtime usage when available", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-current-live");
      await runCli(["save", "current-live", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const exitCode = await runCli(["current"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "current-live@example.com",
            plan_type: "plus",
            requires_openai_auth: true,
          }),
          readManagedCurrentQuota: async () => ({
            plan_type: "plus",
            credits_balance: 11,
            unlimited: false,
            five_hour: {
              used_percent: 12,
              window_seconds: 18_000,
              reset_at: "2026-03-18T21:17:21.000Z",
            },
            one_week: {
              used_percent: 47,
              window_seconds: 604_800,
              reset_at: "2026-03-19T03:14:00.000Z",
            },
            fetched_at: "2026-04-08T13:28:00.000Z",
          }),
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("Source: managed Desktop runtime (mcp + auth.json)");
      expect(output).toContain("Managed account: current-live");
      expect(output).toContain("Usage: available | 5H 12% used | 1W 47% used | live Desktop runtime");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("doctor --json reports local, direct, and Desktop runtime checks", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-doctor");
      await runCli(["save", "doctor-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const exitCode = await runCli(["doctor", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readDirectRuntimeAccount: async () => ({
            auth_mode: "chatgpt",
            email: "doctor@example.com",
            plan_type: "plus",
            requires_openai_auth: true,
          }),
          readDirectRuntimeQuota: async () => ({
            plan_type: "plus",
            credits_balance: 11,
            unlimited: false,
            five_hour: {
              used_percent: 12,
              window_seconds: 18_000,
              reset_at: "2026-03-18T21:17:21.000Z",
            },
            one_week: {
              used_percent: 47,
              window_seconds: 604_800,
              reset_at: "2026-03-19T03:14:00.000Z",
            },
            fetched_at: "2026-04-08T13:28:00.000Z",
          }),
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "doctor@example.com",
            plan_type: "plus",
            requires_openai_auth: true,
          }),
          readManagedCurrentQuota: async () => ({
            plan_type: "plus",
            credits_balance: 11,
            unlimited: false,
            five_hour: {
              used_percent: 12,
              window_seconds: 18_000,
              reset_at: "2026-03-18T21:17:21.000Z",
            },
            one_week: {
              used_percent: 47,
              window_seconds: 604_800,
              reset_at: "2026-03-19T03:14:00.000Z",
            },
            fetched_at: "2026-04-08T13:28:00.000Z",
          }),
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        healthy: true,
        current_auth: {
          status: "ok",
          managed: true,
          matched_accounts: ["doctor-main"],
        },
        direct_runtime: {
          status: "ok",
          account: {
            auth_mode: "chatgpt",
            email: "doctor@example.com",
            plan_type: "plus",
          },
          quota: {
            available: "available",
          },
        },
        desktop_runtime: {
          status: "ok",
          differs_from_direct: false,
          differs_from_local: false,
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("doctor returns non-zero when the direct runtime check fails", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-doctor-fail");

      const stdout = captureWritable();
      const exitCode = await runCli(["doctor"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readDirectRuntimeAccount: async () => {
            throw new Error("401 Unauthorized");
          },
          readManagedCurrentAccount: async () => null,
          readManagedCurrentQuota: async () => null,
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toContain("Direct runtime: error | 401 Unauthorized");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("doctor warns when the managed Desktop runtime differs from local auth", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-cli-doctor-drift");

      const stdout = captureWritable();
      const exitCode = await runCli(["doctor"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readDirectRuntimeAccount: async () => ({
            auth_mode: "apikey",
            email: null,
            plan_type: null,
            requires_openai_auth: false,
          }),
          readDirectRuntimeQuota: async () => null,
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "desktop@example.com",
            plan_type: "plus",
            requires_openai_auth: true,
          }),
          readManagedCurrentQuota: async () => null,
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain(
        "Warning: Managed Desktop runtime auth differs from ~/.codex/auth.json.",
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("current --json reports desktop-runtime source when managed Desktop account is available", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-current-source");
      await runCli(["save", "current-source", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const exitCode = await runCli(["current", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "current-source@example.com",
            plan_type: "plus",
            requires_openai_auth: true,
          }),
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        exists: true,
        managed: true,
        matched_accounts: ["current-source"],
        source: "desktop-runtime",
        runtime_differs_from_local: false,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("current --json reports direct-runtime source when Desktop fallback is unavailable", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-current-direct-source");
      await runCli(["save", "current-direct-source", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const exitCode = await runCli(["current", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readCurrentRuntimeAccountResult: async () => ({
            snapshot: {
              auth_mode: "chatgpt",
              email: "direct-source@example.com",
              plan_type: "plus",
              requires_openai_auth: true,
            },
            source: "direct",
          }),
          readManagedCurrentAccount: async () => null,
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        exists: true,
        managed: true,
        matched_accounts: ["current-direct-source"],
        source: "direct-runtime",
        runtime_differs_from_local: false,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("current warns when managed Desktop auth differs from local auth.json", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-cli-current-drift");

      const stdout = captureWritable();
      const exitCode = await runCli(["current"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "drift@example.com",
            plan_type: "plus",
            requires_openai_auth: true,
          }),
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("Source: managed Desktop runtime (mcp + auth.json)");
      expect(output).toContain("Auth mode: chatgpt");
      expect(output).toContain("Warning: Managed Desktop auth differs from ~/.codex/auth.json.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("current --refresh shows a one-line usage summary for the current managed account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 12,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 47,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-current-refresh");
      await runCli(["save", "current-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const exitCode = await runCli(["current", "--refresh"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentQuota: async () => null,
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("Managed account: current-main");
      expect(output).toContain("Usage: available | 5H 12% used | 1W 47% used | refreshed via api");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("current --refresh prefers managed MCP quota over the usage API", async () => {
    const homeDir = await createTempHome();
    let fetchCalled = false;

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async () => {
          fetchCalled = true;
          return textResponse("unexpected", 500);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-current-refresh-mcp");
      await runCli(["save", "current-mcp", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const exitCode = await runCli(["current", "--refresh"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentQuota: async () => ({
            plan_type: "plus",
            credits_balance: 11,
            unlimited: false,
            five_hour: {
              used_percent: 9,
              window_seconds: 18_000,
              reset_at: "2026-03-18T21:17:21.000Z",
            },
            one_week: {
              used_percent: 31,
              window_seconds: 604_800,
              reset_at: "2026-03-19T03:14:00.000Z",
            },
            fetched_at: "2026-04-08T13:29:00.000Z",
          }),
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      expect(fetchCalled).toBe(false);
      expect(stdout.read()).toContain(
        "Usage: available | 5H 9% used | 1W 31% used | refreshed via Desktop runtime",
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("current --refresh --json includes refreshed quota data", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 15,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-current-refresh-json");
      await runCli(["save", "current-json", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const exitCode = await runCli(["current", "--refresh", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentQuota: async () => null,
        }),
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        exists: true,
        managed: true,
        matched_accounts: ["current-json"],
        quota: {
          available: "available",
          refresh_status: "ok",
          credits_balance: 11,
          five_hour: {
            used_percent: 15,
          },
          one_week: {
            used_percent: 45,
          },
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports current and list for apikey auth snapshots", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-cli-primary");
      await writeCurrentConfig(
        homeDir,
        `model_provider = "custom"

[model_providers.custom]
base_url = "https://proxy-cli.example/v1"
wire_api = "responses"
`,
      );

      const saveCode = await runCli(["save", "cli-key", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      expect(saveCode).toBe(0);

      const currentStdout = captureWritable();
      const currentCode = await runCli(["current", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentAccount: async () => null,
          readManagedCurrentQuota: async () => null,
        }),
        stdout: currentStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(currentCode).toBe(0);
      expect(JSON.parse(currentStdout.read())).toMatchObject({
        exists: true,
        auth_mode: "apikey",
        managed: true,
        matched_accounts: ["cli-key"],
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);
      expect(JSON.parse(listStdout.read())).toMatchObject({
        current: {
          exists: true,
          auth_mode: "apikey",
          managed: true,
          matched_accounts: ["cli-key"],
        },
        successes: [
          {
            name: "cli-key",
            refresh_status: "unsupported",
            available: null,
          },
        ],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports list as quota refresh in json mode", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 15,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota");
      await runCli(["save", "quota-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });
      expect(listCode).toBe(0);
      expect(JSON.parse(listStdout.read())).toMatchObject({
        current: {
          exists: true,
          managed: true,
          matched_accounts: ["quota-main"],
        },
        successes: [
          {
            name: "quota-main",
            is_current: true,
            available: "available",
            credits_balance: 11,
            refresh_status: "ok",
            five_hour: {
              used_percent: 15,
            },
            one_week: {
              used_percent: 45,
            },
          },
        ],
        failures: [],
      });

      const removedStdout = captureWritable();
      const removedStderr = captureWritable();
      const removedCode = await runCli(["lsit", "--json"], {
        store,
        stdout: removedStdout.stream,
        stderr: removedStderr.stream,
      });
      expect(removedCode).toBe(1);
      expect(JSON.parse(removedStderr.read())).toMatchObject({
        ok: false,
        error: 'Unknown command "lsit".',
        suggestion: "list",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("marks the current account in list text output while keeping the table aligned", async () => {
    const homeDir = await createTempHome();

    try {
      await seedWatchHistory(homeDir);
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: accountId === "acct-cli-quota-text-a" ? 15 : 25,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: accountId === "acct-cli-quota-text-a" ? 45 : 55,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota-text-a");
      await runCli(["save", "quota-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota-text-b");
      await runCli(["save", "quota-backup", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await runCli(["switch", "quota-main", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub(),
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await runCli(["list", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const output = listStdout.read();
      const lines = output.trimEnd().split("\n");
      const tableStartIndex = lines.findIndex((line) => line.includes("NAME"));
      const headerTopIndex =
        tableStartIndex > 0 && lines[tableStartIndex - 1]?.includes("USED")
          ? tableStartIndex - 1
          : tableStartIndex;
      const tableLines = lines.slice(headerTopIndex, headerTopIndex + 5);
      const currentRow = tableLines.find((line) => line.includes("quota-main"));

      expect(lines[0]).toBe("Current managed account: quota-main");
      expect(lines[1]).toBe("Accounts: 2/2 usable | blocked: 1W 0, 5H 0 | plus x2");
      expect(lines[2]).toBe("Available: bottleneck 0.24 | 5H->1W 0.24 | 1W 1 (plus 1W)");
      expect(output).not.toContain("CREDITS");
      expect(output).not.toContain("AVAILABLE");
      expect(output).toContain("ETA");
      expect(output).toContain("SCORE");
      expect(output).toContain("NEXT RESET");
      expect(output).toContain("* quota-main");
      expect(output).toContain("  quota-backup");
      expect(output).toContain("2.1h");
      expect(output).toContain(
        dayjs.utc("2026-03-18T21:17:21.000Z").tz(dayjs.tz.guess()).format("MM-DD HH:mm"),
      );
      expect(tableLines).toHaveLength(5);
      expect(currentRow).toBeDefined();
      expect(tableLines[1]?.indexOf("NAME")).toBe(currentRow?.indexOf("quota-main"));
      expect(tableLines[0]).toContain("USED");
      expect(tableLines[1]).toContain("5H");
      expect(tableLines[1]).toContain("1W");
      const usedCenter = labelCenter(tableLines[0] ?? "", "USED");
      const fiveHourCenter = labelCenter(tableLines[1] ?? "", "5H");
      const oneWeekCenter = labelCenter(tableLines[1] ?? "", "1W", (tableLines[1]?.indexOf("5H") ?? 0) + 1);
      expect(Math.abs(usedCenter - (fiveHourCenter + oneWeekCenter) / 2)).toBeLessThanOrEqual(1);

      const identityColumn = tableLines[1]?.indexOf("IDENTITY") ?? -1;
      const identityCell = currentRow?.slice(identityColumn, identityColumn + "IDENTITY".length).trim();
      expect(identityCell).toMatch(/^[^\s.]{3}\.\.[^\s.]{3}$/);
      expect(currentRow).toContain("15%");
      expect(currentRow).toContain("45%");
      expect(tableLines[1]?.indexOf("PLAN")).toBe(tableLines[4]?.indexOf("plus"));
      expect((tableLines[1]?.indexOf("SCORE") ?? -1)).toBeGreaterThan(
        tableLines[1]?.indexOf("PLAN") ?? -1,
      );
      expect((tableLines[1]?.indexOf("ETA") ?? -1)).toBeGreaterThan(
        tableLines[1]?.indexOf("SCORE") ?? -1,
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list text output follows current score ranking without pinning the current account", async () => {
    const homeDir = await createTempHome();

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          const primaryUsedPercent =
            accountId === "acct-cli-rank-alpha"
              ? 76
              : accountId === "acct-cli-rank-beta"
                ? 20
                : 40;
          const secondaryUsedPercent =
            accountId === "acct-cli-rank-alpha"
              ? 50
              : accountId === "acct-cli-rank-beta"
                ? 20
                : 30;
          const primaryResetAfterSeconds =
            accountId === "acct-cli-rank-alpha" ? 600 : 1_800;
          const primaryResetAt = nowSeconds + primaryResetAfterSeconds;
          const secondaryResetAt = nowSeconds + 86_400;

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: primaryUsedPercent,
                limit_window_seconds: 18_000,
                reset_after_seconds: primaryResetAfterSeconds,
                reset_at: primaryResetAt,
              },
              secondary_window: {
                used_percent: secondaryUsedPercent,
                limit_window_seconds: 604_800,
                reset_after_seconds: 86_400,
                reset_at: secondaryResetAt,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-rank-alpha");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-rank-beta");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-rank-gamma");
      await runCli(["save", "gamma", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const plainOutput = listStdout.read().replace(/\u001b\[[0-9;]*m/g, "");
      const lines = plainOutput.trimEnd().split("\n");
      const tableStartIndex = lines.findIndex((line) => line.includes("NAME"));
      const dataRows = lines.slice(tableStartIndex + 2, tableStartIndex + 5);

      expect(dataRows[0]).toContain("beta");
      expect(dataRows[1]).toContain("* gamma");
      expect(dataRows[2]).toContain("alpha");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list falls back to recent cached quota and warns when fast refresh fails", async () => {
    const homeDir = await createTempHome();
    let fetchAttempts = 0;

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async () => {
          fetchAttempts += 1;
          throw new TypeError("fetch failed");
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-cached-main");
      await runCli(["save", "cached-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-cached-backup");
      await runCli(["save", "cached-backup", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const seededStore = createAccountStore(homeDir, {
        fetchImpl: async (_input, init) => {
          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: accountId === "acct-cli-cached-main" ? 40 : 70,
                limit_window_seconds: 18_000,
                reset_after_seconds: 300,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: accountId === "acct-cli-cached-main" ? 30 : 45,
                limit_window_seconds: 604_800,
                reset_after_seconds: 4_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          });
        },
      });

      await seededStore.refreshAllQuotas();

      const stdout = captureWritable();
      const exitCode = await runCli(["list"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(fetchAttempts).toBe(2);
      expect(output).toContain("cached-main");
      expect(output).toContain("cached-backup");
      expect(output).toContain('Warning: cached-main using cached quota from');
      expect(output).toContain('Warning: cached-backup using cached quota from');
      expect(output).toContain("after refresh failed");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list text output uses distinct score and usage color thresholds", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
            const primaryUsedPercent =
              accountId === "acct-cli-color-weekly-blocked"
                ? 88
                : accountId === "acct-cli-color-healthy"
                ? 20
                : accountId === "acct-cli-color-full"
                ? 0
                : accountId === "acct-cli-color-five-hour-blocked"
                ? 100
                : accountId === "acct-cli-color-critical"
                  ? 92
                  : 85;
            const secondaryUsedPercent =
              accountId === "acct-cli-color-weekly-blocked"
                ? 100
                : accountId === "acct-cli-color-healthy"
                  ? 10
                : accountId === "acct-cli-color-full"
                  ? 0
                : accountId === "acct-cli-color-five-hour-blocked"
                  ? 88
                : accountId === "acct-cli-color-critical"
                  ? 59
                  : 25;
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: primaryUsedPercent,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 300,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: secondaryUsedPercent,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-color-low");
      await runCli(["save", "quota-low", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-color-critical");
      await runCli(["save", "quota-critical", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-color-healthy");
      await runCli(["save", "quota-healthy", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-color-full");
      await runCli(["save", "quota-full", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-color-five-hour-blocked");
      await runCli(["save", "quota-five-hour-blocked", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-color-weekly-blocked");
      await runCli(["save", "quota-weekly-blocked", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const output = listStdout.read();
      expect(output).toContain("\u001b[30m\u001b[41m* quota-weekly-blocked");
      expect(output).not.toContain("\u001b[30m\u001b[41m  quota-five-hour-blocked");
      expect(output).toContain("\u001b[1m\u001b[93m85%\u001b[0m");
      expect(output).toContain("\u001b[1m\u001b[93m15%\u001b[0m");
      expect(output).toContain("\u001b[1m\u001b[93m92%\u001b[0m");
      expect(output).toContain("\u001b[1m\u001b[93m8%\u001b[0m");
      expect(output).toContain("\u001b[1m\u001b[31m100%\u001b[0m");
      expect(output).toContain("\u001b[32m80%\u001b[0m");
      expect(output).toContain("\u001b[1m\u001b[32m100%\u001b[0m");
      expect(output).toContain("\u001b[1m\u001b[36m (5m)\u001b[0m");
      expect(output).not.toContain("\u001b[32m75%\u001b[0m");
      expect(output).not.toContain("\u001b[32m41%\u001b[0m");

      const plainOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
      const lines = plainOutput.trimEnd().split("\n");
      const tableStartIndex = lines.findIndex((line) => line.includes("NAME"));
      const headerTopIndex =
        tableStartIndex > 0 && lines[tableStartIndex - 1]?.includes("USED")
          ? tableStartIndex - 1
          : tableStartIndex;
      const tableLines = lines.slice(headerTopIndex, headerTopIndex + 9);
      const weeklyBlockedRow = tableLines.find((line) => line.includes("quota-weekly-blocked"));
      const fiveHourBlockedRow = tableLines.find((line) => line.includes("quota-five-hour-blocked"));
      const criticalRow = tableLines.find((line) => line.includes("quota-critical"));
      const healthyRow = tableLines.find((line) => line.includes("quota-healthy"));
      const fullRow = tableLines.find((line) => line.includes("quota-full"));
      const lowRow = tableLines.find((line) => line.includes("quota-low"));

      expect(weeklyBlockedRow).toBeDefined();
      expect(fiveHourBlockedRow).toBeDefined();
      expect(criticalRow).toBeDefined();
      expect(healthyRow).toBeDefined();
      expect(fullRow).toBeDefined();
      expect(lowRow).toBeDefined();
      const scoreColumn = tableLines[1]?.indexOf("SCORE") ?? -1;
      const used5hColumn = tableLines[1]?.indexOf("5H") ?? -1;
      const used1wColumn = tableLines[1]?.indexOf("1W") ?? -1;
      const nextResetColumn = tableLines[1]?.indexOf("NEXT RESET") ?? -1;
      const scoreEnds = [
        labelEnd(weeklyBlockedRow ?? "", "0%", scoreColumn),
        labelEnd(fiveHourBlockedRow ?? "", "0%", scoreColumn),
        labelEnd(criticalRow ?? "", "8%", scoreColumn),
        labelEnd(healthyRow ?? "", "80%", scoreColumn),
        labelEnd(fullRow ?? "", "100%", scoreColumn),
      ];
      expect(new Set(scoreEnds).size).toBe(1);

      const used5hEnds = [
        labelEnd(criticalRow ?? "", "92%", used5hColumn),
        labelEnd(lowRow ?? "", "85%", used5hColumn),
        labelEnd(healthyRow ?? "", "20%", used5hColumn),
        labelEnd(fullRow ?? "", "0%", used5hColumn),
      ];
      expect(new Set(used5hEnds).size).toBe(1);

      const used1wEnds = [
        labelEnd(healthyRow ?? "", "10%", used1wColumn),
        labelEnd(weeklyBlockedRow ?? "", "100%", used1wColumn),
      ];
      expect(new Set(used1wEnds).size).toBe(1);
      expect(lowRow?.includes("(5m)")).toBe(true);
      expect(lowRow?.indexOf("(5m)", nextResetColumn)).toBeGreaterThan(nextResetColumn);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list text output prefers the earliest bottleneck reset over a fixed 5h-first reset tie-break", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          const primaryResetAt =
            accountId === "acct-cli-bottleneck-weekly"
              ? 1_775_610_400
              : 1_775_599_600;
          const secondaryResetAt =
            accountId === "acct-cli-bottleneck-weekly"
              ? 1_775_596_800
              : 1_775_614_000;

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 7_200,
                reset_at: primaryResetAt,
              },
              secondary_window: {
                used_percent: 90,
                limit_window_seconds: 604_800,
                reset_after_seconds: 7_200,
                reset_at: secondaryResetAt,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-bottleneck-five-hour");
      await runCli(["save", "five-hour-bottleneck-later", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-bottleneck-weekly");
      await runCli(["save", "weekly-bottleneck-sooner", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const plainOutput = listStdout.read().replace(/\u001b\[[0-9;]*m/g, "");
      const lines = plainOutput.trimEnd().split("\n");
      const tableStartIndex = lines.findIndex((line) => line.includes("NAME"));
      const dataRows = lines.slice(tableStartIndex + 2, tableStartIndex + 4);

      expect(dataRows[0]).toContain("* weekly-bottleneck-sooner");
      expect(dataRows[1]).toContain("five-hour-bottleneck-later");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list text output prefers zero-score accounts that recover sooner over static 5h remain", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          const isWeeklyBlocked = accountId === "acct-cli-zero-score-weekly";

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: isWeeklyBlocked ? 20 : 100,
                limit_window_seconds: 18_000,
                reset_after_seconds: isWeeklyBlocked ? 7_200 : 1_200,
                reset_at: isWeeklyBlocked ? 1_775_610_400 : 1_775_588_800,
              },
              secondary_window: {
                used_percent: isWeeklyBlocked ? 100 : 50,
                limit_window_seconds: 604_800,
                reset_after_seconds: isWeeklyBlocked ? 14_400 : 86_400,
                reset_at: isWeeklyBlocked ? 1_775_617_600 : 1_775_671_200,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-zero-score-weekly");
      await runCli(["save", "weekly-blocked-later", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-zero-score-five-hour");
      await runCli(["save", "five-hour-blocked-sooner", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const plainOutput = listStdout.read().replace(/\u001b\[[0-9;]*m/g, "");
      const lines = plainOutput.trimEnd().split("\n");
      const tableStartIndex = lines.findIndex((line) => line.includes("NAME"));
      const dataRows = lines.slice(tableStartIndex + 2, tableStartIndex + 4);

      expect(dataRows[0]).toContain("five-hour-blocked-sooner");
      expect(dataRows[1]).toContain("weekly-blocked-later");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list text output uses recovery reset when multiple exhausted windows block the account", async () => {
    const homeDir = await createTempHome();

    try {
      const bothBlockedFiveHourResetAt = 1_775_588_800;
      const bothBlockedOneWeekResetAt = 1_775_617_600;
      const fiveHourOnlyResetAt = 1_775_599_600;

      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          const isBothBlocked = accountId === "acct-cli-zero-score-both-blocked";

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 100,
                limit_window_seconds: 18_000,
                reset_after_seconds: isBothBlocked ? 1_200 : 2_400,
                reset_at: isBothBlocked ? bothBlockedFiveHourResetAt : fiveHourOnlyResetAt,
              },
              secondary_window: {
                used_percent: isBothBlocked ? 100 : 50,
                limit_window_seconds: 604_800,
                reset_after_seconds: isBothBlocked ? 30_000 : 86_400,
                reset_at: isBothBlocked ? bothBlockedOneWeekResetAt : 1_775_671_200,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-zero-score-both-blocked");
      await runCli(["save", "both-blocked-later", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-zero-score-five-hour-recovery");
      await runCli(["save", "five-hour-only-sooner", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const plainOutput = listStdout.read().replace(/\u001b\[[0-9;]*m/g, "");
      const lines = plainOutput.trimEnd().split("\n");
      const tableStartIndex = lines.findIndex((line) => line.includes("NAME"));
      const tableLines = lines.slice(tableStartIndex, tableStartIndex + 4);
      const dataRows = tableLines.slice(2);
      const nextResetColumn = tableLines[0]?.indexOf("NEXT RESET") ?? -1;
      const bothBlockedRow = dataRows.find((line) => line.includes("both-blocked-later"));

      expect(dataRows[0]).toContain("five-hour-only-sooner");
      expect(dataRows[1]).toContain("both-blocked-later");
      expect(bothBlockedRow).toBeDefined();

      const expectedRecoveryReset = dayjs
        .unix(bothBlockedOneWeekResetAt)
        .tz(dayjs.tz.guess())
        .format("MM-DD HH:mm");
      expect(bothBlockedRow?.indexOf(expectedRecoveryReset, nextResetColumn)).toBe(nextResetColumn);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list --verbose includes auto-switch score breakdown columns", async () => {
    const homeDir = await createTempHome();

    try {
      await seedWatchHistory(homeDir, "quota-plus");
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
            return jsonResponse({
              plan_type: accountId === "acct-cli-verbose-team" ? "pro" : "plus",
              rate_limit: {
                primary_window: {
                  used_percent: accountId === "acct-cli-verbose-team" ? 40 : 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: accountId === "acct-cli-verbose-team" ? 600 : 300,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: accountId === "acct-cli-verbose-team" ? 35 : 30,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-verbose-plus");
      await runCli(["save", "quota-plus", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-verbose-team");
      await runCli(["save", "quota-team", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--verbose"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);
      const output = listStdout.read();
      expect(output).toContain("Accounts:");
      expect(output).toContain("Available: ");
      expect(output).toContain("ETA");
      expect(output).toContain("ETA 5H->1W");
      expect(output).toContain("ETA 1W");
      expect(output).toContain("RATE 1W UNITS");
      expect(output).toContain("5H REMAIN->1W");
      expect(output).toContain("SCORE");
      expect(output).toContain("1H SCORE");
      expect(output).toContain("5H->1W 1H");
      expect(output).toContain("1W 1H");
      expect(output).toContain("5H:1W");
      expect(output).toContain("5H RESET AT");
      expect(output).toContain("1W RESET AT");
      expect(output).toContain("quota-plus");
      expect(output).toContain("quota-team");
      expect(output).toContain("600%");
      expect(output).toContain("1000%");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list shows no ETA for accounts that are already unavailable", async () => {
    const homeDir = await createTempHome();

    try {
      await seedWatchHistory(homeDir);
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          const primaryUsedPercent = accountId === "acct-cli-blocked" ? 100 : 40;
          const secondaryUsedPercent = accountId === "acct-cli-blocked" ? 65 : 35;

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: primaryUsedPercent,
                limit_window_seconds: 18_000,
                reset_after_seconds: 400,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: secondaryUsedPercent,
                limit_window_seconds: 604_800,
                reset_after_seconds: 4_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-blocked");
      await runCli(["save", "quota-blocked", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-available");
      await runCli(["save", "quota-available", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const output = listStdout.read();
      const blockedRow = output
        .trimEnd()
        .split("\n")
        .find((line) => line.includes("quota-blocked"));

      expect(blockedRow).toBeDefined();
      expect(blockedRow).toContain("quota-blocked");
      expect(blockedRow).not.toContain("unavailable");
      expect(blockedRow).toMatch(/\s-\s+/);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list available summary excludes accounts blocked by a fully used window", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          const planType = accountId === "acct-cli-available-team" ? "team" : "plus";
          const primaryUsedPercent =
            accountId === "acct-cli-available-plus"
              ? 20
              : accountId === "acct-cli-available-team"
                ? 0
                : 40;
          const secondaryUsedPercent =
            accountId === "acct-cli-available-plus"
              ? 30
              : accountId === "acct-cli-available-team"
                ? 100
                : 100;

          return jsonResponse({
            plan_type: planType,
            rate_limit: {
              primary_window: {
                used_percent: primaryUsedPercent,
                limit_window_seconds: 18_000,
                reset_after_seconds: 1_200,
                reset_at: 1_775_000_000,
              },
              secondary_window: {
                used_percent: secondaryUsedPercent,
                limit_window_seconds: 604_800,
                reset_after_seconds: 86_400,
                reset_at: 1_775_086_400,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-cli-available-plus");
      await runCli(["save", "available-plus", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-available-team");
      await runCli(["save", "blocked-team", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-available-one-week");
      await runCli(["save", "blocked-plus", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const plainOutput = listStdout.read().replace(/\u001b\[[0-9;]*m/g, "");
      const lines = plainOutput.trimEnd().split("\n");

      expect(lines[1]).toBe("Accounts: 1/3 usable | blocked: 1W 2, 5H 0 | plus x2, team x1");
      expect(lines[2]).toBe("Available: bottleneck 0.12 | 5H->1W 0.12 | 1W 0.7 (plus 1W)");
      expect(plainOutput).toContain("blocked-team");
      expect(plainOutput).toContain("blocked-plus");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list --json includes eta metadata per account", async () => {
    const homeDir = await createTempHome();

    try {
      await seedWatchHistory(homeDir);
      const store = createAccountStore(homeDir, {
        fetchImpl: async () =>
          jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 60,
                limit_window_seconds: 18_000,
                reset_after_seconds: 400,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 50,
                limit_window_seconds: 604_800,
                reset_after_seconds: 4_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          }),
      });

      await writeCurrentAuth(homeDir, "acct-cli-json-eta");
      await runCli(["save", "quota-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);
      const output = JSON.parse(listStdout.read());
      expect(output.successes[0]?.eta).toMatchObject({
        status: "ok",
        bottleneck: "five_hour",
      });
      expect(typeof output.successes[0]?.eta?.rate_1w_units_per_hour).toBe("number");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list --debug warns when observed ratios diverge from built-in plan ratios", async () => {
    const homeDir = await createTempHome();

    try {
      await seedRecentRatioWatchHistory(homeDir);
      const store = createAccountStore(homeDir, {
        fetchImpl: async () =>
          jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 60,
                limit_window_seconds: 18_000,
                reset_after_seconds: 400,
                reset_at: Math.floor(Date.now() / 1000) + 400,
              },
              secondary_window: {
                used_percent: 50,
                limit_window_seconds: 604_800,
                reset_after_seconds: 4_000,
                reset_at: Math.floor(Date.now() / 1000) + 4_000,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "11",
            },
          }),
      });

      await writeCurrentAuth(homeDir, "acct-cli-json-eta");
      await runCli(["save", "plus-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const exitCode = await runCli(["list", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      const debugOutput = stderr.read();
      expect(debugOutput).toContain("[debug] list: observed_5h_1w_ratio window=24h plan=plus");
      expect(debugOutput).not.toContain("dimension=bucket");
      expect(debugOutput).not.toContain("[debug] warning: list observed_5h_1w_ratio_mismatch window=24h plan=plus");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
