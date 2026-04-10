import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import packageJson from "../package.json";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store.js";
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
    expect(output).toContain("codexm completion <zsh|bash>");
    expect(output).toContain("Global flags: --help, --version, --debug");
    expect(stderr.read()).toBe("");
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
      expect(script).toContain("watch");
      expect(script).toContain("completion");
      expect(script).toContain("--device-auth");
      expect(script).toContain("--no-auto-switch");
      expect(script).toContain("'--debug:enable debug logging'");
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
      expect(script).toContain("--with-api-key");
      expect(script).toContain("--detach");
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
      const tableLines = lines.slice(tableStartIndex, tableStartIndex + 4);
      const currentRow = tableLines.find((line) => line.includes("quota-main"));

      expect(lines[0]).toBe("Current managed account: quota-main");
      expect(output).not.toContain("CREDITS");
      expect(output).toContain("AVAILABLE");
      expect(output).toContain("ETA");
      expect(output).toContain("CURRENT SCORE");
      expect(output).toContain("available");
      expect(output).toContain("* quota-main");
      expect(output).toContain("  quota-backup");
      expect(output).toContain("1.8h");
      expect(output).toContain(
        dayjs.utc("2026-03-18T21:17:21.000Z").tz(dayjs.tz.guess()).format("MM-DD HH:mm"),
      );
      expect(output).toContain(
        dayjs.utc("2026-03-19T03:14:00.000Z").tz(dayjs.tz.guess()).format("MM-DD HH:mm"),
      );
      expect(tableLines).toHaveLength(4);
      expect(currentRow).toBeDefined();
      expect(tableLines[0]?.indexOf("NAME")).toBe(currentRow?.indexOf("quota-main"));
      expect(tableLines[0]?.indexOf("IDENTITY")).toBe(currentRow?.indexOf("acct-c"));
      expect(tableLines[0]?.indexOf("PLAN TYPE")).toBe(tableLines[3]?.indexOf("plus"));
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
              plan_type: accountId === "acct-cli-verbose-team" ? "team" : "plus",
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
      expect(output).toContain("ETA");
      expect(output).toContain("ETA 5H->1W");
      expect(output).toContain("ETA 1W");
      expect(output).toContain("RATE 1W UNITS");
      expect(output).toContain("5H REMAIN->1W");
      expect(output).toContain("CURRENT SCORE");
      expect(output).toContain("1H SCORE");
      expect(output).toContain("5H->1W 1H");
      expect(output).toContain("1W 1H");
      expect(output).toContain("1W:5H");
      expect(output).toContain("quota-plus");
      expect(output).toContain("quota-team");
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
});
