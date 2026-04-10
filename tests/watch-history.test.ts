import { describe, expect, test } from "@rstest/core";

import {
  appendWatchQuotaHistory,
  computeWatchEtaContext,
  computeWatchHistoryEta,
  createWatchHistoryStore,
} from "../src/watch-history.js";
import type {
  WatchHistoryRecord,
  WatchHistoryTargetSnapshot,
} from "../src/watch-history.js";
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
      rate_1w_units_per_hour: 3.75,
      remaining_5h: 40,
      remaining_1w: 50,
      remaining_5h_eq_1w: 5,
      bottleneck_remaining: 5,
      bottleneck_window: "5h_eq_1w",
      etaHours: 1.33,
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
      remaining_5h_eq_1w: 11.25,
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
        rateIn1wUnitsPerHour: 3.75,
        bottleneck: "five_hour",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
