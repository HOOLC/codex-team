import { EventEmitter } from "node:events";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import {
  createInitialAccountDashboardState,
  renderAccountDashboardScreen,
  runAccountDashboardTui,
  type AccountDashboardExternalUpdate,
  type AccountDashboardSnapshot,
} from "../src/tui/index.js";
import { setPlatformForTesting } from "../src/platform.js";
import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import {
  buildAccountDashboardSnapshot,
  buildCachedAccountDashboardSnapshot,
  handleTuiCommand,
} from "../src/commands/tui.js";
import {
  cleanupTempHome,
  createTempHome,
} from "./test-helpers.js";
import {
  captureWritable,
  createDesktopLauncherStub,
  createInteractiveStdin,
  createInteractiveStdout,
  createWatchProcessManagerStub,
} from "./cli-fixtures.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

function latestDashboardFrame(value: string): string {
  return stripAnsi(value.split("\u001B[2J\u001B[H").at(-1) ?? value);
}

function createSnapshot(currentName = "alpha"): AccountDashboardSnapshot {
  return {
    headerLine: `codexm | current ${currentName} | 2/3 usable | updated 13:24`,
    currentStatusLine: `Current managed account: ${currentName}`,
    summaryLine: "Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, pro x1",
    poolLine: "Available: bottleneck 0.55 | 5H->1W 0.82 | 1W 0.55 (plus 1W)",
    usageSummary: {
      generated_at: "2026-04-16T13:24:00.000Z",
      timezone: "UTC",
      windows: {
        today: {
          input_tokens: 18000,
          cached_input_tokens: 3000,
          output_tokens: 9000,
          total_tokens: 27000,
          estimated_input_cost_usd: 0.05,
          estimated_output_cost_usd: 0.08,
          estimated_total_cost_usd: 0.13,
          priced_tokens: 27000,
          unpriced_tokens: 0,
        },
        "7d": {
          input_tokens: 182000,
          cached_input_tokens: 30000,
          output_tokens: 96000,
          total_tokens: 278000,
          estimated_input_cost_usd: 0.42,
          estimated_output_cost_usd: 0.71,
          estimated_total_cost_usd: 1.13,
          priced_tokens: 278000,
          unpriced_tokens: 0,
        },
        "30d": {
          input_tokens: 420000,
          cached_input_tokens: 90000,
          output_tokens: 210000,
          total_tokens: 630000,
          estimated_input_cost_usd: 1.02,
          estimated_output_cost_usd: 1.91,
          estimated_total_cost_usd: 2.93,
          priced_tokens: 630000,
          unpriced_tokens: 0,
        },
        "all-time": {
          input_tokens: 620000,
          cached_input_tokens: 120000,
          output_tokens: 310000,
          total_tokens: 930000,
          estimated_input_cost_usd: 1.52,
          estimated_output_cost_usd: 2.81,
          estimated_total_cost_usd: 4.33,
          priced_tokens: 930000,
          unpriced_tokens: 0,
        },
      },
      daily: [
        {
          date: "2026-04-16",
          input_tokens: 18000,
          cached_input_tokens: 3000,
          output_tokens: 9000,
          total_tokens: 27000,
          estimated_input_cost_usd: 0.05,
          estimated_output_cost_usd: 0.08,
          estimated_total_cost_usd: 0.13,
          priced_tokens: 27000,
          unpriced_tokens: 0,
        },
        {
          date: "2026-04-15",
          input_tokens: 22000,
          cached_input_tokens: 4000,
          output_tokens: 11000,
          total_tokens: 33000,
          estimated_input_cost_usd: 0.06,
          estimated_output_cost_usd: 0.09,
          estimated_total_cost_usd: 0.15,
          priced_tokens: 33000,
          unpriced_tokens: 0,
        },
        {
          date: "2026-04-14",
          input_tokens: 9000,
          cached_input_tokens: 1000,
          output_tokens: 5000,
          total_tokens: 14000,
          estimated_input_cost_usd: 0.03,
          estimated_output_cost_usd: 0.05,
          estimated_total_cost_usd: 0.08,
          priced_tokens: 14000,
          unpriced_tokens: 0,
        },
      ],
    },
    warnings: ["beta using cached quota from 2026-04-15T08:00:00.000Z after refresh failed"],
    failures: [{ name: "gamma", error: "Failed to refresh quota for \"gamma\": 429" }],
    accounts: [
      {
        name: "alpha",
        planLabel: "plus",
        identityLabel: "acct-alpha:user-alpha",
        availabilityLabel: "available",
        current: currentName === "alpha",
        autoSwitchEligible: true,
        score: 88,
        scoreLabel: "88%",
        etaLabel: "8.2h",
        nextResetLabel: "04-16 19:30",
        fiveHourLabel: "18%",
        oneWeekLabel: "42%",
        authModeLabel: "chatgpt",
        emailLabel: "alpha@example.com",
        accountIdLabel: "acct...pha",
        userIdLabel: "user...pha",
        joinedAtLabel: "2026-03-18 12:30",
        lastSwitchedAtLabel: "2026-04-16 13:24",
        fetchedAtLabel: "2026-04-16 13:23",
        refreshStatusLabel: "ok",
        bottleneckLabel: "1W",
        reasonLabel: "available",
        oneWeekBlocked: false,
        detailLines: [
          "Email: alpha@example.com",
          "Auth: chatgpt",
          "Fetched: 2026-04-16 13:23",
          "Refresh: ok",
          "Reason: available",
          "",
          "Identity: acct-alpha:user-alpha",
          "Account: acct...pha",
          "User: user...pha",
          "Bottleneck: 1W",
          "Joined: 2026-03-18 12:30",
          "Switched: 2026-04-16 13:24",
          "",
          "Score: 88%",
          "ETA: 8.2h",
          "5H used: 18%",
          "1W used: 42%",
          "Next reset: 04-16 19:30",
        ],
      },
      {
        name: "beta",
        planLabel: "pro",
        identityLabel: "acct-beta:user-beta",
        availabilityLabel: "available",
        current: currentName === "beta",
        autoSwitchEligible: false,
        score: 64,
        scoreLabel: "64%",
        etaLabel: "3.5h",
        nextResetLabel: "04-16 18:10",
        fiveHourLabel: "36%",
        oneWeekLabel: "27%",
        authModeLabel: "chatgpt",
        emailLabel: "beta@example.com",
        accountIdLabel: "acct...eta",
        userIdLabel: "user...eta",
        joinedAtLabel: "2026-03-20 09:00",
        lastSwitchedAtLabel: "2026-04-15 10:10",
        fetchedAtLabel: "2026-04-16 13:20",
        refreshStatusLabel: "stale",
        bottleneckLabel: "5H",
        reasonLabel: "cached quota after refresh failure",
        oneWeekBlocked: false,
        detailLines: [
          "Email: beta@example.com",
          "Auth: chatgpt",
          "Fetched: 2026-04-16 13:20",
          "Refresh: stale",
          "Reason: cached quota after refresh failure",
          "",
          "Identity: acct-beta:user-beta",
          "Account: acct...eta",
          "User: user...eta",
          "Bottleneck: 5H",
          "Joined: 2026-03-20 09:00",
          "Switched: 2026-04-15 10:10",
          "",
          "Score: 64%",
          "ETA: 3.5h",
          "5H used: 36%",
          "1W used: 27%",
          "Next reset: 04-16 18:10",
        ],
      },
      {
        name: "gamma",
        planLabel: "plus",
        identityLabel: "acct-gamma:user-gamma",
        availabilityLabel: "blocked",
        current: currentName === "gamma",
        autoSwitchEligible: true,
        score: 0,
        scoreLabel: "0%",
        etaLabel: "-",
        nextResetLabel: "04-17 09:00",
        fiveHourLabel: "100%",
        oneWeekLabel: "100%",
        authModeLabel: "chatgpt",
        emailLabel: "gamma@example.com",
        accountIdLabel: "acct...mma",
        userIdLabel: "user...mma",
        joinedAtLabel: "2026-03-21 11:00",
        lastSwitchedAtLabel: "-",
        fetchedAtLabel: "2026-04-16 13:21",
        refreshStatusLabel: "error",
        bottleneckLabel: "-",
        reasonLabel: "quota refresh failed: 429",
        oneWeekBlocked: true,
        detailLines: [
          "Email: gamma@example.com",
          "Auth: chatgpt",
          "Fetched: 2026-04-16 13:21",
          "Refresh: error",
          "Reason: quota refresh failed: 429",
          "",
          "Identity: acct-gamma:user-gamma",
          "Account: acct...mma",
          "User: user...mma",
          "Bottleneck: -",
          "Joined: 2026-03-21 11:00",
          "Switched: -",
          "",
          "Score: 0%",
          "ETA: -",
          "5H used: 100%",
          "1W used: 100%",
          "Next reset: 04-17 09:00",
        ],
      },
    ],
  };
}

function flushLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Account Dashboard TUI", () => {
  test("renders a split account dashboard with summary, list, and detail panes", () => {
    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot: createSnapshot("beta"),
        state: {
          ...createInitialAccountDashboardState(),
          selected: 1,
        },
        width: 120,
        height: 28,
      }),
    );

    expect(screen).toContain("codexm | current beta | 2/3 usable | updated 13:24");
    expect(screen).toContain("Usage: today");
    expect(screen).toContain("Trend 30d:");
    expect(screen).toContain("NAME");
    expect(screen).toContain("IDENTITY");
    expect(screen).toContain("USED");
    expect(screen).toContain("5H");
    expect(screen).toContain("1W");
    expect(screen).toContain("NEXT RESET");
    expect(screen).toContain(">* beta [P]");
    expect(screen).toContain("alpha");
    expect(screen).toContain("Email: beta@example.com");
    expect(screen).toContain("beta [current] [protected]");
    expect(screen).toContain("Joined: 2026-03-20 09:00");
    expect(screen).toContain("Fetched: 2026-04-16 13:20");
    expect(screen).toContain("Bottleneck: 5H");
    expect(screen).toContain("filter:");
    expect(screen).toContain("Enter");
    expect(screen).toContain("o run");
    expect(screen).toContain("D rel");
    expect(screen).toContain("e/E exp");
    expect(screen).toContain("q quit");
  });

  test("toggles auto-switch protection from the dashboard with p", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const toggleCalls: Array<{ name: string; eligible: boolean }> = [];

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async () => ({
        statusMessage: 'Switched to "alpha".',
        warningMessages: [],
      }),
      toggleAutoSwitchProtection: async (name, eligible) => {
        toggleCalls.push({ name, eligible });
        return {
          statusMessage: eligible
            ? `Removed auto-switch protection from "${name}".`
            : `Protected "${name}" from auto-switch target selection.`,
          preferredName: name,
        };
      },
    });

    await flushLoop();
    stdin.emitInput("j");
    await flushLoop();
    stdin.emitInput("p");
    await flushLoop();
    await flushLoop();

    expect(toggleCalls).toEqual([{ name: "beta", eligible: true }]);
    expect(latestDashboardFrame(stdout.read())).toContain(
      'Removed auto-switch protection from "beta".',
    );

    stdin.emitInput("q");
    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
  });

  test("renders a reload hint when the selected account is already current", () => {
    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot: createSnapshot("alpha"),
        state: createInitialAccountDashboardState(),
        width: 120,
        height: 28,
      }),
    );

    expect(screen).toContain("f reload");
  });

  test("renders an empty-state dashboard when no saved accounts exist", () => {
    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot: {
          headerLine: "codexm | current none | 0/0 usable | updated -",
          currentStatusLine: "Current auth: missing",
          summaryLine: "Accounts: 0/0 usable | blocked: 1W 0, 5H 0",
          poolLine: "Available: bottleneck - | 5H->1W - | 1W - (plus 1W)",
          usageSummary: null,
          warnings: [],
          failures: [],
          accounts: [],
        },
        state: createInitialAccountDashboardState(),
        width: 100,
        height: 24,
      }),
    );

    expect(screen).toContain("No saved accounts.");
    expect(screen).toContain("Use \"codexm add <name>\" or \"codexm save <name>\"");
    expect(screen).toContain("filter:");
  });

  test("keeps score, eta, and used windows visible in compact list mode", () => {
    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot: createSnapshot("alpha"),
        state: {
          ...createInitialAccountDashboardState("beta@example.com"),
          selected: 0,
        },
        width: 68,
        height: 24,
      }),
    );

    expect(screen).toContain("beta");
    expect(screen).toContain("64%");
    expect(screen).toContain("3.5h");
    expect(screen).toContain("36%");
    expect(screen).toContain("27%");
  });

  test("hides the trend line on shorter terminals while keeping the usage summary", () => {
    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot: createSnapshot("alpha"),
        state: createInitialAccountDashboardState(),
        width: 120,
        height: 20,
      }),
    );

    expect(screen).toContain("Usage: today");
    expect(screen).not.toContain("Trend 30d:");
  });

  test("hides the ETA list column when no account has ETA history", () => {
    const snapshot = createSnapshot("alpha");
    snapshot.showEtaColumn = false;
    for (const account of snapshot.accounts) {
      account.etaLabel = "-";
    }

    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot,
        state: createInitialAccountDashboardState(),
        width: 120,
        height: 28,
      }),
    );
    const headerLine = screen.split("\n").find((line) => line.includes("NAME"));

    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("NEXT RESET");
    expect(headerLine).not.toContain("ETA");
  });

  test("shows an unavailable screen when the dashboard terminal is too small", () => {
    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot: createSnapshot("alpha"),
        state: createInitialAccountDashboardState(),
        width: 40,
        height: 7,
      }),
    );

    expect(screen).toContain("Terminal too small to render the dash");
    expect(screen).toContain("Need at least: 36x8");
    expect(screen).toContain('Resize the terminal, or use "codexm li');
  });

  test("exits without busy-polling the event loop", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const originalSetTimeout = globalThis.setTimeout;
    let timeoutCalls = 0;

    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
      timeoutCalls += 1;
      return originalSetTimeout(handler as never, timeout, ...(args as []));
    }) as typeof globalThis.setTimeout;

    try {
      const tuiPromise = runAccountDashboardTui({
        stdin,
        stdout,
        autoRefreshIntervalMs: null,
        loadSnapshot: async () => createSnapshot("alpha"),
        switchAccount: async () => ({
          statusMessage: 'Switched to "alpha".',
          warningMessages: [],
        }),
      });

      await flushLoop();
      stdin.emitInput("q");

      await expect(tuiPromise).resolves.toMatchObject({
        code: 0,
        action: "quit",
      });
      expect(timeoutCalls).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("keeps navigation responsive while refresh is still loading", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    let loadCount = 0;
    let resolveRefresh: ((snapshot: AccountDashboardSnapshot) => void) | null = null;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return createSnapshot("alpha");
        }

        return await new Promise<AccountDashboardSnapshot>((resolve) => {
          resolveRefresh = resolve;
        });
      },
      switchAccount: async () => ({
        statusMessage: 'Switched to "alpha".',
        warningMessages: [],
      }),
    });

    await flushLoop();
    stdin.emitInput("r");
    await flushLoop();
    stdin.emitInput("j");
    await flushLoop();

    expect(stripAnsi(stdout.read())).toContain(">  beta");

    stdin.emitInput("q");
    await flushLoop();
    if (!resolveRefresh) {
      throw new Error("Expected refresh promise to be pending.");
    }
    const refreshResolver = resolveRefresh as (snapshot: AccountDashboardSnapshot) => void;
    refreshResolver(createSnapshot("alpha"));

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
  });

  test("returns an open-codex action after switching to the selected account", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const switchedNames: string[] = [];

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (name) => {
        switchedNames.push(name);
        return {
          statusMessage: `Switched to "${name}".`,
          warningMessages: [],
        };
      },
    });

    await flushLoop();
    stdin.emitInput("j");
    await flushLoop();
    stdin.emitInput("o");

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "open-codex",
    });
    expect(switchedNames).toEqual(["beta"]);
  });

  test("returns an open-isolated-codex action after switching to the selected account", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const switchedNames: string[] = [];

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (name) => {
        switchedNames.push(name);
        return {
          statusMessage: `Switched to "${name}".`,
          warningMessages: [],
        };
      },
    });

    await flushLoop();
    stdin.emitInput("j");
    await flushLoop();
    stdin.emitInput("O");

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "open-isolated-codex",
    });
    expect(switchedNames).toEqual(["beta"]);
  });

  test("keeps the dashboard open after opening Desktop", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const switchCalls: string[] = [];
    const desktopCalls: string[] = [];

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (name) => {
        switchCalls.push(name);
        return {
          statusMessage: `Switched to "${name}".`,
          warningMessages: [],
        };
      },
      openDesktop: async (name) => {
        desktopCalls.push(name);
        return {
          statusMessage: `Opened Codex Desktop for "${name}".`,
          warningMessages: [],
        };
      },
    });

    await flushLoop();
    stdin.emitInput("j");
    await flushLoop();
    stdin.emitInput("d");
    await flushLoop();
    await flushLoop();

    expect(desktopCalls).toEqual(["beta"]);
    expect(switchCalls).toEqual(["beta"]);
    expect(latestDashboardFrame(stdout.read())).toContain('Opened Codex Desktop for "beta".');

    stdin.emitInput("q");
    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
  });

  test("confirms Shift+D and relaunches Desktop without leaving the dashboard", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const switchCalls: string[] = [];
    const desktopCalls: Array<{ name: string; forceRelaunch?: boolean }> = [];

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (name) => {
        switchCalls.push(name);
        return {
          statusMessage: `Switched to "${name}".`,
          warningMessages: [],
        };
      },
      openDesktop: async (name, options) => {
        desktopCalls.push({
          name,
          forceRelaunch: options?.forceRelaunch,
        });
        return {
          statusMessage: `Relaunched Codex Desktop for "${name}".`,
          warningMessages: [],
        };
      },
    });

    await flushLoop();
    stdin.emitInput("j");
    await flushLoop();
    stdin.emitInput("D");
    await flushLoop();
    expect(latestDashboardFrame(stdout.read())).toContain('confirm: Relaunch Desktop for "beta"?');

    stdin.emitInput("y");
    await flushLoop();
    await flushLoop();

    expect(desktopCalls).toEqual([{ name: "beta", forceRelaunch: true }]);
    expect(switchCalls).toEqual(["beta"]);
    expect(latestDashboardFrame(stdout.read())).toContain('Relaunched Codex Desktop for "beta".');

    stdin.emitInput("q");
    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
  });

  test("starts the foreground watch immediately after opening a managed Desktop from the dashboard", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    const restorePlatform = setPlatformForTesting("darwin");
    let managedDesktopRunning = false;
    let foregroundWatchStarts = 0;
    let runningApps: Array<{ pid: number; command: string }> = [];

    try {
      const store = createAccountStore(homeDir);
      const result = await handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => runningApps,
          launch: async () => {
            managedDesktopRunning = true;
            runningApps = [
              {
                pid: 54321,
                command: "/Applications/Codex.app/Contents/MacOS/Codex",
              },
            ];
          },
          writeManagedState: async () => {
            managedDesktopRunning = true;
          },
          isManagedDesktopRunning: async () => managedDesktopRunning,
          readManagedCurrentQuota: async () => null,
          watchManagedQuotaSignals: async (options) => {
            foregroundWatchStarts += 1;
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }

              options?.signal?.addEventListener("abort", () => {
                resolve();
              }, { once: true });
            });
          },
        }),
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async () => ({
          exitCode: 0,
          restartCount: 0,
        }),
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
        runDashboardTuiImpl: async (options) => {
          if (!options.openDesktop) {
            throw new Error("Expected openDesktop callback.");
          }
          await options.openDesktop("alpha");
          return {
            code: 0,
            action: "quit",
          };
        },
      });

      expect(result).toBe(0);
      expect(foregroundWatchStarts).toBe(1);
    } finally {
      restorePlatform();
      await cleanupTempHome(homeDir);
    }
  });

  test("force relaunches a non-managed Desktop instance from the dashboard", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    const restorePlatform = setPlatformForTesting("darwin");
    const quitCalls: Array<{ force?: boolean }> = [];
    const launchCalls: string[] = [];
    let managedDesktopRunning = false;

    try {
      const store = createAccountStore(homeDir);
      const result = await handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => managedDesktopRunning
            ? [{ pid: 65432, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }]
            : [{ pid: 12345, command: "/usr/local/bin/codex --remote-debugging-port=9223" }],
          readManagedState: async () => null,
          quitRunningApps: async (options) => {
            quitCalls.push(options ?? {});
            managedDesktopRunning = true;
          },
          launch: async (appPath) => {
            launchCalls.push(appPath);
            managedDesktopRunning = true;
          },
          writeManagedState: async () => undefined,
          isManagedDesktopRunning: async () => managedDesktopRunning,
          readManagedCurrentQuota: async () => null,
          watchManagedQuotaSignals: async (options) => {
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }

              options?.signal?.addEventListener("abort", () => {
                resolve();
              }, { once: true });
            });
          },
        }),
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async () => ({
          exitCode: 0,
          restartCount: 0,
        }),
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
        runDashboardTuiImpl: async (options) => {
          if (!options.openDesktop) {
            throw new Error("Expected openDesktop callback.");
          }
          await options.openDesktop("alpha", { forceRelaunch: true });
          return {
            code: 0,
            action: "quit",
          };
        },
      });

      expect(result).toBe(0);
      expect(quitCalls).toEqual([{ force: true }]);
      expect(launchCalls).toEqual(["/Applications/Codex.app"]);
    } finally {
      restorePlatform();
      await cleanupTempHome(homeDir);
    }
  });

  test("force-reloads the current account instead of short-circuiting", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const switchCalls: Array<{ name: string; force: boolean }> = [];

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (name, switchOptions) => {
        switchCalls.push({
          name,
          force: switchOptions.force,
        });
        return {
          statusMessage: `Switched to "${name}".`,
          warningMessages: [],
        };
      },
    });

    await flushLoop();
    stdin.emitInput("f");
    await flushLoop();
    stdin.emitInput("q");

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
    expect(switchCalls).toEqual([{ name: "alpha", force: true }]);
    expect(stripAnsi(stdout.read())).toContain('Reloaded "alpha".');
  });

  test("updates the current indicator immediately after a manual switch succeeds", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    let loadCount = 0;
    let resolveRefresh: ((snapshot: AccountDashboardSnapshot) => void) | null = null;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return createSnapshot("alpha");
        }

        return await new Promise<AccountDashboardSnapshot>((resolve) => {
          resolveRefresh = resolve;
        });
      },
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
    });

    try {
      await flushLoop();
      stdin.emitInput("j");
      await flushLoop();
      stdin.emitInput("\r");
      await flushLoop();
      await flushLoop();

      const frame = latestDashboardFrame(stdout.read());
      expect(frame).toContain('Switched to "beta".');
      expect(frame).toContain("codexm | current beta");
      expect(frame).toContain(">* beta");
      expect(frame).toContain("beta [current]");
      expect(frame).toContain("f reload");

      stdin.emitInput("q");
      await flushLoop();
      const refreshResolver = resolveRefresh as ((snapshot: AccountDashboardSnapshot) => void) | null;
      if (!refreshResolver) {
        throw new Error("Expected refresh promise to be pending.");
      }
      refreshResolver(createSnapshot("beta"));

      await expect(tuiPromise).resolves.toMatchObject({
        code: 0,
        action: "quit",
      });
    } catch (error) {
      stdin.emitInput("q");
      await flushLoop();
      const refreshResolver = resolveRefresh as ((snapshot: AccountDashboardSnapshot) => void) | null;
      if (refreshResolver) {
        refreshResolver(createSnapshot("beta"));
      }
      await tuiPromise;
      throw error;
    }
  });

  test("waits for a queued refresh to settle before exiting", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    let loadCount = 0;
    let resolveRefresh: ((snapshot: AccountDashboardSnapshot) => void) | null = null;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return createSnapshot("alpha");
        }

        return await new Promise<AccountDashboardSnapshot>((resolve) => {
          resolveRefresh = resolve;
        });
      },
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
    });

    let settled = false;
    void tuiPromise.then(() => {
      settled = true;
    });

    await flushLoop();
    stdin.emitInput("f");
    await flushLoop();
    expect(resolveRefresh).not.toBeNull();

    stdin.emitInput("q");
    await flushLoop();
    expect(settled).toBe(false);

    if (!resolveRefresh) {
      throw new Error("Expected refresh promise to be pending.");
    }
    const refreshResolver: (snapshot: AccountDashboardSnapshot) => void = resolveRefresh;
    refreshResolver(createSnapshot("alpha"));

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
    expect(settled).toBe(true);
  });

  test("restores the terminal and exits on SIGTERM", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const signalSource = new EventEmitter();

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      signalSource,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
    });

    await flushLoop();
    signalSource.emit("SIGTERM");

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
    expect(stdin.isRaw).toBe(false);
    expect(stdin.pauseCalls).toBeGreaterThan(0);
    expect(stdout.read()).toContain("\u001B[?25h");
    expect(stdout.read()).toContain("\u001B[?1049l");
  });

  test("aborts an active switch operation on SIGINT", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const signalSource = new EventEmitter();
    let aborted = false;
    const pendingSwitch: { resolve: (() => void) | null } = { resolve: null };

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      signalSource,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (_name, switchOptions) => {
        await new Promise<void>((resolve, reject) => {
          pendingSwitch.resolve = resolve;
          switchOptions.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
        return {
          statusMessage: "unreachable",
          warningMessages: [],
        };
      },
    });

    await flushLoop();
    stdin.emitInput("j");
    await flushLoop();
    stdin.emitInput("\r");
    await flushLoop();
    signalSource.emit("SIGINT");
    if (!pendingSwitch.resolve) {
      throw new Error("Expected switch to be pending.");
    }
    pendingSwitch.resolve();

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
    expect(aborted).toBe(true);
  });

  test("restores the terminal and exits on SIGINT during refresh", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const signalSource = new EventEmitter();
    let loadCount = 0;
    let resolveRefresh: ((snapshot: AccountDashboardSnapshot) => void) | null = null;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      signalSource,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return createSnapshot("alpha");
        }

        return await new Promise<AccountDashboardSnapshot>((resolve) => {
          resolveRefresh = resolve;
        });
      },
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
    });

    await flushLoop();
    stdin.emitInput("r");
    await flushLoop();
    signalSource.emit("SIGINT");

    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
    expect(stdin.isRaw).toBe(false);
    expect(stdout.read()).toContain("\u001B[?1049l");
  });

  test("shows an initial refresh warning banner while keeping the cached list visible", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      initialSnapshot: createSnapshot("alpha"),
      loadSnapshot: async () => {
        throw new Error("network unavailable");
      },
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
    });

    await flushLoop();
    await flushLoop();

    const frame = latestDashboardFrame(stdout.read());
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("Initial refresh failed");
    expect(frame).toContain("network unavailable");

    stdin.emitInput("q");
    await expect(tuiPromise).resolves.toMatchObject({
      code: 0,
      action: "quit",
    });
  });

  test("keeps an active export prompt open while applying an external switch update", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    let currentName = "alpha";
    let emitExternalUpdate: ((update: AccountDashboardExternalUpdate) => void) | null = null;
    let settled = false;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      initialSnapshot: createSnapshot(currentName),
      subscribeExternalUpdates: (listener) => {
        emitExternalUpdate = listener;
        return () => {
          if (emitExternalUpdate === listener) {
            emitExternalUpdate = null;
          }
        };
      },
      loadSnapshot: async () => createSnapshot(currentName),
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
      exportAccount: async (_source, outputPath) => ({
        statusMessage: `Exported share bundle to ${outputPath}.`,
      }),
    });
    void tuiPromise.finally(() => {
      settled = true;
    });

    try {
      await flushLoop();
      stdin.emitInput("E");
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain("Export to file:");

      currentName = "beta";
      const sendExternalUpdate = emitExternalUpdate;
      if (!sendExternalUpdate) {
        throw new Error("Expected external update subscription to be active.");
      }
      (sendExternalUpdate as (update: AccountDashboardExternalUpdate) => void)({
        statusMessage: 'Current account switched from "alpha" to "beta".',
        preferredName: "beta",
      });
      await flushLoop();
      await flushLoop();

      const frame = latestDashboardFrame(stdout.read());
      expect(frame).toContain("Export to file:");
      expect(frame).toContain('Current account switched from "alpha" to "beta".');
      expect(frame).toContain("codexm | current beta");

      stdin.emitInput("\u001b");
      await flushLoop();
      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toMatchObject({
        code: 0,
        action: "quit",
      });
    } finally {
      if (!settled) {
        stdin.emitInput("\u001b");
        stdin.emitInput("q");
        await tuiPromise;
      }
    }
  });

  test("uses Esc to back out of an export prompt and q to exit from browse mode", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    let exportCalls = 0;
    let settled = false;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => createSnapshot("alpha"),
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
      exportAccount: async () => {
        exportCalls += 1;
        return {
          statusMessage: "unreachable",
        };
      },
    });
    void tuiPromise.finally(() => {
      settled = true;
    });

    try {
      await flushLoop();
      stdin.emitInput("E");
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain("Export to file:");

      stdin.emitInput("\u001b");
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).not.toContain("Export to file:");

      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toMatchObject({
        code: 0,
        action: "quit",
      });
      expect(exportCalls).toBe(0);
    } finally {
      if (!settled) {
        stdin.emitInput("q");
        await tuiPromise;
      }
    }
  });

  test("imports a bundle through preview and can undo the latest import", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const importedAccount = {
      ...createSnapshot("alpha").accounts[0],
      name: "friend-main",
      current: false,
      identityLabel: "acct-friend:user-friend",
      accountIdLabel: "acct...end",
      userIdLabel: "user...end",
    };
    let currentSnapshot = createSnapshot("alpha");
    let settled = false;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => currentSnapshot,
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
      inspectImportBundle: async (bundlePath) => ({
        bundlePath,
        suggestedName: "source-main",
        title: "Import Bundle",
        lines: [
          'Source: managed account "source-main"',
          "Suggested name: source-main",
          "Auth mode: chatgpt",
          "Identity: acct-friend:user-friend",
        ],
      }),
      importBundle: async (_bundlePath, localName) => {
        const previousSnapshot = currentSnapshot;
        currentSnapshot = {
          ...currentSnapshot,
          accounts: [...currentSnapshot.accounts, { ...importedAccount, name: localName }],
        };
        return {
          statusMessage: `Imported account "${localName}".`,
          preferredName: localName,
          undo: {
            label: "undo import",
            run: async () => {
              currentSnapshot = previousSnapshot;
              return {
                statusMessage: `Undid import "${localName}".`,
                preferredName: "alpha",
              };
            },
          },
        };
      },
    });
    void tuiPromise.finally(() => {
      settled = true;
    });

    try {
      await flushLoop();
      stdin.emitInput("i");
      await flushLoop();
      stdin.emitInput("bundle.json\r");
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain("Import Bundle");
      expect(latestDashboardFrame(stdout.read())).toContain("Save as name:");

      stdin.emitInput("friend-main\r");
      await flushLoop();
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain('Imported account "friend-main". Press u to undo.');
      expect(latestDashboardFrame(stdout.read())).toContain("friend-main");

      stdin.emitInput("u");
      await flushLoop();
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain('Undid import "friend-main".');
      expect(latestDashboardFrame(stdout.read())).not.toContain(">  friend-main");

      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toMatchObject({
        code: 0,
        action: "quit",
      });
    } finally {
      if (!settled) {
        stdin.emitInput("q");
        await tuiPromise;
      }
    }
  });

  test("requires explicit confirmation before deleting and can undo the delete", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    let currentSnapshot = createSnapshot("alpha");
    let settled = false;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => currentSnapshot,
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
      deleteAccount: async (name) => {
        const previousSnapshot = currentSnapshot;
        currentSnapshot = {
          ...currentSnapshot,
          accounts: currentSnapshot.accounts.filter((account) => account.name !== name),
        };
        return {
          statusMessage: `Deleted "${name}".`,
          preferredName: "beta",
          undo: {
            label: "undo delete",
            run: async () => {
              currentSnapshot = previousSnapshot;
              return {
                statusMessage: `Restored "${name}".`,
                preferredName: name,
              };
            },
          },
        };
      },
    });
    void tuiPromise.finally(() => {
      settled = true;
    });

    try {
      await flushLoop();
      stdin.emitInput("x");
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain('Delete account "alpha"? [y/N]');

      stdin.emitInput("\u001b");
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).not.toContain('Delete account "alpha"? [y/N]');

      stdin.emitInput("x");
      await flushLoop();
      stdin.emitInput("y");
      await flushLoop();
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain('Deleted "alpha". Press u to undo.');
      expect(latestDashboardFrame(stdout.read())).not.toContain("* alpha");

      stdin.emitInput("u");
      await flushLoop();
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain('Restored "alpha".');
      expect(latestDashboardFrame(stdout.read())).toContain("* alpha");

      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toMatchObject({
        code: 0,
        action: "quit",
      });
    } finally {
      if (!settled) {
        stdin.emitInput("q");
        await tuiPromise;
      }
    }
  });

  test("keeps a single undo slot shared by export and import", async () => {
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    let exportUndoCalls = 0;
    let importUndoCalls = 0;
    let currentSnapshot = createSnapshot("alpha");
    let settled = false;

    const tuiPromise = runAccountDashboardTui({
      stdin,
      stdout,
      autoRefreshIntervalMs: null,
      loadSnapshot: async () => currentSnapshot,
      switchAccount: async (name) => ({
        statusMessage: `Switched to "${name}".`,
        warningMessages: [],
      }),
      exportAccount: async (_source, outputPath) => ({
        statusMessage: `Exported share bundle to ${outputPath}.`,
        undo: {
          label: "undo export",
          run: async () => {
            exportUndoCalls += 1;
            return {
              statusMessage: `Removed ${outputPath}.`,
            };
          },
        },
      }),
      inspectImportBundle: async () => ({
        bundlePath: "bundle.json",
        suggestedName: "source-main",
        title: "Import Bundle",
        lines: [
          'Source: managed account "source-main"',
          "Suggested name: source-main",
          "Auth mode: chatgpt",
          "Identity: acct-friend:user-friend",
        ],
      }),
      importBundle: async (_bundlePath, localName) => {
        const previousSnapshot = currentSnapshot;
        currentSnapshot = {
          ...currentSnapshot,
          accounts: [...currentSnapshot.accounts, { ...currentSnapshot.accounts[0], name: localName, current: false }],
        };
        return {
          statusMessage: `Imported account "${localName}".`,
          preferredName: localName,
          undo: {
            label: "undo import",
            run: async () => {
              importUndoCalls += 1;
              currentSnapshot = previousSnapshot;
              return {
                statusMessage: `Undid import "${localName}".`,
                preferredName: "alpha",
              };
            },
          },
        };
      },
    });
    void tuiPromise.finally(() => {
      settled = true;
    });

    try {
      await flushLoop();
      stdin.emitInput("e");
      await flushLoop();
      stdin.emitInput("\r");
      await flushLoop();
      expect(latestDashboardFrame(stdout.read())).toContain("Press u to undo.");

      stdin.emitInput("i");
      await flushLoop();
      stdin.emitInput("bundle.json\r");
      await flushLoop();
      stdin.emitInput("friend-main\r");
      await flushLoop();
      await flushLoop();
      stdin.emitInput("u");
      await flushLoop();
      await flushLoop();

      expect(importUndoCalls).toBe(1);
      expect(exportUndoCalls).toBe(0);

      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toMatchObject({
        code: 0,
        action: "quit",
      });
    } finally {
      if (!settled) {
        stdin.emitInput("q");
        await tuiPromise;
      }
    }
  });

  test("bare interactive codexm enters the dashboard instead of printing help", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdin = createInteractiveStdin();
      const stdout = createInteractiveStdout();
      const stderr = captureWritable();

      const cliPromise = runCli([], {
        store,
        stdin,
        stdout,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
      });

      await flushLoop();
      stdin.emitInput("q");

      await expect(cliPromise).resolves.toBe(0);
      expect(stripAnsi(stdout.read())).toContain("codexm | current missing | 0/0 usable | updated -");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("starts a foreground watch when no detached watch is running", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    let settled = false;
    let foregroundWatchStarts = 0;
    let foregroundWatchAborts = 0;
    let authWatcherClosed = 0;
    let tuiPromise: Promise<number> | null = null;
    let resolveForegroundWatchStarted: (() => void) | null = null;
    const foregroundWatchStarted = new Promise<void>((resolve) => {
      resolveForegroundWatchStarted = resolve;
    });

    try {
      const store = createAccountStore(homeDir);
      tuiPromise = handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => null,
          watchManagedQuotaSignals: async (options) => {
            foregroundWatchStarts += 1;
            resolveForegroundWatchStarted?.();
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                foregroundWatchAborts += 1;
                resolve();
                return;
              }

              options?.signal?.addEventListener("abort", () => {
                foregroundWatchAborts += 1;
                resolve();
              }, { once: true });
            });
          },
        }),
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async () => ({
          exitCode: 0,
          restartCount: 0,
        }),
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
        authWatchImpl: (() => Object.assign(new EventEmitter(), {
          close: () => {
            authWatcherClosed += 1;
          },
        }) as never) as never,
      });
      void tuiPromise.finally(() => {
        settled = true;
      });

      await Promise.race([
        foregroundWatchStarted,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("Expected foreground watch to start."));
          }, 250);
        }),
      ]);
      expect(foregroundWatchStarts).toBe(1);

      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toBe(0);
      expect(foregroundWatchAborts).toBe(1);
      expect(authWatcherClosed).toBe(1);
      expect(stderr.read()).toBe("");
    } finally {
      if (!settled && tuiPromise) {
        stdin.emitInput("q");
        await tuiPromise;
      }
      await cleanupTempHome(homeDir);
    }
  });

  test("reopens the dashboard after running codex from the o shortcut", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    const runDashboardCalls: string[] = [];
    const runCodexCalls: Array<{ accountId: string | null | undefined; authFilePath?: string }> = [];

    try {
      const store = createAccountStore(homeDir);
      const result = await handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub(),
        watchProcessManager: createWatchProcessManagerStub(),
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async (options) => {
          runCodexCalls.push({
            accountId: options.accountId,
            authFilePath: options.authFilePath,
          });
          return {
            exitCode: 0,
            restartCount: 0,
          };
        },
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
        runDashboardTuiImpl: async (options) => {
          runDashboardCalls.push(options.initialQuery ?? "");
          return runDashboardCalls.length === 1
            ? {
                code: 0,
                action: "open-codex",
                preferredName: "alpha",
              }
            : {
                code: 0,
                action: "quit",
              };
        },
      });

      expect(result).toBe(0);
      expect(runCodexCalls).toHaveLength(1);
      expect(runCodexCalls[0]?.authFilePath).toBeUndefined();
      expect(runDashboardCalls).toHaveLength(2);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reopens the dashboard after running isolated codex from the O shortcut", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    const overlayDir = join(homeDir, "overlay-home");
    const runCodexCalls: Array<{ accountId: string | null | undefined; authFilePath?: string; disableAuthWatch?: boolean }> = [];
    let cleanupCalls = 0;
    let samplerStopped = 0;

    try {
      const store = createAccountStore(homeDir);
      const result = await handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub(),
        watchProcessManager: createWatchProcessManagerStub(),
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async (options) => {
          runCodexCalls.push({
            accountId: options.accountId,
            authFilePath: options.authFilePath,
            disableAuthWatch: options.disableAuthWatch,
          });
          return {
            exitCode: 0,
            restartCount: 0,
          };
        },
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
        runDashboardTuiImpl: async () => {
          if (runCodexCalls.length === 0) {
            return {
              code: 0,
              action: "open-isolated-codex",
              preferredName: "beta",
            };
          }
          return {
            code: 0,
            action: "quit",
          };
        },
        prepareIsolatedRunImpl: async () => ({
          account: {
            name: "beta",
            auth_mode: "chatgpt",
            account_id: "acct-beta",
            user_id: "user-beta",
            auto_switch_eligible: true,
            identity: "acct-beta:user-beta",
            email: "beta@example.com",
            created_at: "2026-04-16T00:00:00.000Z",
            updated_at: "2026-04-16T00:00:00.000Z",
            last_switched_at: null,
            quota: {
              status: "ok",
            },
            authPath: `${overlayDir}/auth.json`,
            metaPath: `${overlayDir}/meta.json`,
            configPath: null,
            duplicateAccountId: false,
          },
          authFilePath: `${overlayDir}/auth.json`,
          codexHomePath: overlayDir,
          env: {
            ...process.env,
            CODEX_HOME: overlayDir,
          },
          runId: "overlay-1",
          sessionsDirPath: `${overlayDir}/sessions`,
          cleanup: async () => {
            cleanupCalls += 1;
          },
        }),
        startIsolatedQuotaHistorySamplerImpl: () => ({
          stop: async () => {
            samplerStopped += 1;
          },
        }),
      });

      expect(result).toBe(0);
      expect(runCodexCalls).toEqual([
        expect.objectContaining({
          accountId: "acct-beta",
          authFilePath: `${overlayDir}/auth.json`,
          disableAuthWatch: true,
        }),
      ]);
      expect(cleanupCalls).toBe(1);
      expect(samplerStopped).toBe(1);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not start a foreground watch when another foreground watch lease is active", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    let foregroundWatchStarts = 0;

    try {
      const store = createAccountStore(homeDir);
      const tuiPromise = handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => null,
          watchManagedQuotaSignals: async () => {
            foregroundWatchStarts += 1;
          },
        }),
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
        watchLeaseManager: {
          getStatus: async () => ({
            active: true,
            state: {
              owner_kind: "tui-foreground",
              pid: 54321,
              started_at: "2026-04-17T00:00:00.000Z",
              auto_switch: true,
              debug: false,
            },
          }),
          claimForeground: async () => ({
            acquired: false,
            state: {
              owner_kind: "tui-foreground",
              pid: 54321,
              started_at: "2026-04-17T00:00:00.000Z",
              auto_switch: true,
              debug: false,
            },
          }),
          recordDetached: async () => undefined,
          release: async () => undefined,
        },
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async () => ({
          exitCode: 0,
          restartCount: 0,
        }),
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
      });

      await flushLoop();
      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toBe(0);
      expect(foregroundWatchStarts).toBe(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("hands foreground watch off to a detached watch on quit", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    let settled = false;
    let foregroundWatchStarts = 0;
    let foregroundWatchAborts = 0;
    const detachedStarts: Array<{ autoSwitch: boolean; debug: boolean }> = [];
    let tuiPromise: Promise<number> | null = null;
    let resolveForegroundWatchStarted: (() => void) | null = null;
    const foregroundWatchStarted = new Promise<void>((resolve) => {
      resolveForegroundWatchStarted = resolve;
    });

    try {
      const store = createAccountStore(homeDir);
      tuiPromise = handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => null,
          watchManagedQuotaSignals: async (options) => {
            foregroundWatchStarts += 1;
            resolveForegroundWatchStarted?.();
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                foregroundWatchAborts += 1;
                resolve();
                return;
              }

              options?.signal?.addEventListener("abort", () => {
                foregroundWatchAborts += 1;
                resolve();
              }, { once: true });
            });
          },
        }),
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
          startDetached: async (options) => {
            detachedStarts.push(options);
            return {
              pid: 54321,
              started_at: "2026-04-17T00:00:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: options.autoSwitch,
              debug: options.debug,
            };
          },
        }),
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async () => ({
          exitCode: 0,
          restartCount: 0,
        }),
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
      });
      void tuiPromise.finally(() => {
        settled = true;
      });

      await Promise.race([
        foregroundWatchStarted,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("Expected foreground watch to start."));
          }, 250);
        }),
      ]);

      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toBe(0);
      expect(foregroundWatchStarts).toBe(1);
      expect(foregroundWatchAborts).toBe(1);
      expect(detachedStarts).toEqual([{ autoSwitch: true, debug: false }]);
    } finally {
      if (!settled && tuiPromise) {
        stdin.emitInput("q");
        await tuiPromise;
      }
      await cleanupTempHome(homeDir);
    }
  });

  test("stops the foreground watch after a detached watch appears", async () => {
    const homeDir = await createTempHome();
    const stdin = createInteractiveStdin();
    const stdout = createInteractiveStdout();
    const stderr = captureWritable();
    let settled = false;
    let foregroundWatchStarts = 0;
    let foregroundWatchAborts = 0;
    let detachedRunning = false;
    let tuiPromise: Promise<number> | null = null;
    let resolveForegroundWatchStarted: (() => void) | null = null;
    const foregroundWatchStarted = new Promise<void>((resolve) => {
      resolveForegroundWatchStarted = resolve;
    });

    try {
      const store = createAccountStore(homeDir);
      tuiPromise = handleTuiCommand({
        positionals: [],
        store,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => null,
          watchManagedQuotaSignals: async (options) => {
            foregroundWatchStarts += 1;
            resolveForegroundWatchStarted?.();
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                foregroundWatchAborts += 1;
                resolve();
                return;
              }

              options?.signal?.addEventListener("abort", () => {
                foregroundWatchAborts += 1;
                resolve();
              }, { once: true });
            });
          },
        }),
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: detachedRunning,
            state: detachedRunning
              ? {
                  pid: 77777,
                  started_at: "2026-04-17T00:00:00.000Z",
                  log_path: "/tmp/watch.log",
                  auto_switch: true,
                  debug: false,
                }
              : null,
          }),
        }),
        streams: {
          stdin,
          stdout,
          stderr: stderr.stream,
        },
        runCodexCli: async () => ({
          exitCode: 0,
          restartCount: 0,
        }),
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 1,
        foregroundWatchLeasePollIntervalMs: 10,
      });
      void tuiPromise.finally(() => {
        settled = true;
      });

      await Promise.race([
        foregroundWatchStarted,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("Expected foreground watch to start."));
          }, 250);
        }),
      ]);
      detachedRunning = true;

      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });
      expect(foregroundWatchStarts).toBe(1);
      expect(foregroundWatchAborts).toBe(1);

      stdin.emitInput("q");
      await expect(tuiPromise).resolves.toBe(0);
    } finally {
      if (!settled && tuiPromise) {
        stdin.emitInput("q");
        await tuiPromise;
      }
      await cleanupTempHome(homeDir);
    }
  });

  test("builds a ranked dashboard snapshot from refreshed quota data", async () => {
    const homeDir = await createTempHome();

    try {
      const snapshot = await buildAccountDashboardSnapshot({
        store: {
          paths: {
            codexTeamDir: `${homeDir}/.codex-team`,
          },
          listAccounts: async () => ({
            warnings: [],
            accounts: [
              {
                name: "alpha",
                auth_mode: "chatgpt",
                account_id: "acct-alpha",
                user_id: "user-alpha",
                identity: "acct-alpha:user-alpha",
                email: "alpha@example.com",
                created_at: "2026-03-18T04:30:00.000Z",
                updated_at: "2026-04-16T05:23:00.000Z",
                last_switched_at: "2026-04-16T05:24:00.000Z",
                quota: {
                  status: "ok",
                  fetched_at: "2026-04-16T08:00:00.000Z",
                },
                authPath: `${homeDir}/alpha/auth.json`,
                metaPath: `${homeDir}/alpha/meta.json`,
                configPath: null,
                duplicateAccountId: false,
              },
              {
                name: "beta",
                auth_mode: "chatgpt",
                account_id: "acct-beta",
                user_id: "user-beta",
                identity: "acct-beta:user-beta",
                email: "beta@example.com",
                created_at: "2026-03-19T01:00:00.000Z",
                updated_at: "2026-04-16T05:20:00.000Z",
                last_switched_at: "2026-04-15T02:10:00.000Z",
                quota: {
                  status: "stale",
                  fetched_at: "2026-04-16T08:00:00.000Z",
                  error_message: "refresh failed",
                },
                authPath: `${homeDir}/beta/auth.json`,
                metaPath: `${homeDir}/beta/meta.json`,
                configPath: null,
                duplicateAccountId: false,
              },
              {
                name: "gamma",
                auth_mode: "chatgpt",
                account_id: "acct-gamma",
                user_id: "user-gamma",
                identity: "acct-gamma:user-gamma",
                email: "gamma@example.com",
                created_at: "2026-03-20T01:00:00.000Z",
                updated_at: "2026-04-16T05:21:00.000Z",
                last_switched_at: null,
                quota: {
                  status: "error",
                  fetched_at: "2026-04-16T08:05:00.000Z",
                  error_message: "quota failed",
                },
                authPath: `${homeDir}/gamma/auth.json`,
                metaPath: `${homeDir}/gamma/meta.json`,
                configPath: null,
                duplicateAccountId: false,
              },
            ],
          }),
          refreshAllQuotas: async () => ({
            successes: [
              {
                name: "beta",
                account_id: "acct-beta",
                user_id: "user-beta",
                identity: "acct-beta:user-beta",
                plan_type: "pro",
                credits_balance: null,
                status: "ok",
                fetched_at: "2026-04-16T08:00:00.000Z",
                error_message: null,
                unlimited: true,
                five_hour: { used_percent: 36, window_seconds: 18_000, reset_at: "2026-04-16T10:00:00.000Z" },
                one_week: { used_percent: 27, window_seconds: 604_800, reset_at: "2026-04-18T10:00:00.000Z" },
              },
              {
                name: "alpha",
                account_id: "acct-alpha",
                user_id: "user-alpha",
                identity: "acct-alpha:user-alpha",
                plan_type: "plus",
                credits_balance: null,
                status: "ok",
                fetched_at: "2026-04-16T08:00:00.000Z",
                error_message: null,
                unlimited: false,
                five_hour: { used_percent: 18, window_seconds: 18_000, reset_at: "2026-04-16T11:00:00.000Z" },
                one_week: { used_percent: 42, window_seconds: 604_800, reset_at: "2026-04-19T11:00:00.000Z" },
              },
            ],
            failures: [{ name: "gamma", error: "quota failed" }],
            warnings: ["beta using cached quota"],
          }),
          getCurrentStatus: async () => ({
            exists: true,
            auth_mode: "chatgpt",
            account_id: "acct-alpha",
            user_id: "user-alpha",
            identity: "acct-alpha:user-alpha",
            matched_accounts: ["alpha"],
            managed: true,
            duplicate_match: false,
            warnings: [],
          }),
        } as never,
      });

      expect(snapshot.headerLine).toContain("codexm | current alpha");
      expect(snapshot.currentStatusLine).toBe("Current managed account: alpha");
      expect(snapshot.summaryLine).toContain("Accounts: 2/2 usable");
      expect(snapshot.poolLine).toContain("Available: bottleneck");
      expect(snapshot.warnings).toEqual(["beta using cached quota"]);
      expect(snapshot.failures).toEqual([{ name: "gamma", error: "quota failed" }]);
      expect(snapshot.accounts.map((account) => account.name)).toEqual(["beta", "alpha", "gamma"]);
      expect(snapshot.accounts[1]).toMatchObject({
        current: true,
        identityLabel: "acct...pha",
      });
      expect(snapshot.accounts[1]?.joinedAtLabel).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(snapshot.accounts[1]?.lastSwitchedAtLabel).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(snapshot.accounts[1]?.detailLines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Joined: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
          expect.stringMatching(/^Switched: .*ago\)$/),
          expect.stringMatching(/^Next reset: .*\((?:in .+|.+ ago|now)\)$/),
        ]),
      );
      expect(snapshot.accounts[1]?.nextResetLabel).toMatch(/^(?:now|[0-9.]+[mhd])$/);
      expect(snapshot.accounts[0]).toMatchObject({
        planLabel: "pro",
        emailLabel: "beta@example.com",
        refreshStatusLabel: "ok",
      });
      expect(snapshot.accounts[2]).toMatchObject({
        refreshStatusLabel: "error",
        reasonLabel: "quota failed",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("builds a cached dashboard snapshot from local quota metadata without refreshing", async () => {
    const homeDir = await createTempHome();

    try {
      const snapshot = await buildCachedAccountDashboardSnapshot({
        store: {
          paths: {
            codexTeamDir: `${homeDir}/.codex-team`,
          },
          listAccounts: async () => ({
            warnings: [],
            accounts: [
              {
                name: "alpha",
                auth_mode: "chatgpt",
                account_id: "acct-alpha",
                user_id: "user-alpha",
                identity: "acct-alpha:user-alpha",
                email: "alpha@example.com",
                created_at: "2026-03-18T04:30:00.000Z",
                updated_at: "2026-04-16T05:23:00.000Z",
                last_switched_at: "2026-04-16T05:24:00.000Z",
                quota: {
                  status: "ok",
                  plan_type: "plus",
                  fetched_at: "2026-04-16T08:00:00.000Z",
                  five_hour: { used_percent: 18, window_seconds: 18_000, reset_at: "2026-04-16T11:00:00.000Z" },
                  one_week: { used_percent: 42, window_seconds: 604_800, reset_at: "2026-04-19T11:00:00.000Z" },
                },
                authPath: `${homeDir}/alpha/auth.json`,
                metaPath: `${homeDir}/alpha/meta.json`,
                configPath: null,
                duplicateAccountId: false,
              },
              {
                name: "beta",
                auth_mode: "chatgpt",
                account_id: "acct-beta",
                user_id: "user-beta",
                identity: "acct-beta:user-beta",
                email: "beta@example.com",
                created_at: "2026-03-19T01:00:00.000Z",
                updated_at: "2026-04-16T05:20:00.000Z",
                last_switched_at: "2026-04-15T02:10:00.000Z",
                quota: {
                  status: "stale",
                  plan_type: "pro",
                  fetched_at: "2026-04-16T08:00:00.000Z",
                  error_message: "refresh failed",
                  five_hour: { used_percent: 36, window_seconds: 18_000, reset_at: "2026-04-16T10:00:00.000Z" },
                  one_week: { used_percent: 27, window_seconds: 604_800, reset_at: "2026-04-18T10:00:00.000Z" },
                },
                authPath: `${homeDir}/beta/auth.json`,
                metaPath: `${homeDir}/beta/meta.json`,
                configPath: null,
                duplicateAccountId: false,
              },
            ],
          }),
          getCurrentStatus: async () => ({
            exists: true,
            auth_mode: "chatgpt",
            account_id: "acct-alpha",
            user_id: "user-alpha",
            identity: "acct-alpha:user-alpha",
            matched_accounts: ["alpha"],
            managed: true,
            duplicate_match: false,
            warnings: [],
          }),
        } as never,
      });

      expect(snapshot.headerLine).toContain("codexm | current alpha");
      expect(snapshot.summaryLine).toContain("Accounts: 1/2 usable");
      expect(snapshot.accounts.map((account) => account.name)).toEqual(["alpha", "beta"]);
      expect(snapshot.accounts[1]).toMatchObject({
        emailLabel: "beta@example.com",
        refreshStatusLabel: "stale",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
