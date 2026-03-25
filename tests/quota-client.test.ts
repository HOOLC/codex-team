import { describe, expect, test } from "@rstest/core";

import { extractChatGPTAuth, fetchQuotaSnapshot } from "../src/quota-client.js";
import {
  createApiKeyPayload,
  createAuthPayload,
  installFetchMock,
  jsonResponse,
  textResponse,
} from "./test-helpers.js";

describe("quota client", () => {
  test("extracts account metadata from JWT claims", () => {
    const snapshot = createAuthPayload("acct-primary", "chatgpt", "pro");
    const extracted = extractChatGPTAuth(snapshot);

    expect(extracted.accountId).toBe("acct-primary");
    expect(extracted.planType).toBe("pro");
    expect(extracted.supported).toBe(true);
  });

  test("fetches credits from the wham usage endpoint", async () => {
    const snapshot = createAuthPayload("acct-primary", "chatgpt", "plus");
    const restoreFetch = installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/backend-api/wham/usage")) {
        return jsonResponse({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 8,
              limit_window_seconds: 18_000,
              reset_after_seconds: 1_234,
              reset_at: 1_773_868_641,
            },
            secondary_window: {
              used_percent: 98,
              limit_window_seconds: 604_800,
              reset_after_seconds: 35_833,
              reset_at: 1_773_890_040,
            },
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: "42",
          },
        });
      }

      return textResponse("not found", 404);
    });

    try {
      const result = await fetchQuotaSnapshot(snapshot, {
        homeDir: "/tmp/codex-team-test-home",
      });

      expect(result.quota).toMatchObject({
        status: "ok",
        plan_type: "plus",
        credits_balance: 42,
        five_hour: {
          used_percent: 8,
          window_seconds: 18_000,
          reset_after_seconds: 1_234,
          reset_at: "2026-03-18T21:17:21.000Z",
        },
        one_week: {
          used_percent: 98,
          window_seconds: 604_800,
          reset_after_seconds: 35_833,
          reset_at: "2026-03-19T03:14:00.000Z",
        },
      });
      expect(result.authSnapshot.tokens?.account_id).toBe("acct-primary");
    } finally {
      restoreFetch();
    }
  });

  test("refreshes tokens and retries on unauthorized usage fetch", async () => {
    const snapshot = createAuthPayload("acct-primary", "chatgpt", "plus");
    let usageAttempts = 0;

    const restoreFetch = installFetchMock(async (input, init) => {
      const url = String(input);

      if (url.endsWith("/backend-api/wham/usage")) {
        usageAttempts += 1;
        if (usageAttempts === 1) {
          return textResponse("unauthorized", 401);
        }

        return jsonResponse({
          plan_type: "plus",
          credits: {
            has_credits: true,
            unlimited: false,
            balance: "9",
          },
        });
      }

      if (url.endsWith("/oauth/token")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          access_token: "refreshed-access-token",
          id_token: snapshot.tokens?.id_token,
          refresh_token: "refreshed-refresh-token",
        });
      }

      return textResponse("not found", 404);
    });

    try {
      const result = await fetchQuotaSnapshot(snapshot, {
        homeDir: "/tmp/codex-team-test-home",
      });

      expect(usageAttempts).toBe(2);
      expect(result.quota.credits_balance).toBe(9);
      expect(result.authSnapshot.tokens?.access_token).toBe("refreshed-access-token");
      expect(result.authSnapshot.tokens?.refresh_token).toBe("refreshed-refresh-token");
    } finally {
      restoreFetch();
    }
  });

  test('treats "null" credits balances as missing instead of failing', async () => {
    const snapshot = createAuthPayload("acct-null-balance", "chatgpt", "plus");
    const restoreFetch = installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/backend-api/wham/usage")) {
        return jsonResponse({
          plan_type: "plus",
          credits: {
            has_credits: false,
            unlimited: false,
            balance: "null",
          },
        });
      }

      return textResponse("not found", 404);
    });

    try {
      const result = await fetchQuotaSnapshot(snapshot, {
        homeDir: "/tmp/codex-team-test-home",
      });

      expect(result.quota).toMatchObject({
        status: "ok",
        plan_type: "plus",
        credits_balance: undefined,
        unlimited: false,
      });
    } finally {
      restoreFetch();
    }
  });

  test("marks apikey auth snapshots as unsupported for quota refresh", async () => {
    const snapshot = createApiKeyPayload("sk-test-primary");

    const result = await fetchQuotaSnapshot(snapshot, {
      homeDir: "/tmp/codex-team-test-home",
    });

    expect(result.quota).toMatchObject({
      status: "unsupported",
      plan_type: undefined,
    });
    expect(result.authSnapshot.OPENAI_API_KEY).toBe("sk-test-primary");
  });
});
