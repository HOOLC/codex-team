import { PassThrough } from "node:stream";

import { describe, expect, test } from "@rstest/core";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import packageJson from "../package.json";

import { rankAutoSwitchCandidates, runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store.js";
import type { AccountQuotaSummary } from "../src/account-store.js";
import type {
  CodexDesktopLauncher,
  ManagedCurrentQuotaSnapshot,
  ManagedCodexDesktopState,
  RunningCodexDesktop,
} from "../src/codex-desktop-launch.js";
import type { WatchProcessManager, WatchProcessState } from "../src/watch-process.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  textResponse,
  writeCurrentConfig,
  writeCurrentApiKeyAuth,
  writeCurrentAuth,
} from "./test-helpers.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function captureWritable(): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => output,
  };
}

function createDesktopLauncherStub(overrides: Partial<{
  findInstalledApp: () => Promise<string | null>;
  listRunningApps: () => Promise<RunningCodexDesktop[]>;
  quitRunningApps: (options?: { force?: boolean }) => Promise<void>;
  launch: (appPath: string) => Promise<void>;
  writeManagedState: (state: ManagedCodexDesktopState) => Promise<void>;
  readManagedState: () => Promise<ManagedCodexDesktopState | null>;
  clearManagedState: () => Promise<void>;
  isManagedDesktopRunning: () => Promise<boolean>;
  readManagedCurrentQuota: () => Promise<ManagedCurrentQuotaSnapshot | null>;
  isRunningInsideDesktopShell: () => Promise<boolean>;
  applyManagedSwitch: (options?: {
    force?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  watchManagedQuotaSignals: (options?: {
    signal?: AbortSignal;
    debugLogger?: (line: string) => void;
    onStatus?: (event: {
      type: "disconnected" | "reconnected";
      attempt: number;
      error: string | null;
    }) => Promise<void> | void;
    onQuotaSignal?: (signal: {
      requestId: string;
      url: string;
      status: number | null;
      reason: string;
      bodySnippet: string | null;
      shouldAutoSwitch: boolean;
      quota?: {
        plan_type: string | null;
        credits_balance: number | null;
        unlimited: boolean;
        five_hour: {
          used_percent: number;
          window_seconds: number;
          reset_at: string | null;
        } | null;
        one_week: {
          used_percent: number;
          window_seconds: number;
          reset_at: string | null;
        } | null;
        fetched_at: string;
      } | null;
    }) => Promise<void> | void;
  }) => Promise<void>;
}> = {}): CodexDesktopLauncher {
  return {
    findInstalledApp: overrides.findInstalledApp ?? (async () => "/Applications/Codex.app"),
    listRunningApps: overrides.listRunningApps ?? (async () => []),
    quitRunningApps: overrides.quitRunningApps ?? (async () => undefined),
    launch:
      overrides.launch ??
      (async () => undefined),
    writeManagedState: overrides.writeManagedState ?? (async () => undefined),
    readManagedState: overrides.readManagedState ?? (async () => null),
    clearManagedState: overrides.clearManagedState ?? (async () => undefined),
    isManagedDesktopRunning: overrides.isManagedDesktopRunning ?? (async () => false),
    readManagedCurrentQuota: overrides.readManagedCurrentQuota ?? (async () => null),
    isRunningInsideDesktopShell: overrides.isRunningInsideDesktopShell ?? (async () => false),
    applyManagedSwitch: overrides.applyManagedSwitch ?? (async () => false),
    watchManagedQuotaSignals: overrides.watchManagedQuotaSignals ?? (async () => undefined),
  };
}

function createInteractiveStdin(): NodeJS.ReadStream & {
  emitInput: (value: string) => void;
  pauseCalls: number;
  resumeCalls: number;
} {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    emitInput: (value: string) => void;
    pauseCalls: number;
    resumeCalls: number;
  };

  stream.isTTY = true;
  stream.pauseCalls = 0;
  stream.resumeCalls = 0;

  const originalPause = stream.pause.bind(stream);
  stream.pause = (() => {
    stream.pauseCalls += 1;
    return originalPause();
  }) as typeof stream.pause;

  const originalResume = stream.resume.bind(stream);
  stream.resume = (() => {
    stream.resumeCalls += 1;
    return originalResume();
  }) as typeof stream.resume;

  stream.emitInput = (value: string) => {
    stream.write(value);
  };

  return stream;
}

function createWatchProcessManagerStub(overrides: Partial<{
  startDetached: (options: { autoSwitch: boolean; debug: boolean }) => Promise<WatchProcessState>;
  getStatus: () => Promise<{ running: boolean; state: WatchProcessState | null }>;
  stop: () => Promise<{ running: boolean; state: WatchProcessState | null; stopped: boolean }>;
}> = {}): WatchProcessManager {
  return {
    startDetached:
      overrides.startDetached ??
      (async () => ({
        pid: 43210,
        started_at: "2026-04-08T13:58:00.000Z",
        log_path: "/tmp/watch.log",
        auto_switch: false,
        debug: false,
      })),
    getStatus:
      overrides.getStatus ??
      (async () => ({
        running: false,
        state: null,
      })),
    stop:
      overrides.stop ??
      (async () => ({
        running: false,
        state: null,
        stopped: false,
      })),
  };
}

describe("CLI", () => {
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
    expect(output).toContain("codexm launch [name] [--json]");
    expect(output).toContain("codexm watch [--auto-switch]");
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
      expect(script).toContain("current");
      expect(script).toContain("watch");
      expect(script).toContain("completion");
      expect(script).toContain("--auto-switch");
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

  test("current best-effort shows live usage when managed MCP quota is available", async () => {
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
      expect(output).toContain("Managed account: current-live");
      expect(output).toContain("Usage: available | 5H 12% used | 1W 47% used | live");
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
      expect(stdout.read()).toContain("Usage: available | 5H 9% used | 1W 31% used | refreshed via mcp");
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
        successes: [
          {
            name: "cli-key",
            refresh_status: "unsupported",
            available: null,
            plan_type: null,
            credits_balance: null,
            five_hour: null,
            one_week: null,
          },
        ],
        failures: [],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports update and rejects unmanaged current auth", async () => {
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
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "3",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-update");
      await runCli(["save", "cli-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-update", "chatgpt", "pro");
      const updateStdout = captureWritable();
      const updateStderr = captureWritable();
      const updateCode = await runCli(["update", "--json"], {
        store,
        stdout: updateStdout.stream,
        stderr: updateStderr.stream,
      });

      expect(updateCode).toBe(0);
      expect(JSON.parse(updateStdout.read())).toMatchObject({
        ok: true,
        action: "update",
        account: {
          name: "cli-main",
          auth_mode: "chatgpt",
        },
        quota: {
          refresh_status: "ok",
          credits_balance: 3,
          plan_type: "plus",
          five_hour: {
            used_percent: 20,
          },
          one_week: {
            used_percent: 70,
          },
        },
      });

      await writeCurrentAuth(homeDir, "acct-unmanaged");
      const unmanagedStdout = captureWritable();
      const unmanagedStderr = captureWritable();
      const unmanagedCode = await runCli(["update", "--json"], {
        store,
        stdout: unmanagedStdout.stream,
        stderr: unmanagedStderr.stream,
      });

      expect(unmanagedCode).toBe(1);
      expect(JSON.parse(unmanagedStderr.read())).toMatchObject({
        ok: false,
        error: "Current account is not managed.",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports interactive remove without leaving stdin active", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-remove");
      await runCli(["save", "remove-me", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdin = createInteractiveStdin();
      const stdout = captureWritable();
      const stderr = captureWritable();
      const removePromise = runCli(["remove", "remove-me"], {
        store,
        stdin,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      stdin.emitInput("y\n");

      const removeCode = await removePromise;
      expect(removeCode).toBe(0);
      expect(stdout.read()).toBe('Remove saved account "remove-me"? [y/N] \nRemoved account "remove-me".\n');
      expect(stderr.read()).toBe("");
      expect(stdin.resumeCalls).toBeGreaterThanOrEqual(1);
      expect(stdin.pauseCalls).toBeGreaterThanOrEqual(1);

      const accounts = await store.listAccounts();
      expect(accounts.accounts).toHaveLength(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("launches desktop with current auth when no account is provided", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const calls: string[] = [];
      const stdout = captureWritable();
      const stderr = captureWritable();
      let listCalls = 0;

      const exitCode = await runCli(["launch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 501, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
          },
          quitRunningApps: async () => {
            calls.push("quit");
          },
          launch: async () => {
            calls.push("launch");
          },
          writeManagedState: async () => {
            calls.push("write-state");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual(["launch", "write-state"]);
      expect(stdout.read()).toContain("Launched Codex Desktop with current auth.");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("prints debug details during launch when --debug is enabled", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let listCalls = 0;

      const exitCode = await runCli(["launch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 501, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
          },
          launch: async () => undefined,
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain("[debug] launch: using app path /Applications/Codex.app");
      expect(stderr.read()).toContain("[debug] launch: recorded managed desktop pid=501 port=9223");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switches account before launch when account is provided", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch");
      await runCli(["save", "launch-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const calls: string[] = [];
      const stdout = captureWritable();
      const stderr = captureWritable();
      let listCalls = 0;
      const exitCode = await runCli(["launch", "launch-main"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 502, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
          },
          quitRunningApps: async () => {
            calls.push("quit");
          },
          launch: async () => {
            calls.push("launch");
          },
          writeManagedState: async () => {
            calls.push("write-state");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual(["launch", "write-state"]);
      expect(stdout.read()).toContain('Switched to "launch-main"');
      expect(stdout.read()).toContain('Launched Codex Desktop with "launch-main"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refuses to relaunch running desktop in non-interactive mode", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async () => undefined,
        launch: async () => undefined,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("Refusing to relaunch Codex Desktop in a non-interactive terminal.");
  });

  test("refuses launch from inside Codex Desktop before switching accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch-target");
      await runCli(["save", "launch-target", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-original");
      const stdout = captureWritable();
      const stderr = captureWritable();
      const exitCode = await runCli(["launch", "launch-target"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isRunningInsideDesktopShell: async () => true,
        }),
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain(
        'Refusing to run "codexm launch" from inside Codex Desktop because quitting the app would terminate this session. Run this command from an external terminal instead.',
      );
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-original");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("fails when Codex Desktop is not installed", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        findInstalledApp: async () => null,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("Codex Desktop not found at /Applications/Codex.app.");
  });

  test("does not switch accounts when launch fails before Desktop startup", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch-before");
      await runCli(["save", "launch-before", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-current");

      const exitCode = await runCli(["launch", "launch-before"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub({
          findInstalledApp: async () => null,
        }),
      });

      expect(exitCode).toBe(1);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-current");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("aborts non-managed relaunch when the user rejects force-kill confirmation", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async () => {
          calls.push("quit");
        },
        launch: async () => {
          calls.push("launch");
        },
      }),
    });

    stdin.emitInput("n\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(stdout.read()).toContain("Force-kill it and relaunch with the selected auth?");
    expect(stdout.read()).toContain("Aborted.");
    expect(stderr.read()).toBe("");
  });

  test("force-kills a non-managed Desktop instance after confirmation", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];
    let listCalls = 0;

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => {
          listCalls += 1;
          return listCalls <= 2
            ? [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }]
            : [{ pid: 456, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
        },
        quitRunningApps: async (options) => {
          calls.push(options?.force === true ? "quit:force" : "quit");
        },
        launch: async () => {
          calls.push("launch");
        },
        writeManagedState: async () => {
          calls.push("write-state");
        },
      }),
    });

    stdin.emitInput("y\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["quit:force", "launch", "write-state"]);
    expect(stdout.read()).toContain("Force-kill it and relaunch with the selected auth?");
    expect(stdout.read()).toContain("Closed existing Codex Desktop instance and launched a new one.");
    expect(stderr.read()).toBe("");
  });

  test("relaunches a codexm-managed Desktop instance without force-kill", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];
    let listCalls = 0;

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => {
          listCalls += 1;
          return listCalls <= 2
            ? [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }]
            : [{ pid: 456, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
        },
        readManagedState: async () => ({
          pid: 123,
          app_path: "/Applications/Codex.app",
          remote_debugging_port: 9223,
          managed_by_codexm: true,
          started_at: "2026-04-08T00:00:00.000Z",
        }),
        quitRunningApps: async (options) => {
          calls.push(options?.force === true ? "quit:force" : "quit");
        },
        launch: async () => {
          calls.push("launch");
        },
        writeManagedState: async () => {
          calls.push("write-state");
        },
      }),
    });

    stdin.emitInput("y\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["quit", "launch", "write-state"]);
    expect(stdout.read()).toContain("Close it and relaunch with the selected auth?");
    expect(stderr.read()).toBe("");
  });

  test("does not launch a new Desktop instance when quitting the old one fails", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async (options) => {
          calls.push(options?.force === true ? "quit:force" : "quit");
          throw new Error("quit failed");
        },
        launch: async () => {
          calls.push("launch");
        },
      }),
    });

    stdin.emitInput("y\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(1);
    expect(calls).toEqual(["quit:force"]);
    expect(stderr.read()).toContain("quit failed");
  });

  test("fails launch when managed desktop tracking cannot be recorded", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [],
        launch: async () => {
          calls.push("launch");
        },
        clearManagedState: async () => {
          calls.push("clear-state");
        },
        writeManagedState: async () => {
          calls.push("write-state");
        },
      }),
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual(["launch", "clear-state"]);
    expect(stderr.read()).toContain(
      "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
    );
  });

  test("restores the previous auth when launch fails after switching accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch-target");
      await runCli(["save", "launch-target", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-original");

      const exitCode = await runCli(["launch", "launch-target"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => [],
          launch: async () => undefined,
        }),
      });

      expect(exitCode).toBe(1);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-original");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch refuses to run when there is no managed desktop session", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => false,
        }),
      });

      expect(exitCode).toBe(1);
      expect(stderr.read()).toContain("No codexm-managed Codex Desktop session is running.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --status reports when no background watch is running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--status"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Watch: not running");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --status reports running background watch details", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["watch", "--status"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: true,
            state: {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              debug: false,
            },
          }),
        }),
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("Watch: running (pid 43210)");
      expect(output).toContain("Started at: 2026-04-08T13:58:00.000Z");
      expect(output).toContain("Auto-switch: enabled");
      expect(output).toContain("Log: /tmp/watch.log");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --detach starts a background watcher", async () => {
    const homeDir = await createTempHome();
    let startedOptions: { autoSwitch: boolean; debug: boolean } | null = null;

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--detach", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
        }),
        watchProcessManager: createWatchProcessManagerStub({
          startDetached: async (options) => {
            startedOptions = options;
            return {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: false,
              debug: true,
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(startedOptions).toEqual({
        autoSwitch: false,
        debug: true,
      });
      expect(stdout.read()).toContain("Started background watch (pid 43210).");
      expect(stdout.read()).toContain("Log: /tmp/watch.log");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --detach --auto-switch starts a background auto-switch watcher", async () => {
    const homeDir = await createTempHome();
    let startedOptions: { autoSwitch: boolean; debug: boolean } | null = null;

    try {
      const store = createAccountStore(homeDir);

      const exitCode = await runCli(["watch", "--detach", "--auto-switch"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
        }),
        watchProcessManager: createWatchProcessManagerStub({
          startDetached: async (options) => {
            startedOptions = options;
            return {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              debug: false,
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(startedOptions).toEqual({
        autoSwitch: true,
        debug: false,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --stop stops the background watcher", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["watch", "--stop"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        watchProcessManager: createWatchProcessManagerStub({
          stop: async () => ({
            running: false,
            stopped: true,
            state: {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              debug: false,
            },
          }),
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Stopped background watch (pid 43210).");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch prints quota updates without auto-switching by default", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let applyManagedSwitchCalls = 0;
      let readManagedCurrentQuotaCalls = 0;

      const exitCode = await runCli(["watch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => {
            readManagedCurrentQuotaCalls += 1;
            throw new Error("watch should use quota carried by account/rateLimits/read");
          },
          watchManagedQuotaSignals: async (options) => {
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"from_view","event":{"type":"mcp-request","request":{"id":"req-1","method":"account/rateLimits/read","params":{}}}}}',
            );
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"for_view","event":{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}}}',
            );
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}',
              shouldAutoSwitch: true,
              quota: {
                plan_type: "team",
                credits_balance: null,
                unlimited: false,
                fetched_at: "2026-04-08T15:20:00.000Z",
                five_hour: {
                  used_percent: 72,
                  window_seconds: 18_000,
                  reset_at: "2026-04-08T16:50:52.000Z",
                },
                one_week: {
                  used_percent: 63,
                  window_seconds: 604_800,
                  reset_at: "2026-04-14T09:17:35.000Z",
                },
              },
            });
          },
          applyManagedSwitch: async () => {
            applyManagedSwitchCalls += 1;
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain('"method":"Bridge.message"');
      expect(stderr.read()).toContain('"type":"mcp-request"');
      expect(stderr.read()).toContain('"type":"mcp-response"');
      expect(stderr.read()).toContain(
        '[debug] watch: quota signal matched reason=rpc_response requestId=rpc:req-1',
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
      expect(readManagedCurrentQuotaCalls).toBe(0);
      expect(applyManagedSwitchCalls).toBe(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch prints non-exhausted rate limit updates without auto-switching", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let applyManagedSwitchCalls = 0;

      const exitCode = await runCli(["watch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "team",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 72,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 63,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"for_view","event":{"type":"mcp-notification","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":72},"secondary":{"usedPercent":63}}}}}}',
            );
            await options?.onQuotaSignal?.({
              requestId: "rpc:notification:account/rateLimits/updated",
              url: "mcp:account/rateLimits/updated",
              status: null,
              reason: "rpc_notification",
              bodySnippet:
                '{"type":"mcp-notification","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":72},"secondary":{"usedPercent":63}}}}',
              shouldAutoSwitch: false,
              quota: {
                plan_type: "team",
                credits_balance: null,
                unlimited: false,
                fetched_at: "2026-04-08T15:20:00.000Z",
                five_hour: {
                  used_percent: 72,
                  window_seconds: 18_000,
                  reset_at: "2026-04-08T16:50:52.000Z",
                },
                one_week: {
                  used_percent: 63,
                  window_seconds: 604_800,
                  reset_at: "2026-04-14T09:17:35.000Z",
                },
              },
            });
          },
          applyManagedSwitch: async () => {
            applyManagedSwitchCalls += 1;
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain('"method":"account/rateLimits/updated"');
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
      expect(applyManagedSwitchCalls).toBe(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch suppresses duplicate quota output when different MCP events read the same quota", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "plus",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 3,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 30,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":3},"secondaryWindow":{"usedPercent":30}}}}}',
              shouldAutoSwitch: false,
              quota: {
                plan_type: "plus",
                credits_balance: null,
                unlimited: false,
                fetched_at: "2026-04-08T15:20:00.000Z",
                five_hour: {
                  used_percent: 3,
                  window_seconds: 18_000,
                  reset_at: "2026-04-08T16:50:52.000Z",
                },
                one_week: {
                  used_percent: 30,
                  window_seconds: 604_800,
                  reset_at: "2026-04-14T09:17:35.000Z",
                },
              },
            });
            await options?.onQuotaSignal?.({
              requestId: "rpc:notification:account/rateLimits/updated",
              url: "mcp:account/rateLimits/updated",
              status: null,
              reason: "rpc_notification",
              bodySnippet:
                '{"type":"mcp-notification","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":3},"secondary":{"usedPercent":30}}}}',
              shouldAutoSwitch: false,
              quota: {
                plan_type: "plus",
                credits_balance: null,
                unlimited: false,
                fetched_at: "2026-04-08T15:20:00.000Z",
                five_hour: {
                  used_percent: 3,
                  window_seconds: 18_000,
                  reset_at: "2026-04-08T16:50:52.000Z",
                },
                one_week: {
                  used_percent: 30,
                  window_seconds: 604_800,
                  reset_at: "2026-04-14T09:17:35.000Z",
                },
              },
            });
          },
        }),
      });

      expect(exitCode).toBe(0);
      const quotaLines = stdout
        .read()
        .split("\n")
        .filter((line) => line.includes("quota account="));
      expect(quotaLines).toHaveLength(1);
      expect(quotaLines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=97% left 1W=70% left$/,
      );
      expect(stderr.read()).toContain(
        '[debug] watch: quota output unchanged for requestId=rpc:notification:account/rateLimits/updated',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --auto-switch does not switch on non-exhausted rate limit updates", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--debug", "--auto-switch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "team",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 72,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 63,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            await options?.onQuotaSignal?.({
              requestId: "rpc:notification:account/rateLimits/updated",
              url: "mcp:account/rateLimits/updated",
              status: null,
              reason: "rpc_notification",
              bodySnippet:
                '{"type":"mcp-notification","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":72},"secondary":{"usedPercent":63}}}}',
              shouldAutoSwitch: false,
            });
          },
          applyManagedSwitch: async () => true,
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
      expect(stdout.read()).not.toContain('Auto-switched to');
      expect(stderr.read()).toContain('[debug] watch: auto-switch enabled');
      expect(stderr.read()).toContain(
        '[debug] watch: skipping auto switch for requestId=rpc:notification:account/rateLimits/updated because the event is informational only',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch reports connection loss and recovery while reconnecting", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "team",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 72,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 63,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            await options?.onStatus?.({
              type: "disconnected",
              attempt: 1,
              error: "Codex Desktop devtools watch connection closed unexpectedly.",
            });
            await options?.onStatus?.({
              type: "reconnected",
              attempt: 1,
              error: null,
            });
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}',
              shouldAutoSwitch: true,
            });
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] reconnect-lost account="current" attempt=1 error="Codex Desktop devtools watch connection closed unexpectedly\."/,
      );
      expect(stderr.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] reconnect-ok account="current" attempt=1/,
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --auto-switch auto-switches on quota signals", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            const headers = new Headers(init?.headers);
            const accountId = headers.get("ChatGPT-Account-Id");

            if (accountId === "acct-watch-a") {
              return jsonResponse({
                plan_type: "plus",
                rate_limit: {
                  primary_window: {
                    used_percent: 100,
                    limit_window_seconds: 18_000,
                    reset_after_seconds: 500,
                    reset_at: 1_773_868_641,
                  },
                  secondary_window: {
                    used_percent: 100,
                    limit_window_seconds: 604_800,
                    reset_after_seconds: 6_000,
                    reset_at: 1_773_890_040,
                  },
                },
                credits: {
                  has_credits: false,
                  unlimited: false,
                  balance: "0",
                },
              });
            }

            if (accountId === "acct-watch-b") {
              return jsonResponse({
                plan_type: "plus",
                rate_limit: {
                  primary_window: {
                    used_percent: 20,
                    limit_window_seconds: 18_000,
                    reset_after_seconds: 500,
                    reset_at: 1_773_868_641,
                  },
                  secondary_window: {
                    used_percent: 30,
                    limit_window_seconds: 604_800,
                    reset_after_seconds: 6_000,
                    reset_at: 1_773_890_040,
                  },
                },
                credits: {
                  has_credits: true,
                  unlimited: false,
                  balance: "3",
                },
              });
            }
          }

          return textResponse("not found", 404);
        },
      });

      await writeCurrentAuth(homeDir, "acct-watch-a");
      await runCli(["save", "watch-a", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-watch-b");
      await runCli(["save", "watch-b", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-watch-a");

      const applyManagedSwitchCalls: Array<{ force?: boolean; timeoutMs?: number }> = [];
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--debug", "--auto-switch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          watchManagedQuotaSignals: async (options) => {
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"from_view","event":{"type":"mcp-request","request":{"id":"req-1","method":"account/rateLimits/read","params":{}}}}}',
            );
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"for_view","event":{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}}}',
            );
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}',
              shouldAutoSwitch: true,
            });
          },
          applyManagedSwitch: async (options) => {
            applyManagedSwitchCalls.push({ ...options });
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain('"method":"Bridge.message"');
      expect(stderr.read()).toContain('"type":"mcp-request"');
      expect(stderr.read()).toContain('"type":"mcp-response"');
      expect(stderr.read()).toContain(
        '[debug] watch: quota signal matched reason=rpc_response requestId=rpc:req-1',
      );
      expect(stderr.read()).toContain('[debug] watch: auto-switch enabled');
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="watch-a" status=unavailable/,
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] auto-switch from="watch-a" to="watch-b"/,
      );
      expect(applyManagedSwitchCalls).toEqual([{ force: false, timeoutMs: 600_000 }]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch still warns when a non-managed Codex Desktop instance is running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-warning");
      await runCli(["save", "switch-warning", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-warning"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [{ pid: 321, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        }),
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain(
        'Warning: "codexm switch" updates local auth, but running Codex Desktop may still use the previous login state.',
      );
      expect(output).toContain(
        'Warning: Use "codexm launch" to start Codex Desktop with the selected auth; future switches can apply immediately to that session.',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch does not warn when the running Desktop instance is managed by codexm", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-managed");
      await runCli(["save", "switch-managed", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const calls: Array<{ force?: boolean; timeoutMs?: number }> = [];

      const exitCode = await runCli(["switch", "switch-managed"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) => {
            calls.push({ ...options });
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ force: false, timeoutMs: 120_000 }]);
      expect(stdout.read()).not.toContain("Existing sessions may still hold the previous login state.");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch reports wait progress while refreshing a managed Desktop session", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-progress");
      await runCli(["save", "switch-progress", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-progress", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 5,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          applyManagedSwitch: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        account: {
          name: "switch-progress",
        },
      });
      expect(stderr.read()).toContain(
        "Waiting for the current Codex Desktop thread to finish before applying the switch...",
      );
      expect(stderr.read()).toContain("Still waiting for the current Codex Desktop thread to finish");
      expect(stderr.read()).toContain("Applied the switch to the managed Codex Desktop session.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch warns when refreshing the running codexm-managed Desktop session fails", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-restart-fail");
      await runCli(["save", "switch-restart-fail", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-restart-fail"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => {
            throw new Error("restart failed");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain(
        "Failed to refresh the running codexm-managed Codex Desktop session: restart failed",
      );
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch succeeds even when Desktop inspection fails after the auth has been switched", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-inspection");
      await runCli(["save", "switch-inspection", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-inspection"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            throw new Error("ps failed");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain('Switched to "switch-inspection"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch --force immediately restarts a codexm-managed Desktop session", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-force");
      await runCli(["save", "switch-force", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const calls: Array<{ force?: boolean; timeoutMs?: number }> = [];

      const exitCode = await runCli(["switch", "switch-force", "--force"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) => {
            calls.push({ ...options });
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ force: true, timeoutMs: 120_000 }]);
      expect(stdout.read()).toContain('Switched to "switch-force"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch prints debug details when --debug is enabled", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-debug");
      await runCli(["save", "switch-debug", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-debug", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => true,
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain('Switched to "switch-debug"');
      expect(stderr.read()).toContain("[debug] switch: mode=manual target=switch-debug force=false");
      expect(stderr.read()).toContain("[debug] switch: completed target=switch-debug");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch does not roll back local auth when managed Desktop refresh is interrupted", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-interrupt-a");
      await runCli(["save", "switch-interrupt-a", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-switch-interrupt-b");
      await runCli(["save", "switch-interrupt-b", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const interruptController = new AbortController();
      setTimeout(() => {
        interruptController.abort();
      }, 0);

      const exitCode = await runCli(["switch", "switch-interrupt-a", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        interruptSignal: interruptController.signal,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) =>
            await new Promise<boolean>((_resolve, reject) => {
              if (options?.signal?.aborted) {
                const error = new Error("Managed Codex Desktop refresh was interrupted.");
                error.name = "AbortError";
                reject(error);
                return;
              }

              options?.signal?.addEventListener(
                "abort",
                () => {
                  const error = new Error("Managed Codex Desktop refresh was interrupted.");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            }),
        }),
      });

      expect(exitCode).toBe(0);
      const payload = JSON.parse(stdout.read());
      expect(payload).toMatchObject({
        ok: true,
        action: "switch",
        account: {
          name: "switch-interrupt-a",
          account_id: "acct-switch-interrupt-a",
        },
      });
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "Refreshing the running codexm-managed Codex Desktop session was interrupted",
          ),
        ]),
      );
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-switch-interrupt-a");
      expect(stderr.read()).toBe("");
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
      expect(output).toContain("CURRENT SCORE");
      expect(output).toContain("available");
      expect(output).toContain("* quota-main");
      expect(output).toContain("  quota-backup");
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

  test("errors on unknown flags with a suggestion instead of silently ignoring them", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["list", "--josn"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      const errorOutput = stderr.read();
      expect(errorOutput).toContain('Unknown flag "--josn" for command "list".');
      expect(errorOutput).toContain('Did you mean "--json"?');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refreshes quota automatically after switch", async () => {
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
                  used_percent: 9,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 300,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 66,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 3_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "8",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-switch-a");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-switch-b");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const switchStdout = captureWritable();
      const switchCode = await runCli(["switch", "alpha", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [],
        }),
        stdout: switchStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(switchCode).toBe(0);
      expect(JSON.parse(switchStdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        account: {
          name: "alpha",
        },
        quota: {
          available: "available",
          refresh_status: "ok",
          credits_balance: 8,
          five_hour: {
            used_percent: 9,
          },
          one_week: {
            used_percent: 66,
          },
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("marks availability from 5h and 1w usage thresholds", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-threshold-a") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 91,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "5",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 15,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 100,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-threshold-a");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-threshold-b");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const code = await runCli(["list", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        successes: [
          {
            name: "alpha",
            available: "almost unavailable",
          },
          {
            name: "beta",
            available: "unavailable",
          },
        ],
        failures: [],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports auto switch and dry-run selection", async () => {
    const homeDir = await createTempHome();

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-auto-alpha") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 60,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: nowSeconds + 500,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: nowSeconds + 6_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "3",
              },
            });
          }

          if (accountId === "acct-auto-beta") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 50,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: nowSeconds + 500,
                },
                secondary_window: {
                  used_percent: 80,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: nowSeconds + 6_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 100,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: nowSeconds + 500,
              },
              secondary_window: {
                used_percent: 10,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: nowSeconds + 6_000,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-auto-alpha");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-beta");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-gamma");
      await runCli(["save", "gamma", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const dryRunStdout = captureWritable();
      const dryRunCode = await runCli(["switch", "--auto", "--dry-run", "--json"], {
        store,
        stdout: dryRunStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(dryRunCode).toBe(0);
      const dryRunPayload = JSON.parse(dryRunStdout.read());
      expect(dryRunPayload).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        dry_run: true,
        selected: {
          name: "alpha",
          available: "available",
          current_score: 13.33,
          remain_5h: 40,
          remain_1w: 30,
          remain_5h_in_1w_units: 13.33,
          five_hour_windows_per_week: 3,
        },
      });
      expect(dryRunPayload.selected.score_1h).toBeCloseTo(30, 2);
      expect(dryRunPayload.selected.projected_5h_1h).toBeCloseTo(91.67, 2);
      expect(dryRunPayload.selected.projected_5h_in_1w_units_1h).toBeCloseTo(30.56, 2);
      expect(dryRunPayload.selected.projected_1w_1h).toBeCloseTo(30, 2);

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-gamma");

      const switchStdout = captureWritable();
      const switchCode = await runCli(["switch", "--auto", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [],
        }),
        stdout: switchStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(switchCode).toBe(0);
      const switchPayload = JSON.parse(switchStdout.read());
      expect(switchPayload).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        account: {
          name: "alpha",
          account_id: "acct-auto-alpha",
        },
        selected: {
          name: "alpha",
          current_score: 13.33,
          five_hour_windows_per_week: 3,
        },
        quota: {
          available: "available",
          refresh_status: "ok",
          five_hour: {
            used_percent: 60,
          },
          one_week: {
            used_percent: 70,
          },
        },
      });
      expect(switchPayload.selected.score_1h).toBeCloseTo(30, 2);

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-alpha");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("auto switch keeps candidates with only one quota window", () => {
    const singleWindowAccount: AccountQuotaSummary = {
      name: "alpha",
      account_id: "acct-single-window",
      user_id: null,
      identity: "acct-single-window",
      plan_type: "plus",
      credits_balance: 9,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 20,
        window_seconds: 18_000,
        reset_at: "2026-04-08T01:00:00.000Z",
      },
      one_week: null,
    };

    const twoWindowAccount: AccountQuotaSummary = {
      name: "beta",
      account_id: "acct-two-window",
      user_id: null,
      identity: "acct-two-window",
      plan_type: "plus",
      credits_balance: 3,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 60,
        window_seconds: 18_000,
        reset_at: "2026-04-08T02:00:00.000Z",
      },
      one_week: {
        used_percent: 70,
        window_seconds: 604_800,
        reset_at: "2026-04-09T00:00:00.000Z",
      },
    };

    expect(rankAutoSwitchCandidates([singleWindowAccount, twoWindowAccount])).toMatchObject([
      {
        name: "alpha",
        current_score: 26.67,
        score_1h: 26.67,
        remain_5h: 80,
        remain_1w: null,
        remain_5h_in_1w_units: 26.67,
        projected_5h_1h: 80,
        projected_5h_in_1w_units_1h: 26.67,
        five_hour_windows_per_week: 3,
      },
      {
        name: "beta",
        current_score: 13.33,
        score_1h: 13.33,
        remain_5h: 40,
        remain_1w: 30,
        remain_5h_in_1w_units: 13.33,
        projected_5h_1h: 40,
        projected_5h_in_1w_units_1h: 13.33,
        projected_1w_1h: 30,
        five_hour_windows_per_week: 3,
      },
    ]);
  });

  test("auto switch scoring converts 5h remaining by plan-relative window size", () => {
    const plusAccount: AccountQuotaSummary = {
      name: "plus",
      account_id: "acct-plus",
      user_id: null,
      identity: "acct-plus",
      plan_type: "plus",
      credits_balance: 5,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 20,
        window_seconds: 18_000,
        reset_at: "2026-04-08T01:00:00.000Z",
      },
      one_week: {
        used_percent: 50,
        window_seconds: 604_800,
        reset_at: "2026-04-15T00:00:00.000Z",
      },
    };

    const teamAccount: AccountQuotaSummary = {
      name: "team",
      account_id: "acct-team",
      user_id: null,
      identity: "acct-team",
      plan_type: "team",
      credits_balance: 5,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 20,
        window_seconds: 18_000,
        reset_at: "2026-04-08T01:00:00.000Z",
      },
      one_week: {
        used_percent: 50,
        window_seconds: 604_800,
        reset_at: "2026-04-15T00:00:00.000Z",
      },
    };

    expect(rankAutoSwitchCandidates([plusAccount, teamAccount])).toMatchObject([
      {
        name: "plus",
        current_score: 26.67,
        score_1h: 26.67,
        remain_1w: 50,
        remain_5h_in_1w_units: 26.67,
        projected_5h_in_1w_units_1h: 26.67,
        projected_1w_1h: 50,
        five_hour_windows_per_week: 3,
      },
      {
        name: "team",
        current_score: 10,
        score_1h: 10,
        remain_1w: 50,
        remain_5h_in_1w_units: 10,
        projected_5h_in_1w_units_1h: 10,
        projected_1w_1h: 50,
        five_hour_windows_per_week: 8,
      },
    ]);
  });

  test("auto switch scoring prefers earlier reset when projected availability is higher", () => {
    const earlyResetAccount: AccountQuotaSummary = {
      name: "early-reset",
      account_id: "acct-early-reset",
      user_id: null,
      identity: "acct-early-reset",
      plan_type: "plus",
      credits_balance: 2,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 40,
        window_seconds: 18_000,
        reset_at: "2026-04-08T00:05:00.000Z",
      },
      one_week: null,
    };

    const lateResetAccount: AccountQuotaSummary = {
      name: "late-reset",
      account_id: "acct-late-reset",
      user_id: null,
      identity: "acct-late-reset",
      plan_type: "plus",
      credits_balance: 2,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 35,
        window_seconds: 18_000,
        reset_at: "2026-04-08T04:30:00.000Z",
      },
      one_week: null,
    };

    expect(rankAutoSwitchCandidates([earlyResetAccount, lateResetAccount])).toMatchObject([
      {
        name: "early-reset",
        remain_5h: 60,
        current_score: 20,
        projected_5h_1h: 96.67,
      },
      {
        name: "late-reset",
        remain_5h: 65,
        current_score: 21.67,
        projected_5h_1h: 65,
      },
    ]);
  });

  test("auto switch scoring keeps a clearly better current score ahead of a near-reset zero balance", () => {
    const nearResetButEmpty: AccountQuotaSummary = {
      name: "near-reset-empty",
      account_id: "acct-near-reset-empty",
      user_id: null,
      identity: "acct-near-reset-empty",
      plan_type: "plus",
      credits_balance: 1,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 100,
        window_seconds: 18_000,
        reset_at: "2026-04-08T00:05:00.000Z",
      },
      one_week: null,
    };

    const modestButAvailable: AccountQuotaSummary = {
      name: "modest-available",
      account_id: "acct-modest-available",
      user_id: null,
      identity: "acct-modest-available",
      plan_type: "plus",
      credits_balance: 1,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 70,
        window_seconds: 18_000,
        reset_at: "2026-04-08T04:30:00.000Z",
      },
      one_week: null,
    };

    expect(rankAutoSwitchCandidates([nearResetButEmpty, modestButAvailable])).toMatchObject([
      {
        name: "modest-available",
        current_score: 10,
        score_1h: 10,
      },
      {
        name: "near-reset-empty",
        current_score: 0,
        score_1h: 30.56,
      },
    ]);
  });

  test("skips auto switch when current account is already the best available account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-best-current") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_860_000,
                },
                secondary_window: {
                  used_percent: 20,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_880_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 40,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 70,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-best-current");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-other");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-best-current");

      const stdout = captureWritable();
      const code = await runCli(["switch", "--auto", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        skipped: true,
        reason: "already_current_best",
        account: {
          name: "alpha",
          account_id: "acct-best-current",
        },
        selected: {
          name: "alpha",
          available: "available",
        },
      });

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-best-current");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
