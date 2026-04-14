import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import { parseAuthSnapshot } from "../src/auth-snapshot.js";
import { extractChatGPTAuth } from "../src/quota-client.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  readCurrentConfig,
  textResponse,
  writeCurrentConfig,
  writeCurrentApiKeyAuth,
  writeCurrentAuth,
} from "./test-helpers.js";

describe("AccountStore", () => {
  test("saves, lists, matches, renames and removes managed accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-one");

      await store.saveCurrentAccount("main");
      await writeCurrentAuth(homeDir, "acct-two");
      await store.saveCurrentAccount("shadow");
      const listBeforeRename = await store.listAccounts();

      expect(listBeforeRename.accounts).toHaveLength(2);
      expect(listBeforeRename.accounts.every((account) => !account.duplicateAccountId)).toBe(true);

      const current = await store.getCurrentStatus();
      expect(current.exists).toBe(true);
      expect(current.duplicate_match).toBe(false);
      expect(current.matched_accounts).toEqual(["shadow"]);

      const renamed = await store.renameAccount("shadow", "backup");
      expect(renamed.name).toBe("backup");

      await store.removeAccount("backup");
      const listAfterRemove = await store.listAccounts();
      expect(listAfterRemove.accounts.map((account) => account.name)).toEqual(["main"]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("rejects saving a different account name with a duplicate identity", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-one");
      await store.saveCurrentAccount("main");

      await writeCurrentAuth(homeDir, "acct-one");
      await expect(store.saveCurrentAccount("shadow")).rejects.toThrow(
        'Identity acct-one is already managed by "main".',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("allows saving different chatgpt users under the same account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-shared", "chatgpt", "plus", "user-alpha");
      await store.saveCurrentAccount("alpha");

      await writeCurrentAuth(homeDir, "acct-shared", "chatgpt", "plus", "user-beta");
      await store.saveCurrentAccount("beta");

      const listed = await store.listAccounts();
      expect(listed.accounts.map((account) => ({
        account_id: account.account_id,
        user_id: account.user_id,
        identity: account.identity,
      }))).toEqual([
        {
          account_id: "acct-shared",
          user_id: "user-alpha",
          identity: "acct-shared:user-alpha",
        },
        {
          account_id: "acct-shared",
          user_id: "user-beta",
          identity: "acct-shared:user-beta",
        },
      ]);

      const current = await store.getCurrentStatus();
      expect(current.account_id).toBe("acct-shared");
      expect(current.user_id).toBe("user-beta");
      expect(current.identity).toBe("acct-shared:user-beta");
      expect(current.matched_accounts).toEqual(["beta"]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("auto-migrates legacy chatgpt metadata to composite identity", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-legacy", "chatgpt", "plus", "user-legacy");
      await store.saveCurrentAccount("legacy");

      const metaPath = join(homeDir, ".codex-team", "accounts", "legacy", "meta.json");
      const legacyMeta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      legacyMeta.account_id = "acct-legacy";
      await writeFile(metaPath, `${JSON.stringify(legacyMeta, null, 2)}\n`);

      const listed = await store.listAccounts();
      expect(listed.warnings).toEqual([]);
      expect(listed.accounts).toHaveLength(1);
      expect(listed.accounts[0]?.account_id).toBe("acct-legacy");
      expect(listed.accounts[0]?.user_id).toBe("user-legacy");
      expect(listed.accounts[0]?.identity).toBe("acct-legacy:user-legacy");

      const migratedMeta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      expect(migratedMeta.account_id).toBe("acct-legacy");
      expect(migratedMeta.user_id).toBe("user-legacy");
      expect(migratedMeta.created_at).toBe(legacyMeta.created_at);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switches accounts, creates a backup, updates metadata, and keeps secure permissions", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-alpha");
      await store.saveCurrentAccount("alpha");

      await writeCurrentAuth(homeDir, "acct-beta");
      await store.saveCurrentAccount("beta");

      const switchResult = await store.switchAccount("alpha");
      expect(switchResult.account.name).toBe("alpha");
      expect(switchResult.backup_path).toBe(join(homeDir, ".codex-team", "backups", "last-active-auth.json"));

      const current = await readCurrentAuth(homeDir);
      expect(current.tokens?.account_id).toBe("acct-alpha");

      const backupRaw = await readFile(
        join(homeDir, ".codex-team", "backups", "last-active-auth.json"),
        "utf8",
      );
      expect(backupRaw).toContain("acct-beta");

      const stateRaw = await readFile(join(homeDir, ".codex-team", "state.json"), "utf8");
      expect(stateRaw).toContain('"last_switched_account": "alpha"');

      const alphaMetaStat = await stat(
        join(homeDir, ".codex-team", "accounts", "alpha", "meta.json"),
      );
      const alphaAuthStat = await stat(
        join(homeDir, ".codex-team", "accounts", "alpha", "auth.json"),
      );
      expect(alphaMetaStat.mode & 0o777).toBe(0o600);
      expect(alphaAuthStat.mode & 0o777).toBe(0o600);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("doctor reports invalid permissions", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-one");
      await store.saveCurrentAccount("main");

      const metaPath = join(homeDir, ".codex-team", "accounts", "main", "meta.json");
      await chmod(metaPath, 0o644);

      const report = await store.doctor();
      expect(report.healthy).toBe(false);
      expect(report.issues.some((issue) => issue.includes('Account "main" metadata permissions'))).toBe(true);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("updates the currently managed account snapshot", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-update");
      await store.saveCurrentAccount("main");

      await writeCurrentAuth(homeDir, "acct-update", "chatgpt", "pro");
      const result = await store.updateCurrentManagedAccount();

      expect(result.account.name).toBe("main");
      expect(result.account.auth_mode).toBe("chatgpt");

      const savedAuthRaw = await readFile(
        join(homeDir, ".codex-team", "accounts", "main", "auth.json"),
        "utf8",
      );
      const savedAuth = parseAuthSnapshot(savedAuthRaw);
      expect(extractChatGPTAuth(savedAuth).planType).toBe("pro");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("saves and switches apikey-managed accounts", async () => {
    const homeDir = await createTempHome();
    const alphaConfig = `model_provider = "custom"

[model_providers.custom]
base_url = "https://proxy-alpha.example/v1"
wire_api = "responses"
`;
    const betaConfig = `model_provider = "custom"

[model_providers.custom]
base_url = "https://proxy-beta.example/v1"
wire_api = "responses"
`;

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-alpha");
      await writeCurrentConfig(homeDir, alphaConfig);
      const alpha = await store.saveCurrentAccount("alpha");

      await writeCurrentApiKeyAuth(homeDir, "sk-beta");
      await writeCurrentConfig(homeDir, betaConfig);
      await store.saveCurrentAccount("beta");

      const current = await store.getCurrentStatus();
      expect(current.exists).toBe(true);
      expect(current.auth_mode).toBe("apikey");
      expect(current.account_id).toMatch(/^key_[0-9a-f]{16}$/);
      expect(current.matched_accounts).toEqual(["beta"]);

      const switchResult = await store.switchAccount("alpha");
      expect(switchResult.account.account_id).toBe(alpha.account_id);

      const switched = await readCurrentAuth(homeDir);
      expect(switched.auth_mode).toBe("apikey");
      expect(switched.OPENAI_API_KEY).toBe("sk-alpha");
      expect(await readCurrentConfig(homeDir)).toContain('base_url = "https://proxy-alpha.example/v1"');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("requires config.toml with base_url for apikey accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-alpha");
      await writeCurrentConfig(homeDir, 'model_provider = "custom"\n');

      await expect(store.saveCurrentAccount("alpha")).rejects.toThrow(/missing base_url/);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("creates an empty config snapshot when switching a legacy apikey account without config", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-alpha");
      await writeCurrentConfig(
        homeDir,
        `model_provider = "custom"

[model_providers.custom]
base_url = "https://proxy-alpha.example/v1"
wire_api = "responses"
`,
      );
      await store.saveCurrentAccount("alpha");
      await readFile(join(homeDir, ".codex-team", "accounts", "alpha", "config.toml"), "utf8");
      await rm(join(homeDir, ".codex-team", "accounts", "alpha", "config.toml"));

      const result = await store.switchAccount("alpha");
      expect(result.warnings).toContain(
        'Saved apikey account "alpha" was missing config.toml snapshot. Created an empty snapshot; configure baseUrl manually if needed.',
      );
      expect(
        await readFile(join(homeDir, ".codex-team", "accounts", "alpha", "config.toml"), "utf8"),
      ).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not require or persist config snapshots for chatgpt accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-chatgpt");
      await writeCurrentConfig(homeDir, 'model_provider = "custom"\n');

      await store.saveCurrentAccount("main");

      await expect(
        readFile(join(homeDir, ".codex-team", "accounts", "main", "config.toml"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("removes apikey provider config when switching back to chatgpt auth", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-chatgpt");
      await store.saveCurrentAccount("main");

      await writeCurrentApiKeyAuth(homeDir, "sk-alpha");
      await writeCurrentConfig(
        homeDir,
        `model_provider = "custom"

[model_providers.custom]
base_url = "https://proxy-alpha.example/v1"
wire_api = "responses"

[projects."/Users/bytedance/.codex"]
preferred_auth_method = "apikey"
`,
      );

      await store.switchAccount("main");

      const current = await readCurrentAuth(homeDir);
      expect(current.auth_mode).toBe("chatgpt");
      const currentConfig = await readCurrentConfig(homeDir);
      expect(currentConfig).not.toContain("base_url");
      expect(currentConfig).not.toContain('[model_providers.custom]');
      expect(currentConfig).not.toContain('model_provider = "custom"');
      expect(currentConfig).not.toContain('preferred_auth_method = "apikey"');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refreshes quotas and keeps cached balance when a later refresh fails", async () => {
    const homeDir = await createTempHome();
    let attempts = 0;

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 12,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 999,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 54,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 8_888,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "17",
              },
            });
          }

          return textResponse("unauthorized", 401);
        },
      });
      await writeCurrentAuth(homeDir, "acct-quota");
      await store.saveCurrentAccount("main");

      const refreshed = await store.refreshQuotaForAccount("main");
      expect(refreshed.quota.credits_balance).toBe(17);

      const quotaList = await store.listQuotaSummaries();
      expect(quotaList.accounts).toMatchObject([
        {
          name: "main",
          plan_type: "plus",
          credits_balance: 17,
          status: "ok",
          five_hour: {
            used_percent: 12,
          },
          one_week: {
            used_percent: 54,
          },
        },
      ]);

      await expect(store.refreshQuotaForAccount("main")).rejects.toThrow(
        /Failed to refresh quota/,
      );

      const refreshedMetaRaw = await readFile(
        join(homeDir, ".codex-team", "accounts", "main", "meta.json"),
        "utf8",
      );
      expect(refreshedMetaRaw).toContain('"credits_balance": 17');
      expect(refreshedMetaRaw).toContain('"status": "error"');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refreshes quotas with limited concurrency and preserves account order", async () => {
    const homeDir = await createTempHome();
    let activeRequests = 0;
    let maxActiveRequests = 0;

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (_input, init) => {
          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");
          if (!accountId) {
            return textResponse("missing account id", 400);
          }

          activeRequests += 1;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

          await new Promise((resolve) => setTimeout(resolve, 25));

          activeRequests -= 1;
          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_after_seconds: 999,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 20,
                limit_window_seconds: 604_800,
                reset_after_seconds: 8_888,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: accountId.length.toString(),
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-a");
      await store.saveCurrentAccount("alpha");
      await writeCurrentAuth(homeDir, "acct-b");
      await store.saveCurrentAccount("beta");
      await writeCurrentAuth(homeDir, "acct-c");
      await store.saveCurrentAccount("gamma");
      await writeCurrentAuth(homeDir, "acct-d");
      await store.saveCurrentAccount("delta");

      const result = await store.refreshAllQuotas();

      expect(result.failures).toEqual([]);
      expect(result.successes.map((account) => account.name)).toEqual([
        "alpha",
        "beta",
        "delta",
        "gamma",
      ]);
      expect(maxActiveRequests).toBeGreaterThan(1);
      expect(maxActiveRequests).toBeLessThanOrEqual(8);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
