import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import { runCli } from "../src/main.js";
import { formatProxyUpstreamSelectionLabel } from "../src/proxy/request-log.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  writeCurrentAuth,
  writeProxyRequestLog,
} from "./test-helpers.js";
import {
  captureWritable,
  createDesktopLauncherStub,
} from "./cli-fixtures.js";

function createProxyProcessManagerStub(overrides: Partial<{
  running: boolean;
  host: string;
  port: number;
  debug: boolean;
}> = {}) {
  const host = overrides.host ?? "127.0.0.1";
  const port = overrides.port ?? 14555;
  const state = {
    pid: 12345,
    host,
    port,
    started_at: "2026-04-18T00:00:00.000Z",
    log_path: "/tmp/codexm-proxy.log",
    base_url: `http://${host}:${port}/backend-api`,
    openai_base_url: `http://${host}:${port}/v1`,
    debug: overrides.debug ?? false,
  };
  const calls: Array<{ host: string; port: number; debug: boolean }> = [];
  let running = overrides.running ?? false;

  return {
    calls,
    manager: {
      startDetached: async (options: { host: string; port: number; debug: boolean }) => {
        calls.push(options);
        running = true;
        return {
          ...state,
          host: options.host,
          port: options.port,
          base_url: `http://${options.host}:${options.port}/backend-api`,
          openai_base_url: `http://${options.host}:${options.port}/v1`,
          debug: options.debug,
        };
      },
      getStatus: async () => ({
        running,
        state: running ? state : null,
      }),
      stop: async () => {
        const wasRunning = running;
        running = false;
        return {
          running: false,
          state: wasRunning ? state : null,
          stopped: wasRunning,
        };
      },
    },
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

async function writeQuotaMeta(
  accountMetaPath: string,
  quota: {
    status: "ok" | "stale" | "error";
    plan_type: string;
    five_hour_used: number;
    one_week_used: number;
  },
): Promise<void> {
  const now = Date.now();
  const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
  const meta = JSON.parse(await readFile(accountMetaPath, "utf8")) as Record<string, unknown>;
  meta.quota = {
    status: quota.status,
    plan_type: quota.plan_type,
    fetched_at: iso(-5),
    unlimited: true,
    five_hour: {
      used_percent: quota.five_hour_used,
      window_seconds: 18_000,
      reset_at: iso(5 * 60),
    },
    one_week: {
      used_percent: quota.one_week_used,
      window_seconds: 604_800,
      reset_at: iso(7 * 24 * 60),
    },
  };
  await writeFile(accountMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

describe("codexm proxy list", () => {
  test("list and dashboard expose the enabled proxy as a synthetic aggregate account", async () => {
    const { buildCachedAccountDashboardSnapshot } = await import("../src/commands/tui.js");
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-real", "chatgpt", "plus", "user-real");
      const proxyLastUpstreamAt = new Date().toISOString();
      const proxyLastUpstreamLabel = formatProxyUpstreamSelectionLabel({
        accountName: "real-main",
        authMode: "chatgpt",
        ts: proxyLastUpstreamAt,
      });
      await writeProxyRequestLog(homeDir, [
        {
          ts: proxyLastUpstreamAt,
          route: "/v1/responses",
          selected_account_name: "real-main",
          selected_auth_mode: "chatgpt",
          status_code: 200,
        },
      ]);
      const quotaUrls: string[] = [];
      const store = createAccountStore(homeDir, {
        fetchImpl: async (url, init) => {
          quotaUrls.push(String(url));
          const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
          expect(accountId).toBe("acct-real");
          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 12,
                limit_window_seconds: 18_000,
                reset_at: Math.floor(Date.parse("2026-04-18T05:00:00.000Z") / 1000),
              },
              secondary_window: {
                used_percent: 34,
                limit_window_seconds: 604_800,
                reset_at: Math.floor(Date.parse("2026-04-25T00:00:00.000Z") / 1000),
              },
            },
            credits: {
              has_credits: true,
              unlimited: true,
              balance: "0",
            },
          });
        },
      });
      await store.saveCurrentAccount("real-main");
      const proxyProcess = createProxyProcessManagerStub();

      const enableStdout = captureWritable();
      const enableCode = await runCli(["proxy", "enable", "--json"], {
        store,
        stdout: enableStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(enableCode).toBe(0);

      const textListStdout = captureWritable();
      const textListCode = await runCli(["list"], {
        store,
        stdout: textListStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(textListCode).toBe(0);
      const textListOutput = stripAnsi(textListStdout.read());
      expect(textListOutput).toContain("Accounts: 1/1 usable | blocked: 1W 0, 5H 0 | plus x1");
      expect(textListOutput).not.toContain("Accounts: 1/1 usable | blocked: 1W 0, 5H 0 | pro x1");
      expect(textListOutput).toContain("Available: bottleneck 0.13 | 5H->1W 0.13 | 1W 0.66 (plus 1W)");
      expect(textListOutput).toContain(`Proxy last upstream: ${proxyLastUpstreamLabel}`);
      expect(textListOutput).toMatch(/^[ *]@\s+real-main\b/m);
      const proxyLine = textListOutput
        .split("\n")
        .find((line) => line.includes("cod..oxy"));
      expect(proxyLine).toBeDefined();
      expect((proxyLine ?? "").trimStart().startsWith("*")).toBe(true);
      expect(proxyLine ?? "").not.toContain("@ proxy");
      expect(proxyLine ?? "").not.toContain(" pro ");

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(listCode).toBe(0);
      const listPayload = JSON.parse(listStdout.read()) as {
        proxy: { name: string; plan_type: string; five_hour: { used_percent: number } } | null;
        proxy_current_upstream: { account_name: string } | null;
        proxy_last_upstream: { account_name: string; auth_mode: string; label: string | null } | null;
        successes: Array<{ name: string; is_current: boolean }>;
      };
      expect(listPayload.proxy).toMatchObject({
        name: "proxy",
        plan_type: "pro",
        five_hour: { used_percent: 12 },
      });
      expect(listPayload.successes[0]).toMatchObject({
        name: "proxy",
        is_current: true,
      });
      expect(listPayload.proxy_current_upstream).toEqual({
        account_name: "real-main",
      });
      expect(listPayload.proxy_last_upstream).toMatchObject({
        account_name: "real-main",
        auth_mode: "chatgpt",
        label: proxyLastUpstreamLabel,
      });
      expect(quotaUrls).toContain("https://chatgpt.com/backend-api/wham/usage");
      expect(quotaUrls).not.toContain("http://127.0.0.1:14555/backend-api/backend-api/wham/usage");

      const dashboard = await buildCachedAccountDashboardSnapshot({ store });
      expect(dashboard.currentStatusLine).toBe(
        "Current proxy account: proxy | [daemon:off] [proxy:off] [autoswitch:off]",
      );
      expect(dashboard.summaryLine).toBe("Accounts: 1/1 usable | blocked: 1W 0, 5H 0 | plus x1");
      expect(dashboard.poolLine).toBe("Available: bottleneck 0.13 | 5H->1W 0.13 | 1W 0.66 (plus 1W)");
      expect(dashboard.accounts[0]).toMatchObject({
        name: "proxy",
        current: true,
        authModeLabel: "proxy",
        emailLabel: "proxy@codexm.local",
        planLabel: "",
        identityLabel: "",
        proxyLastUpstreamLabel,
      });
      expect(dashboard.accounts[1]).toMatchObject({
        name: "real-main",
        proxyUpstreamActive: true,
      });
      expect(stripAnsi(dashboard.accounts[0]?.scoreLabel ?? "")).toBe("88%");
      expect((dashboard.accounts[0]?.detailLines ?? []).map(stripAnsi)).toContain(
        `Last upstream: ${proxyLastUpstreamLabel}`,
      );
      expect((dashboard.accounts[0]?.detailLines ?? []).map(stripAnsi)).toContain("Score: 88%");

      const disableStdout = captureWritable();
      const disableCode = await runCli(["proxy", "disable", "--json"], {
        store,
        stdout: disableStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(disableCode).toBe(0);

      const disabledTextListStdout = captureWritable();
      const disabledTextListCode = await runCli(["list"], {
        store,
        stdout: disabledTextListStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(disabledTextListCode).toBe(0);
      const disabledTextListOutput = stripAnsi(disabledTextListStdout.read());
      expect(disabledTextListOutput).not.toContain("Proxy last upstream:");
      expect(disabledTextListOutput).not.toMatch(/^[ *]@\s+real-main\b/m);
      const disabledProxyLine = disabledTextListOutput
        .split("\n")
        .find((line) => line.includes("cod..oxy"));
      expect(disabledProxyLine).toBeDefined();
      expect((disabledProxyLine ?? "").trimStart().startsWith("*")).toBe(false);

      const disabledListStdout = captureWritable();
      const disabledListCode = await runCli(["list", "--json"], {
        store,
        stdout: disabledListStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(disabledListCode).toBe(0);
      const disabledListPayload = JSON.parse(disabledListStdout.read()) as {
        proxy: { name: string } | null;
        proxy_last_upstream: { account_name: string; auth_mode: string; label: string | null } | null;
        successes: Array<{ name: string; is_current: boolean }>;
      };
      expect(disabledListPayload.proxy).toMatchObject({
        name: "proxy",
      });
      expect(disabledListPayload.proxy_last_upstream).toBeNull();
      expect(disabledListPayload.successes[0]).toMatchObject({
        name: "proxy",
        is_current: false,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy aggregate quota excludes protected accounts but keeps exhausted ones visible", async () => {
    const { buildProxyQuotaAggregateFromAccounts } = await import("../src/proxy/quota.js");

    const aggregate = buildProxyQuotaAggregateFromAccounts([
      {
        name: "usable-main",
        account_id: "acct-usable",
        user_id: "user-usable",
        identity: "acct-usable:user-usable",
        credits_balance: null,
        plan_type: "plus",
        status: "ok",
        fetched_at: "2026-04-18T00:00:00.000Z",
        error_message: null,
        unlimited: true,
        five_hour: {
          used_percent: 20,
          window_seconds: 18_000,
          reset_at: "2026-04-18T05:00:00.000Z",
        },
        one_week: {
          used_percent: 40,
          window_seconds: 604_800,
          reset_at: "2026-04-25T00:00:00.000Z",
        },
        auto_switch_eligible: true,
      },
      {
        name: "protected-main",
        account_id: "acct-protected",
        user_id: "user-protected",
        identity: "acct-protected:user-protected",
        credits_balance: null,
        plan_type: "plus",
        status: "ok",
        fetched_at: "2026-04-18T00:00:00.000Z",
        error_message: null,
        unlimited: true,
        five_hour: {
          used_percent: 70,
          window_seconds: 18_000,
          reset_at: "2026-04-18T05:00:00.000Z",
        },
        one_week: {
          used_percent: 80,
          window_seconds: 604_800,
          reset_at: "2026-04-25T00:00:00.000Z",
        },
        auto_switch_eligible: false,
      },
      {
        name: "blocked-main",
        account_id: "acct-blocked",
        user_id: "user-blocked",
        identity: "acct-blocked:user-blocked",
        credits_balance: null,
        plan_type: "plus",
        status: "ok",
        fetched_at: "2026-04-18T00:00:00.000Z",
        error_message: null,
        unlimited: true,
        five_hour: {
          used_percent: 100,
          window_seconds: 18_000,
          reset_at: "2026-04-18T05:00:00.000Z",
        },
        one_week: {
          used_percent: 100,
          window_seconds: 604_800,
          reset_at: "2026-04-25T00:00:00.000Z",
        },
        auto_switch_eligible: true,
      },
    ]);

    expect(aggregate).not.toBeNull();
    expect(aggregate?.summary.five_hour?.used_percent).toBe(60);
    expect(aggregate?.summary.one_week?.used_percent).toBe(70);
    expect(aggregate?.watchEtaTarget.remaining_5h_eq_1w).toBe(12);
    expect(aggregate?.watchEtaTarget.remaining_1w).toBe(60);
  });

  test("proxy aggregate quota weights used percent by real plan capacity", async () => {
    const { buildProxyQuotaAggregateFromAccounts } = await import("../src/proxy/quota.js");
    const futureFiveHourPlus = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const futureFiveHourPro = new Date(Date.now() + 60 * 60_000).toISOString();
    const futureOneWeekPlus = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const futureOneWeekPro = new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString();

    const aggregate = buildProxyQuotaAggregateFromAccounts([
      {
        name: "plus-main",
        account_id: "acct-plus",
        user_id: "user-plus",
        identity: "acct-plus:user-plus",
        credits_balance: null,
        plan_type: "plus",
        status: "ok",
        fetched_at: "2026-04-18T00:00:00.000Z",
        error_message: null,
        unlimited: true,
        five_hour: {
          used_percent: 90,
          window_seconds: 18_000,
          reset_at: futureFiveHourPlus,
        },
        one_week: {
          used_percent: 90,
          window_seconds: 604_800,
          reset_at: futureOneWeekPlus,
        },
        auto_switch_eligible: true,
      },
      {
        name: "pro-main",
        account_id: "acct-pro",
        user_id: "user-pro",
        identity: "acct-pro:user-pro",
        credits_balance: null,
        plan_type: "pro",
        status: "ok",
        fetched_at: "2026-04-18T00:00:00.000Z",
        error_message: null,
        unlimited: true,
        five_hour: {
          used_percent: 10,
          window_seconds: 18_000,
          reset_at: futureFiveHourPro,
        },
        one_week: {
          used_percent: 10,
          window_seconds: 604_800,
          reset_at: futureOneWeekPro,
        },
        auto_switch_eligible: true,
      },
    ]);

    expect(aggregate).not.toBeNull();
    expect(aggregate?.summary.five_hour?.used_percent).toBe(17.3);
    expect(aggregate?.summary.one_week?.used_percent).toBe(18.6);
    expect(aggregate?.watchEtaTarget.remaining_5h_eq_1w).toBe(136.5);
    expect(aggregate?.watchEtaTarget.remaining_1w).toBe(760);
    expect(aggregate?.summary.five_hour?.reset_at).toBe(futureFiveHourPro);
    expect(aggregate?.summary.one_week?.reset_at).toBe(futureOneWeekPro);
  });

  test("proxy aggregate ignores past reset timestamps when synthesizing pooled windows", async () => {
    const { buildProxyQuotaAggregateFromAccounts, buildProxyUsagePayload } = await import("../src/proxy/quota.js");
    const futureFiveHour = new Date(Date.now() + 45 * 60_000).toISOString();
    const futureOneWeek = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();

    const aggregate = buildProxyQuotaAggregateFromAccounts([
      {
        name: "stale-reset",
        account_id: "acct-stale",
        user_id: "user-stale",
        identity: "acct-stale:user-stale",
        credits_balance: null,
        plan_type: "plus",
        status: "ok",
        fetched_at: new Date().toISOString(),
        error_message: null,
        unlimited: true,
        five_hour: {
          used_percent: 91,
          window_seconds: 18_000,
          reset_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          reset_after_seconds: 0,
        },
        one_week: {
          used_percent: 70,
          window_seconds: 604_800,
          reset_at: futureOneWeek,
        },
        auto_switch_eligible: true,
      },
      {
        name: "fresh-reset",
        account_id: "acct-fresh",
        user_id: "user-fresh",
        identity: "acct-fresh:user-fresh",
        credits_balance: null,
        plan_type: "plus",
        status: "ok",
        fetched_at: new Date().toISOString(),
        error_message: null,
        unlimited: true,
        five_hour: {
          used_percent: 20,
          window_seconds: 18_000,
          reset_at: futureFiveHour,
          reset_after_seconds: 45 * 60,
        },
        one_week: {
          used_percent: 20,
          window_seconds: 604_800,
          reset_at: futureOneWeek,
          reset_after_seconds: 3 * 24 * 60 * 60,
        },
        auto_switch_eligible: true,
      },
    ]);

    expect(aggregate).not.toBeNull();
    expect(aggregate?.summary.five_hour?.reset_at).toBe(futureFiveHour);
    expect(aggregate?.summary.five_hour?.reset_after_seconds).toBeGreaterThan(0);
    expect(aggregate?.summary.one_week?.reset_at).toBe(futureOneWeek);

    const usagePayload = buildProxyUsagePayload(aggregate?.summary ?? null);
    expect(usagePayload.rate_limit.primary_window?.reset_after_seconds).toBeGreaterThan(0);
    expect(usagePayload.rate_limit.secondary_window?.reset_after_seconds).toBeGreaterThan(0);
  });

  test("list keeps the last cached quota snapshot when wham usage refresh fails", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-cached", "chatgpt", "plus", "user-cached");
      const store = createAccountStore(homeDir, {
        fetchImpl: async (url) => {
          expect(String(url)).toContain("/backend-api/wham/usage");
          throw new Error("network down");
        },
      });
      await store.saveCurrentAccount("cached-main");
      await writeQuotaMeta(
        (await store.getManagedAccount("cached-main")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 11, one_week_used: 22 },
      );
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["list"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("cached-main");
      expect(output).toContain("11%");
      expect(output).toContain("22%");
      expect(output).toContain("Warning: cached-main using cached quota");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list keeps showing the last known quota snapshot after a prior refresh marked it error", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-cached", "chatgpt", "plus", "user-cached");
      const store = createAccountStore(homeDir, {
        fetchImpl: async (url) => {
          expect(String(url)).toContain("/backend-api/wham/usage");
          throw new Error("token expired");
        },
      });
      await store.saveCurrentAccount("cached-main");
      await writeQuotaMeta(
        (await store.getManagedAccount("cached-main")).metaPath,
        { status: "error", plan_type: "plus", five_hour_used: 11, one_week_used: 22 },
      );
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["list"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("cached-main");
      expect(output).toContain("11%");
      expect(output).toContain("22%");
      expect(output).toContain("Warning: cached-main using cached quota");
      expect(output).toContain("token expired");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
