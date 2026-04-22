import { describe, expect, test } from "@rstest/core";

import { formatAccountListDisplayName, formatAccountListMarkers } from "../src/account-list-display.js";

describe("account list display", () => {
  test("adds stale and protected tags in the shared list name formatter", () => {
    expect(formatAccountListDisplayName({
      name: "beta",
      refreshStatus: "stale",
      autoSwitchEligible: false,
    })).toBe("beta [stale] [P]");
  });

  test("formats shared list markers for cli and tui rows", () => {
    expect(formatAccountListMarkers({ current: true })).toBe("*  ");
    expect(formatAccountListMarkers({ current: true, proxyUpstreamActive: true })).toBe("*@ ");
    expect(formatAccountListMarkers({ selected: true, current: true, proxyUpstreamActive: true })).toBe(">*@ ");
  });
});
