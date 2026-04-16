import { describe, expect, test } from "@rstest/core";

import {
  appendWatchQuotaHistory,
  computeWatchEtaContext,
  computeWatchHistoryEta,
  computeWatchObservedRatioDiagnostics,
  createWatchHistoryStore,
} from "../src/watch/history.js";
import type {
  WatchHistoryRecord,
  WatchHistoryTargetSnapshot,
} from "../src/watch/history.js";
import { cleanupTempHome, createTempHome } from "./test-helpers.js";

function makeWindow(used_percent: number, reset_at: string) {
  return {
    used_percent,
    window_seconds: 18_000,
    reset_at,
  };
}

function makeRecord(
  recorded_at: string,
  overrides: Partial<WatchHistoryRecord> = {},
): WatchHistoryRecord {
  return {
    recorded_at,
    scope_kind: "global",
    scope_id: null,
    account_name: "main",
    account_id: "acct-main",
    identity: "acct-main:user-main",
    plan_type: "plus",
    available: "available",
    five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
    one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
    source: "watch",
    ...overrides,
  };
}

function makeTarget(
  overrides: Partial<WatchHistoryTargetSnapshot> = {},
): WatchHistoryTargetSnapshot {
  return {
    plan_type: "plus",
    available: "available",
    five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
    one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("watch history eta", () => {
  test("dedupes noisy writes and hides records older than 14 days", async () => {
    const homeDir = await createTempHome();
    const store = createWatchHistoryStore(`${homeDir}/.codex-team`);

    try {
      const oldRecord = makeRecord("2026-03-20T10:00:00.000Z");
      const freshRecord = makeRecord("2026-04-10T10:00:00.000Z");

      expect(
        await appendWatchQuotaHistory(store, oldRecord, new Date("2026-03-20T10:00:00.000Z")),
      ).toBe(true);
      expect(
        await appendWatchQuotaHistory(store, freshRecord, new Date("2026-04-10T10:00:00.000Z")),
      ).toBe(true);
      expect(
        await appendWatchQuotaHistory(store, freshRecord, new Date("2026-04-10T10:00:30.000Z")),
      ).toBe(false);

      const history = await store.read(new Date("2026-04-10T10:01:00.000Z"));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        recorded_at: "2026-04-10T10:00:00.000Z",
        source: "watch",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("converts 5H usage into 1W units before ETA math", () => {
    const history = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(45, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        five_hour: makeWindow(90, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(46, "2026-04-15T00:00:00.000Z"),
      }),
    ];

    const result = computeWatchHistoryEta(history, makeTarget(), new Date("2026-04-08T11:00:00.000Z"));

    expect(result).toMatchObject({
      status: "ok",
      rate_1w_units_per_hour: 4.5,
      remaining_5h: 40,
      remaining_1w: 50,
      remaining_5h_eq_1w: 6,
      bottleneck_remaining: 6,
      bottleneck_window: "5h_eq_1w",
      etaHours: 1.33,
    });
  });

  test("uses plan capacity profiles for pro and prolite normalization", () => {
    const proHistory = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        plan_type: "pro",
        five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        plan_type: "pro",
        five_hour: makeWindow(70, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(52, "2026-04-15T00:00:00.000Z"),
      }),
    ];

    const proResult = computeWatchHistoryEta(
      proHistory,
      makeTarget({
        plan_type: "pro",
        five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
      }),
      new Date("2026-04-08T11:00:00.000Z"),
    );

    expect(proResult).toMatchObject({
      status: "ok",
      rate_1w_units_per_hour: 16.67,
      remaining_5h: 40,
      remaining_1w: 416.67,
      remaining_5h_eq_1w: 60,
      bottleneck_remaining: 60,
      bottleneck_window: "5h_eq_1w",
      etaHours: 3.6,
    });

    const proliteHistory = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        plan_type: "prolite",
        five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        plan_type: "prolite",
        five_hour: makeWindow(70, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(52, "2026-04-15T00:00:00.000Z"),
      }),
    ];

    const proliteResult = computeWatchHistoryEta(
      proliteHistory,
      makeTarget({
        plan_type: "prolite",
        five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
      }),
      new Date("2026-04-08T11:00:00.000Z"),
    );

    expect(proliteResult).toMatchObject({
      status: "ok",
      rate_1w_units_per_hour: 8.33,
      remaining_5h: 40,
      remaining_1w: 208.33,
      remaining_5h_eq_1w: 30,
      bottleneck_remaining: 30,
      bottleneck_window: "5h_eq_1w",
      etaHours: 3.6,
    });
  });

  test("chooses the tighter bottleneck window for ETA", () => {
    const history = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(70, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        five_hour: makeWindow(80, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(90, "2026-04-15T00:00:00.000Z"),
      }),
    ];

    const result = computeWatchHistoryEta(
      history,
      makeTarget({
        five_hour: makeWindow(10, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(92, "2026-04-15T00:00:00.000Z"),
      }),
      new Date("2026-04-08T11:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "ok",
      rate_1w_units_per_hour: 20,
      remaining_5h_eq_1w: 13.5,
      remaining_1w: 8,
      bottleneck_remaining: 8,
      bottleneck_window: "1w",
      etaHours: 0.4,
    });
  });

  test("reports insufficient_history when there is only one usable sample", () => {
    const result = computeWatchHistoryEta(
      [
        makeRecord("2026-04-08T10:00:00.000Z", {
          five_hour: makeWindow(90, "2026-04-08T12:00:00.000Z"),
          one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
        }),
      ],
      makeTarget(),
      new Date("2026-04-08T11:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "insufficient_history",
    });
  });

  test("does not mix rate history across account switches", () => {
    const history = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        account_name: "alpha",
        account_id: "acct-alpha",
        identity: "acct-alpha:user-alpha",
        five_hour: makeWindow(10, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        account_name: "beta",
        account_id: "acct-beta",
        identity: "acct-beta:user-beta",
        five_hour: makeWindow(80, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(40, "2026-04-15T00:00:00.000Z"),
      }),
    ];

    const result = computeWatchHistoryEta(history, makeTarget(), new Date("2026-04-08T11:00:00.000Z"));

    expect(result).toMatchObject({
      status: "insufficient_history",
      rate_1w_units_per_hour: null,
    });
  });

  test("uses cumulative delta across a continuous burn segment", () => {
    const history = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        five_hour: makeWindow(10, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T10:10:00.000Z", {
        five_hour: makeWindow(11, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T10:20:00.000Z", {
        five_hour: makeWindow(12, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T10:30:00.000Z", {
        five_hour: makeWindow(13, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T10:40:00.000Z", {
        five_hour: makeWindow(14, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T10:50:00.000Z", {
        five_hour: makeWindow(15, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        five_hour: makeWindow(18, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(11, "2026-04-15T00:00:00.000Z"),
      }),
    ];

    const result = computeWatchHistoryEta(history, makeTarget(), new Date("2026-04-08T11:00:00.000Z"));

    expect(result).toMatchObject({
      status: "ok",
      rate_1w_units_per_hour: 1.2,
      remaining_5h_eq_1w: 6,
      etaHours: 5,
    });
  });

  test("treats reset_at jitter within one minute as the same continuous segment", () => {
    const history = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        five_hour: makeWindow(10, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T10:30:00.000Z", {
        five_hour: makeWindow(14, "2026-04-08T12:00:45.000Z"),
        one_week: makeWindow(11, "2026-04-15T00:00:30.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        five_hour: makeWindow(18, "2026-04-08T12:00:30.000Z"),
        one_week: makeWindow(12, "2026-04-15T00:00:15.000Z"),
      }),
    ];

    const result = computeWatchHistoryEta(history, makeTarget(), new Date("2026-04-08T11:00:00.000Z"));

    expect(result).toMatchObject({
      status: "ok",
      rate_1w_units_per_hour: 2,
      remaining_5h_eq_1w: 6,
      etaHours: 3,
    });
  });

  test("breaks a segment when used percent rolls back after a reset", () => {
    const history = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        five_hour: makeWindow(90, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(40, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T10:30:00.000Z", {
        five_hour: makeWindow(95, "2026-04-08T12:00:30.000Z"),
        one_week: makeWindow(41, "2026-04-15T00:00:30.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        five_hour: makeWindow(5, "2026-04-08T17:00:00.000Z"),
        one_week: makeWindow(42, "2026-04-15T00:00:45.000Z"),
      }),
    ];

    const result = computeWatchHistoryEta(history, makeTarget(), new Date("2026-04-08T11:00:00.000Z"));

    expect(result).toMatchObject({
      status: "ok",
      rate_1w_units_per_hour: 2,
      remaining_5h_eq_1w: 6,
      etaHours: 3,
    });
  });

  test("reports idle when the history has no observed usage change", () => {
    const history = [
      makeRecord("2026-04-08T10:00:00.000Z", {
        five_hour: makeWindow(70, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
      }),
      makeRecord("2026-04-08T11:00:00.000Z", {
        five_hour: makeWindow(70, "2026-04-08T12:00:00.000Z"),
        one_week: makeWindow(50, "2026-04-15T00:00:00.000Z"),
      }),
    ];

    const result = computeWatchHistoryEta(history, makeTarget(), new Date("2026-04-08T11:00:00.000Z"));

    expect(result).toMatchObject({
      status: "idle",
      rate_1w_units_per_hour: 0,
    });
  });

  test("computes observed ratio diagnostics by plan only", () => {
    const history = [
      makeRecord("2026-04-13T09:00:00.000Z", {
        account_name: "plus-main",
        identity: "acct-plus:user-plus",
        five_hour: makeWindow(10, "2026-04-13T12:00:00.000Z"),
        one_week: makeWindow(10, "2026-04-20T00:00:00.000Z"),
      }),
      makeRecord("2026-04-13T09:20:00.000Z", {
        account_name: "plus-main",
        identity: "acct-plus:user-plus",
        five_hour: makeWindow(16, "2026-04-13T12:00:30.000Z"),
        one_week: makeWindow(11, "2026-04-20T00:00:30.000Z"),
      }),
      makeRecord("2026-04-13T10:00:00.000Z", {
        account_name: "plus-main",
        identity: "acct-plus:user-plus",
        five_hour: makeWindow(0, "2026-04-13T17:00:00.000Z"),
        one_week: makeWindow(11, "2026-04-20T00:01:00.000Z"),
      }),
      makeRecord("2026-04-13T10:20:00.000Z", {
        account_name: "plus-main",
        identity: "acct-plus:user-plus",
        five_hour: makeWindow(7, "2026-04-13T17:00:30.000Z"),
        one_week: makeWindow(12, "2026-04-20T00:01:30.000Z"),
      }),
      makeRecord("2026-04-13T11:00:00.000Z", {
        account_name: "plus-main",
        identity: "acct-plus:user-plus",
        five_hour: makeWindow(0, "2026-04-13T22:00:00.000Z"),
        one_week: makeWindow(12, "2026-04-20T00:02:00.000Z"),
      }),
      makeRecord("2026-04-13T11:20:00.000Z", {
        account_name: "plus-main",
        identity: "acct-plus:user-plus",
        five_hour: makeWindow(6, "2026-04-13T22:00:45.000Z"),
        one_week: makeWindow(13, "2026-04-20T00:02:30.000Z"),
      }),
    ];

    const diagnostics = computeWatchObservedRatioDiagnostics(
      history,
      new Date("2026-04-13T12:00:00.000Z"),
    );

    expect(diagnostics).toContainEqual({
      dimension: "plan",
      key: "plus",
      sample_count: 3,
      observed_mean_raw_ratio: 6.33,
      observed_weighted_raw_ratio: 6.33,
      variance: 0.22,
      expected_raw_ratio: 6.67,
      relative_delta: -0.05,
      warning: false,
    });
    expect(diagnostics).toHaveLength(1);
  });

  test("supports the store-backed ETA wrapper", async () => {
    const homeDir = await createTempHome();
    const store = createWatchHistoryStore(`${homeDir}/.codex-team`);

    try {
      await appendWatchQuotaHistory(
        store,
        makeRecord("2026-04-08T10:00:00.000Z", {
          five_hour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
          one_week: makeWindow(45, "2026-04-15T00:00:00.000Z"),
        }),
      );
      await appendWatchQuotaHistory(
        store,
        makeRecord("2026-04-08T11:00:00.000Z", {
          five_hour: makeWindow(90, "2026-04-08T12:00:00.000Z"),
          one_week: makeWindow(46, "2026-04-15T00:00:00.000Z"),
        }),
      );

      const result = await computeWatchEtaContext(
        store,
        {
          planType: "plus",
          available: "available",
          fiveHour: makeWindow(60, "2026-04-08T12:00:00.000Z"),
          oneWeek: makeWindow(50, "2026-04-15T00:00:00.000Z"),
        },
        "2026-04-08T11:00:00.000Z",
      );

      expect(result).toMatchObject({
        status: "ok",
        rateIn1wUnitsPerHour: 4.5,
        bottleneck: "five_hour",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
