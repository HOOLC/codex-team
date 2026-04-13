import { describe, expect, test } from "@rstest/core";

import {
  describeWatchAutoSwitchEvent,
  describeWatchAutoSwitchSkippedEvent,
  describeWatchQuotaEvent,
  describeWatchStatusEvent,
} from "../src/watch-output.js";

describe("watch-output", () => {
  test("renders structured quota lines for usable quota", () => {
    expect(
      describeWatchQuotaEvent("alpha", {
        name: "alpha",
        account_id: "acct-1",
        user_id: null,
        identity: "id-1",
        plan_type: "plus",
        available: "available",
        refresh_status: "ok",
        fetched_at: "2026-04-13T00:00:00.000Z",
        credits_balance: 1,
        unlimited: false,
        error_message: null,
        five_hour: {
          used_percent: 20,
          window_seconds: 18_000,
          reset_at: "2026-04-13T05:00:00.000Z",
        },
        one_week: {
          used_percent: 10,
          window_seconds: 604_800,
          reset_at: "2026-04-20T00:00:00.000Z",
        },
      }),
    ).toBe('quota account="alpha" usage=available 5H=80% left 1W=90% left');
  });

  test("renders unavailable quota lines without percent fields", () => {
    expect(describeWatchQuotaEvent("alpha", null)).toBe('quota account="alpha" status=unavailable');
  });

  test("renders reconnect and auto-switch events", () => {
    expect(
      describeWatchStatusEvent("alpha", {
        type: "disconnected",
        attempt: 2,
        error: "socket closed",
      }),
    ).toBe('reconnect-lost account="alpha" attempt=2 error="socket closed"');

    expect(describeWatchAutoSwitchEvent("alpha", "beta", ["warn"])).toBe(
      'auto-switch from="alpha" to="beta" warnings=1',
    );

    expect(describeWatchAutoSwitchSkippedEvent("beta", "lock-busy")).toBe(
      'auto-switch-skipped account="beta" reason=lock-busy',
    );
  });
});
