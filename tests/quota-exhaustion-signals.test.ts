import { describe, expect, test } from "@rstest/core";

import {
  hasExhaustedRateLimitSignal,
  hasQuotaExhaustionSignal,
} from "../src/quota-exhaustion-signals.js";

describe("quota exhaustion signals", () => {
  test("detects the live codex snake_case exhaustion payload shape", () => {
    expect(hasQuotaExhaustionSignal({
      error: {
        codex_error_info: "usage_limit_exceeded",
        message: "You've hit your usage limit. Try again later.",
      },
    })).toBe(true);
  });

  test("detects structured quota exhaustion codes and messages", () => {
    expect(hasQuotaExhaustionSignal({
      error: {
        code: "insufficient_quota",
      },
    })).toBe(true);
    expect(hasQuotaExhaustionSignal({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
      },
    })).toBe(true);
    expect(hasQuotaExhaustionSignal({
      detail: "Request failed because you hit your usage limit for this workspace.",
    })).toBe(true);
  });

  test("detects app-server camelCase quota exhaustion payloads", () => {
    expect(hasQuotaExhaustionSignal({
      error: {
        codexErrorInfo: "usageLimitExceeded",
      },
    })).toBe(true);
  });

  test("detects exhausted rate-limit windows from either casing", () => {
    expect(hasExhaustedRateLimitSignal({
      rate_limit: {
        primary_window: {
          used_percent: 100,
        },
      },
    })).toBe(true);
    expect(hasExhaustedRateLimitSignal({
      rateLimit: {
        primaryWindow: {
          usedPercent: 100,
        },
      },
    })).toBe(true);
  });

  test("ignores unrelated structured errors", () => {
    expect(hasQuotaExhaustionSignal({
      error: {
        code: "not_found",
        message: "No such thread",
      },
    })).toBe(false);
  });
});
