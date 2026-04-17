import { describe, expect, test } from "@rstest/core";

import {
  createSnapshotMeta,
  getSnapshotIdentity,
  maskAccountId,
  parseAuthSnapshot,
  parseSnapshotMeta,
} from "../src/auth-snapshot.js";
import { createApiKeyPayload, createAuthPayload } from "./test-helpers.js";

describe("auth snapshot parsing", () => {
  test("parses a valid auth snapshot", () => {
    const payload = createAuthPayload("acct-primary");
    const snapshot = parseAuthSnapshot(JSON.stringify(payload));

    expect(snapshot.auth_mode).toBe("chatgpt");
    expect(snapshot.tokens?.account_id).toBe("acct-primary");
  });

  test("rejects a snapshot without auth_mode", () => {
    const payload = createAuthPayload("acct-primary") as Record<string, unknown>;
    delete payload.auth_mode;

    expect(() => parseAuthSnapshot(JSON.stringify(payload))).toThrow(/auth_mode/);
  });

  test("rejects unsupported auth modes in auth snapshots", () => {
    const payload = createAuthPayload("acct-primary", "chatgpt_auth_tokens");

    expect(() => parseAuthSnapshot(JSON.stringify(payload))).toThrow(/Unsupported auth_mode/);
  });

  test("parses an apikey auth snapshot and derives a stable identity", () => {
    const payload = createApiKeyPayload("sk-test-primary");
    const snapshot = parseAuthSnapshot(JSON.stringify(payload));
    const reparsed = parseAuthSnapshot(JSON.stringify(payload));

    expect(snapshot.auth_mode).toBe("apikey");
    expect(snapshot.OPENAI_API_KEY).toBe("sk-test-primary");
    expect(snapshot.tokens).toBeUndefined();
    expect(getSnapshotIdentity(snapshot)).toMatch(/^key_[0-9a-f]{16}$/);
    expect(getSnapshotIdentity(snapshot)).toBe(getSnapshotIdentity(reparsed));
  });

  test("derives a composite identity for chatgpt auth with account and user", () => {
    const payload = createAuthPayload("acct-primary", "chatgpt", "plus", "user-primary");
    const snapshot = parseAuthSnapshot(JSON.stringify(payload));

    expect(getSnapshotIdentity(snapshot)).toBe("acct-primary:user-primary");
  });

  test("falls back to account identity when chatgpt user claim is missing", () => {
    const payload = createAuthPayload("acct-primary");
    const snapshot = parseAuthSnapshot(JSON.stringify(payload));

    expect(getSnapshotIdentity(snapshot)).toBe("acct-primary");
  });

  test("falls back to user_id when chatgpt_user_id is missing", () => {
    const payload = createAuthPayload("acct-primary");
    const idTokenPayload = {
      iss: "https://auth.openai.com",
      aud: "app_codexm_tests",
      client_id: "app_codexm_tests",
      user_id: "user-fallback",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-primary",
        chatgpt_plan_type: "plus",
      },
    };
    const accessTokenPayload = {
      iss: "https://auth.openai.com",
      aud: "app_codexm_tests",
      client_id: "app_codexm_tests",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-primary",
        chatgpt_plan_type: "plus",
      },
    };
    payload.tokens = {
      ...payload.tokens,
      id_token: `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url")}.${Buffer.from(JSON.stringify(idTokenPayload), "utf8").toString("base64url")}.sig`,
      access_token: `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url")}.${Buffer.from(JSON.stringify(accessTokenPayload), "utf8").toString("base64url")}.sig`,
    };
    const snapshot = parseAuthSnapshot(JSON.stringify(payload));

    expect(getSnapshotIdentity(snapshot)).toBe("acct-primary:user-fallback");
  });

  test("creates metadata with a preserved created_at on overwrite", () => {
    const payload = createAuthPayload("acct-primary", "chatgpt", "plus", "user-primary");
    const created = createSnapshotMeta("main", payload, new Date("2026-03-18T00:00:00.000Z"));
    const overwritten = createSnapshotMeta(
      "main",
      payload,
      new Date("2026-03-19T00:00:00.000Z"),
      created.created_at,
    );

    expect(overwritten.created_at).toBe(created.created_at);
    expect(overwritten.updated_at).toBe("2026-03-19T00:00:00.000Z");
    expect(overwritten.last_switched_at).toBe(null);
    expect(overwritten.account_id).toBe("acct-primary");
    expect(overwritten.user_id).toBe("user-primary");
    expect(overwritten.quota.status).toBe("stale");
  });

  test("parses legacy metadata without quota and defaults to stale", () => {
    const parsed = parseSnapshotMeta(
      JSON.stringify({
        name: "main",
        auth_mode: "chatgpt",
        account_id: "acct-primary",
        user_id: "user-primary",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
        last_switched_at: null,
      }),
    );

    expect(parsed.quota.status).toBe("stale");
    expect(parsed.account_id).toBe("acct-primary");
    expect(parsed.user_id).toBe("user-primary");
  });

  test("rejects unsupported auth modes in account metadata", () => {
    expect(() =>
      parseSnapshotMeta(
        JSON.stringify({
          name: "main",
          auth_mode: "chatgpt_auth_tokens",
          account_id: "acct-primary",
          created_at: "2026-03-18T00:00:00.000Z",
          updated_at: "2026-03-18T00:00:00.000Z",
          last_switched_at: null,
          quota: {
            status: "stale",
          },
        }),
      ),
    ).toThrow(/Unsupported auth_mode/);
  });

  test("parses auto switch eligibility from account metadata and defaults missing values to true", () => {
    const defaulted = parseSnapshotMeta(
      JSON.stringify({
        name: "main",
        auth_mode: "chatgpt",
        account_id: "acct-primary",
        user_id: "user-primary",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
        last_switched_at: null,
        quota: {
          status: "stale",
        },
      }),
    );
    expect(defaulted.auto_switch_eligible).toBe(true);

    const explicitFalse = parseSnapshotMeta(
      JSON.stringify({
        name: "main",
        auth_mode: "chatgpt",
        account_id: "acct-primary",
        user_id: "user-primary",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
        last_switched_at: null,
        auto_switch_eligible: false,
        quota: {
          status: "stale",
        },
      }),
    );
    expect(explicitFalse.auto_switch_eligible).toBe(false);
  });

  test("masks long account identities with a shorter prefix and suffix", () => {
    expect(maskAccountId("acct-primary:user-primary")).toBe("acct...ary");
  });
});
