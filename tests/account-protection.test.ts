import { describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore, type AccountQuotaSummary } from "../src/account-store/index.js";
import { selectAutoSwitchAccount } from "../src/switching.js";
import { captureWritable } from "./cli-fixtures.js";
import { cleanupTempHome, createTempHome, writeCurrentAuth } from "./test-helpers.js";

describe("account auto-switch protection", () => {
  test("protect and unprotect toggle auto switch eligibility", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-primary", "chatgpt", "plus", "user-primary");
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("primary");

      const protectStdout = captureWritable();
      const protectStderr = captureWritable();
      const protectExitCode = await runCli(["protect", "primary", "--json"], {
        store,
        stdout: protectStdout.stream,
        stderr: protectStderr.stream,
      });

      expect(protectExitCode).toBe(0);
      expect(JSON.parse(protectStdout.read())).toMatchObject({
        ok: true,
        action: "protect",
        account: {
          name: "primary",
          auto_switch_eligible: false,
        },
      });
      expect(protectStderr.read()).toBe("");
      expect((await store.getManagedAccount("primary")).auto_switch_eligible).toBe(false);

      const unprotectStdout = captureWritable();
      const unprotectStderr = captureWritable();
      const unprotectExitCode = await runCli(["unprotect", "primary", "--json"], {
        store,
        stdout: unprotectStdout.stream,
        stderr: unprotectStderr.stream,
      });

      expect(unprotectExitCode).toBe(0);
      expect(JSON.parse(unprotectStdout.read())).toMatchObject({
        ok: true,
        action: "unprotect",
        account: {
          name: "primary",
          auto_switch_eligible: true,
        },
      });
      expect(unprotectStderr.read()).toBe("");
      expect((await store.getManagedAccount("primary")).auto_switch_eligible).toBe(true);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("selectAutoSwitchAccount excludes protected accounts from auto-switch targets", async () => {
    const protectedAccount: AccountQuotaSummary = {
      name: "protected-main",
      account_id: "acct-protected",
      user_id: "user-protected",
      identity: "acct-protected:user-protected",
      auto_switch_eligible: false,
      plan_type: "plus",
      credits_balance: 5,
      status: "ok",
      fetched_at: "2026-04-17T00:00:00.000Z",
      error_message: null,
      unlimited: false,
      five_hour: {
        used_percent: 10,
        window_seconds: 18_000,
        reset_at: "2026-04-17T05:00:00.000Z",
      },
      one_week: {
        used_percent: 10,
        window_seconds: 604_800,
        reset_at: "2026-04-24T00:00:00.000Z",
      },
    };
    const eligibleAccount: AccountQuotaSummary = {
      ...protectedAccount,
      name: "eligible-backup",
      account_id: "acct-eligible",
      user_id: "user-eligible",
      identity: "acct-eligible:user-eligible",
      auto_switch_eligible: true,
      five_hour: {
        used_percent: 40,
        window_seconds: 18_000,
        reset_at: "2026-04-17T05:00:00.000Z",
      },
    };

    const selection = await selectAutoSwitchAccount({
      refreshAllQuotas: async () => ({
        successes: [protectedAccount, eligibleAccount],
        failures: [],
        warnings: [],
      }),
    } as unknown as ReturnType<typeof createAccountStore>);

    expect(selection.selected.name).toBe("eligible-backup");
    expect(selection.candidates.map((candidate) => candidate.name)).toEqual(["eligible-backup"]);
  });
});
