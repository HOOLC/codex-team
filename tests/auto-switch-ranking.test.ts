import { describe, expect, test } from "@rstest/core";

import type { AccountQuotaSummary } from "../src/account-store/index.js";
import { rankAutoSwitchCandidates } from "../src/cli/quota.js";

describe("auto switch ranking", () => {
  test("keeps candidates with only one quota window", () => {
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
        current_score: 12.8,
        score_1h: 12.8,
        remain_5h: 80,
        remain_1w: null,
        remain_5h_in_1w_units: 12.8,
        projected_5h_1h: 80,
        projected_5h_in_1w_units_1h: 12.8,
        five_hour_windows_per_week: 6.25,
      },
      {
        name: "beta",
        current_score: 6.4,
        score_1h: 6.4,
        remain_5h: 40,
        remain_1w: 30,
        remain_5h_in_1w_units: 6.4,
        projected_5h_1h: 40,
        projected_5h_in_1w_units_1h: 6.4,
        projected_1w_1h: 30,
        five_hour_windows_per_week: 6.25,
      },
    ]);
  });

  test("converts 5h remaining by plan-relative window size", () => {
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
        current_score: 12.8,
        score_1h: 12.8,
        remain_1w: 50,
        remain_5h_in_1w_units: 12.8,
        projected_5h_in_1w_units_1h: 12.8,
        projected_1w_1h: 50,
        five_hour_windows_per_week: 6.25,
      },
      {
        name: "team",
        current_score: 12.8,
        score_1h: 12.8,
        remain_1w: 50,
        remain_5h_in_1w_units: 12.8,
        projected_5h_in_1w_units_1h: 12.8,
        projected_1w_1h: 50,
        five_hour_windows_per_week: 6.25,
      },
    ]);
  });

  test("normalizes pro and prolite against plus capacity profiles", () => {
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

    const proliteAccount: AccountQuotaSummary = {
      ...plusAccount,
      name: "prolite",
      account_id: "acct-prolite",
      identity: "acct-prolite",
      plan_type: "prolite",
    };

    const proAccount: AccountQuotaSummary = {
      ...plusAccount,
      name: "pro",
      account_id: "acct-pro",
      identity: "acct-pro",
      plan_type: "pro",
    };

    expect(rankAutoSwitchCandidates([plusAccount, proliteAccount, proAccount])).toMatchObject([
      {
        name: "pro",
        current_score: 100,
        score_1h: 100,
        remain_5h: 80,
        remain_5h_in_1w_units: 100,
        remain_1w: 50,
        five_hour_windows_per_week: 6.66,
      },
      {
        name: "prolite",
        current_score: 50,
        score_1h: 50,
        remain_5h: 80,
        remain_5h_in_1w_units: 50,
        remain_1w: 50,
        five_hour_windows_per_week: 6.66,
      },
      {
        name: "plus",
        current_score: 12.8,
        score_1h: 12.8,
        remain_5h: 80,
        remain_5h_in_1w_units: 12.8,
        remain_1w: 50,
        five_hour_windows_per_week: 6.25,
      },
    ]);
  });

  test("prefers earlier reset when projected availability is higher", () => {
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
        current_score: 9.6,
        projected_5h_1h: 96.67,
      },
      {
        name: "late-reset",
        remain_5h: 65,
        current_score: 10.4,
        projected_5h_1h: 65,
      },
    ]);
  });

  test("keeps a clearly better current score ahead of a near-reset zero balance", () => {
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
        used_percent: 50,
        window_seconds: 18_000,
        reset_at: "2026-04-08T04:30:00.000Z",
      },
      one_week: null,
    };

    expect(rankAutoSwitchCandidates([nearResetButEmpty, modestButAvailable])).toMatchObject([
      {
        name: "modest-available",
        current_score: 8,
        score_1h: 8,
      },
      {
        name: "near-reset-empty",
        current_score: 0,
        score_1h: 14.67,
      },
    ]);
  });

  test("prefers the earliest bottleneck reset instead of always checking 5h first", () => {
    const weeklyBottleneckResetsSooner: AccountQuotaSummary = {
      name: "weekly-bottleneck-sooner",
      account_id: "acct-weekly-bottleneck-sooner",
      user_id: null,
      identity: "acct-weekly-bottleneck-sooner",
      plan_type: "plus",
      credits_balance: 1,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 20,
        window_seconds: 18_000,
        reset_at: "2026-04-08T06:00:00.000Z",
      },
      one_week: {
        used_percent: 90,
        window_seconds: 604_800,
        reset_at: "2026-04-08T02:00:00.000Z",
      },
    };

    const fiveHourBottleneckResetsLater: AccountQuotaSummary = {
      name: "five-hour-bottleneck-later",
      account_id: "acct-five-hour-bottleneck-later",
      user_id: null,
      identity: "acct-five-hour-bottleneck-later",
      plan_type: "plus",
      credits_balance: 1,
      status: "ok",
      fetched_at: "2026-04-08T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 20,
        window_seconds: 18_000,
        reset_at: "2026-04-08T03:00:00.000Z",
      },
      one_week: {
        used_percent: 90,
        window_seconds: 604_800,
        reset_at: "2026-04-08T07:00:00.000Z",
      },
    };

    expect(
      rankAutoSwitchCandidates([weeklyBottleneckResetsSooner, fiveHourBottleneckResetsLater]),
    ).toMatchObject([
      {
        name: "weekly-bottleneck-sooner",
        current_score: 10,
        score_1h: 10,
      },
      {
        name: "five-hour-bottleneck-later",
        current_score: 10,
        score_1h: 10,
      },
    ]);
  });
});
