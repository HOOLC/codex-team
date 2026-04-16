import { describe, expect, test } from "@rstest/core";

import {
  createInitialAccountDashboardState,
  renderAccountDashboardScreen,
  runAccountDashboardTui,
  type AccountDashboardSnapshot,
} from "../src/tui/index.js";
import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import { buildAccountDashboardSnapshot } from "../src/commands/tui.js";
import {
  cleanupTempHome,
  createTempHome,
} from "./test-helpers.js";
import {
  captureWritable,
  createDesktopLauncherStub,
  createInteractiveStdin,
  createInteractiveStdout,
} from "./cli-fixtures.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

function createSnapshot(currentName = "alpha"): AccountDashboardSnapshot {
  return {
    headerLine: `codexm | current ${currentName} | 2/3 usable | updated 13:24`,
    currentStatusLine: `Current managed account: ${currentName}`,
    summaryLine: "Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, pro x1",
    poolLine: "Available: bottleneck 0.55 | 5H->1W 0.82 | 1W 0.55 (plus 1W)",
    warnings: ["beta using cached quota from 2026-04-15T08:00:00.000Z after refresh failed"],
    failures: [{ name: "gamma", error: "Failed to refresh quota for \"gamma\": 429" }],
    accounts: [
      {
        name: "alpha",
        planLabel: "plus",
        identityLabel: "acct-alpha:user-alpha",
        availabilityLabel: "available",
        current: currentName === "alpha",
        score: 88,
        scoreLabel: "88%",
        etaLabel: "8.2h",
        nextResetLabel: "04-16 19:30",
        fiveHourLabel: "18%",
        oneWeekLabel: "42%",
        authModeLabel: "chatgpt",
        accountIdLabel: "acct...pha",
        userIdLabel: "user...pha",
        joinedAtLabel: "2026-03-18 12:30",
        lastSwitchedAtLabel: "2026-04-16 13:24",
        fetchedAtLabel: "2026-04-16 13:23",
        refreshStatusLabel: "ok",
        bottleneckLabel: "1W",
        reasonLabel: "available",
        detailLines: [
          "Identity: acct-alpha:user-alpha",
          "Plan: plus",
          "Availability: available",
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
        score: 64,
        scoreLabel: "64%",
        etaLabel: "3.5h",
        nextResetLabel: "04-16 18:10",
        fiveHourLabel: "36%",
        oneWeekLabel: "27%",
        authModeLabel: "chatgpt",
        accountIdLabel: "acct...eta",
        userIdLabel: "user...eta",
        joinedAtLabel: "2026-03-20 09:00",
        lastSwitchedAtLabel: "2026-04-15 10:10",
        fetchedAtLabel: "2026-04-16 13:20",
        refreshStatusLabel: "stale",
        bottleneckLabel: "5H",
        reasonLabel: "cached quota after refresh failure",
        detailLines: [
          "Identity: acct-beta:user-beta",
          "Plan: pro",
          "Availability: available",
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
        score: 0,
        scoreLabel: "0%",
        etaLabel: "-",
        nextResetLabel: "04-17 09:00",
        fiveHourLabel: "100%",
        oneWeekLabel: "100%",
        authModeLabel: "chatgpt",
        accountIdLabel: "acct...mma",
        userIdLabel: "user...mma",
        joinedAtLabel: "2026-03-21 11:00",
        lastSwitchedAtLabel: "-",
        fetchedAtLabel: "2026-04-16 13:21",
        refreshStatusLabel: "error",
        bottleneckLabel: "-",
        reasonLabel: "quota refresh failed: 429",
        detailLines: [
          "Identity: acct-gamma:user-gamma",
          "Plan: plus",
          "Availability: blocked",
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
    expect(screen).toContain("NAME");
    expect(screen).toContain(">* beta");
    expect(screen).toContain("alpha");
    expect(screen).toContain("Joined: 2026-03-20 09:00");
    expect(screen).toContain("Fetched: 2026-04-16 13:20");
    expect(screen).toContain("Bottleneck: 5H");
    expect(screen).toContain("filter:");
    expect(screen).toContain("Enter switch");
    expect(screen).toContain("o codex");
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
      expect(stripAnsi(stdout.read())).toContain("codexm | current loading | 0/0 usable | updated -");
      expect(stderr.read()).toBe("");
    } finally {
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
        joinedAtLabel: "2026-03-18 12:30",
        lastSwitchedAtLabel: "2026-04-16 13:24",
      });
      expect(snapshot.accounts[0]).toMatchObject({
        planLabel: "pro",
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
});
