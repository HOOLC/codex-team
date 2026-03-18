import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store.js";
import {
  cleanupTempHome,
  createTempHome,
  readCurrentAuth,
  writeCurrentAuth,
} from "./test-helpers.js";

describe("AccountStore", () => {
  test("saves, lists, matches, renames and removes managed accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-one");

      await store.saveCurrentAccount("main");
      await store.saveCurrentAccount("shadow", true);
      const listBeforeRename = await store.listAccounts();

      expect(listBeforeRename.accounts).toHaveLength(2);
      expect(listBeforeRename.accounts.every((account) => account.duplicateAccountId)).toBe(true);

      const current = await store.getCurrentStatus();
      expect(current.exists).toBe(true);
      expect(current.duplicate_match).toBe(true);
      expect(current.matched_accounts).toEqual(["main", "shadow"]);

      const renamed = await store.renameAccount("shadow", "backup");
      expect(renamed.name).toBe("backup");

      await store.removeAccount("backup");
      const listAfterRemove = await store.listAccounts();
      expect(listAfterRemove.accounts.map((account) => account.name)).toEqual(["main"]);
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
      expect(current.tokens.account_id).toBe("acct-alpha");

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
});
