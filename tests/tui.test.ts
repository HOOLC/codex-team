import { describe, expect, test } from "@rstest/core";

import {
  createInitialAccountDashboardState,
  renderAccountDashboardScreen,
  type AccountDashboardSnapshot,
} from "../src/tui/index.js";
import { buildAccountDashboardSnapshot } from "../src/commands/tui.js";
import {
  cleanupTempHome,
  createTempHome,
} from "./test-helpers.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

function createSnapshot(currentName = "alpha"): AccountDashboardSnapshot {
  return {
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

    expect(screen).toContain("codexm  account dashboard");
    expect(screen).toContain("Current managed account: beta");
    expect(screen).toContain("Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, pro x1");
    expect(screen).toContain("NAME");
    expect(screen).toContain(">* beta");
    expect(screen).toContain("alpha");
    expect(screen).toContain("Plan: pro");
    expect(screen).toContain("Next reset: 04-16 18:10");
    expect(screen).toContain("filter:");
    expect(screen).toContain("j/k move");
    expect(screen).toContain("Enter switch");
  });

  test("renders an empty-state dashboard when no saved accounts exist", () => {
    const screen = stripAnsi(
      renderAccountDashboardScreen({
        snapshot: {
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

  test("builds a ranked dashboard snapshot from refreshed quota data", async () => {
    const homeDir = await createTempHome();

    try {
      const snapshot = await buildAccountDashboardSnapshot({
        store: {
          paths: {
            codexTeamDir: `${homeDir}/.codex-team`,
          },
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

      expect(snapshot.currentStatusLine).toBe("Current managed account: alpha");
      expect(snapshot.summaryLine).toContain("Accounts: 2/2 usable");
      expect(snapshot.poolLine).toContain("Available: bottleneck");
      expect(snapshot.warnings).toEqual(["beta using cached quota"]);
      expect(snapshot.failures).toEqual([{ name: "gamma", error: "quota failed" }]);
      expect(snapshot.accounts.map((account) => account.name)).toEqual(["beta", "alpha"]);
      expect(snapshot.accounts[1]).toMatchObject({
        current: true,
        identityLabel: "acct...pha",
      });
      expect(snapshot.accounts[0]).toMatchObject({
        planLabel: "pro",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
