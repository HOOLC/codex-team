import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import { PROXY_PORT_ENV_VAR } from "../src/proxy/constants.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  textResponse,
  withEnvVar,
  writeCurrentAuth,
} from "./test-helpers.js";
import {
  captureWritable,
  createDaemonProcessManagerStub,
  createDesktopLauncherStub,
  createInteractiveStdin,
} from "./cli-fixtures.js";
import { setPlatformForTesting } from "../src/platform.js";

describe("CLI", () => {
  test("watch enters CLI mode when there is no managed desktop session", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const controller = new AbortController();
      controller.abort();

      const exitCode = await runCli(["watch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        interruptSignal: controller.signal,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => false,
        }),
      });

      // CLI watch mode should report entering CLI mode
      expect(exitCode).toBe(0);
      const stderrOutput = stderr.read();
      expect(stderrOutput).toContain("CLI watch mode");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch rejects the removed --detach flag", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--detach"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => false,
        }),
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain('Unknown flag "--detach" for command "watch".');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch writes quota history records when runtime quota changes", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-watch-history");
      const account = await store.saveCurrentAccount("plus-main");

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "plus",
            credits_balance: 0,
            fetched_at: "2026-04-10T10:00:00.000Z",
            unlimited: false,
            five_hour: {
              used_percent: 10,
              window_seconds: 18_000,
              reset_at: "2026-04-10T14:00:00.000Z",
            },
            one_week: {
              used_percent: 3,
              window_seconds: 604_800,
              reset_at: "2026-04-16T10:00:00.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            await options?.onQuotaSignal?.({
              requestId: "req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "quota_dirty",
              bodySnippet: null,
              shouldAutoSwitch: false,
              quota: {
                plan_type: "plus",
                credits_balance: 0,
                fetched_at: "2026-04-10T10:15:00.000Z",
                unlimited: false,
                five_hour: {
                  used_percent: 20,
                  window_seconds: 18_000,
                  reset_at: "2026-04-10T14:00:00.000Z",
                },
                one_week: {
                  used_percent: 6,
                  window_seconds: 604_800,
                  reset_at: "2026-04-16T10:00:00.000Z",
                },
              },
            });
          },
        }),
      });

      expect(exitCode).toBe(0);
      const historyPath = join(homeDir, ".codex-team", "watch-quota-history.jsonl");
      const history = await readFile(historyPath, "utf8");
      expect(history).toContain("\"source\":\"watch\"");
      expect(history).toContain("\"account_name\":\"plus-main\"");
      expect(history).toContain(`\"account_id\":\"${account.account_id}\"`);
      expect(history).toContain(`\"identity\":\"${account.identity}\"`);
      expect(history).toContain("\"used_percent\":10");
      expect(history).toContain("\"used_percent\":20");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch rejects the removed --status flag", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--status"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain('Unknown flag "--status" for command "watch".');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch rejects the removed --stop flag", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--stop"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain('Unknown flag "--stop" for command "watch".');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("daemon --status reports when no shared daemon is running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["daemon", "status"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Daemon: not running");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("daemon --status reports enabled features and log path", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["daemon", "status"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub({
          getStatus: async () => ({
            running: true,
            state: {
              pid: 54321,
              started_at: "2026-04-18T00:00:00.000Z",
              log_path: "/tmp/daemon.log",
              stayalive: true,
              watch: true,
              auto_switch: true,
              proxy: true,
              host: "127.0.0.1",
              port: 14555,
              base_url: "http://127.0.0.1:14555/backend-api",
              openai_base_url: "http://127.0.0.1:14555/v1",
              debug: false,
            },
          }),
        }),
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("Daemon: running (pid 54321)");
      expect(output).toContain("Features: stayalive, autoswitch, proxy");
      expect(output).toContain("Log: /tmp/daemon.log");
      expect(output).toContain("ChatGPT base URL: http://127.0.0.1:14555/backend-api");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("daemon start launches the baseline stayalive daemon", async () => {
    const homeDir = await createTempHome();
    let ensureConfigArgs: Record<string, unknown> | null = null;

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["daemon", "start", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        daemonProcessManager: createDaemonProcessManagerStub({
          ensureConfig: async (config) => {
            ensureConfigArgs = config;
            return {
              action: "started",
              state: {
                pid: 54321,
                started_at: "2026-04-18T00:00:00.000Z",
                log_path: "/tmp/daemon.log",
                stayalive: true,
                watch: false,
                auto_switch: false,
                proxy: false,
                host: "127.0.0.1",
                port: 14555,
                base_url: "http://127.0.0.1:14555/backend-api",
                openai_base_url: "http://127.0.0.1:14555/v1",
                debug: true,
              },
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(ensureConfigArgs).toMatchObject({
        stayalive: true,
        watch: false,
        auto_switch: false,
        proxy: false,
        debug: true,
      });
      expect(stdout.read()).toContain("Started daemon (pid 54321).");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("daemon start respects CODEXM_PROXY_PORT when no port flag is provided", async () => {
    const homeDir = await createTempHome();
    let ensureConfigArgs: Record<string, unknown> | null = null;

    try {
      const store = createAccountStore(homeDir);

      await withEnvVar(PROXY_PORT_ENV_VAR, "16657", async () => {
        const exitCode = await runCli(["daemon", "start"], {
          store,
          stdout: captureWritable().stream,
          stderr: captureWritable().stream,
          daemonProcessManager: createDaemonProcessManagerStub({
            ensureConfig: async (config) => {
              ensureConfigArgs = config;
              return {
                action: "started",
                state: {
                  pid: 54321,
                  started_at: "2026-04-18T00:00:00.000Z",
                  log_path: "/tmp/daemon.log",
                  stayalive: true,
                  watch: false,
                  auto_switch: false,
                  proxy: false,
                  host: "127.0.0.1",
                  port: 16657,
                  base_url: "http://127.0.0.1:16657/backend-api",
                  openai_base_url: "http://127.0.0.1:16657/v1",
                  debug: false,
                },
              };
            },
          }),
        });

        expect(exitCode).toBe(0);
      });

      expect(ensureConfigArgs).toMatchObject({
        stayalive: true,
        watch: false,
        auto_switch: false,
        proxy: false,
        host: "127.0.0.1",
        port: 16657,
        base_url: "http://127.0.0.1:16657/backend-api",
        openai_base_url: "http://127.0.0.1:16657/v1",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("daemon restart stops the current process and preserves prior proxy and watch state", async () => {
    const homeDir = await createTempHome();
    const callOrder: string[] = [];
    let ensureConfigArgs: Record<string, unknown> | null = null;

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["daemon", "restart"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub({
          getStatus: async () => ({
            running: true,
            state: {
              pid: 54321,
              started_at: "2026-04-18T00:00:00.000Z",
              log_path: "/tmp/daemon.log",
              stayalive: true,
              watch: true,
              auto_switch: true,
              proxy: true,
              host: "127.0.0.1",
              port: 14555,
              base_url: "http://127.0.0.1:14555/backend-api",
              openai_base_url: "http://127.0.0.1:14555/v1",
              debug: false,
            },
          }),
          stop: async () => {
            callOrder.push("stop");
            return {
              running: false,
              state: {
                pid: 54321,
                started_at: "2026-04-18T00:00:00.000Z",
                log_path: "/tmp/daemon.log",
                stayalive: true,
                watch: true,
                auto_switch: true,
                proxy: true,
                host: "127.0.0.1",
                port: 14555,
                base_url: "http://127.0.0.1:14555/backend-api",
                openai_base_url: "http://127.0.0.1:14555/v1",
                debug: false,
              },
              stopped: true,
            };
          },
          ensureConfig: async (config) => {
            callOrder.push("ensure");
            ensureConfigArgs = config;
            return {
              action: "started",
              state: {
                pid: 65432,
                started_at: "2026-04-18T00:05:00.000Z",
                log_path: "/tmp/daemon.log",
                stayalive: true,
                watch: true,
                auto_switch: true,
                proxy: true,
                host: "127.0.0.1",
                port: 14555,
                base_url: "http://127.0.0.1:14555/backend-api",
                openai_base_url: "http://127.0.0.1:14555/v1",
                debug: false,
              },
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(callOrder).toEqual(["stop", "ensure"]);
      expect(ensureConfigArgs).toMatchObject({
        stayalive: true,
        watch: true,
        auto_switch: true,
        proxy: true,
        host: "127.0.0.1",
        port: 14555,
      });
      expect(stdout.read()).toContain("Started daemon (pid 65432).");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("autoswitch status reports disabled when the daemon is not running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["autoswitch", "status"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Autoswitch: disabled");
      expect(stdout.read()).toContain("Daemon: stopped");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("autoswitch enable starts the shared daemon with autoswitch enabled", async () => {
    const homeDir = await createTempHome();
    let ensureConfigArgs: Record<string, unknown> | null = null;

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["autoswitch", "enable", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        daemonProcessManager: createDaemonProcessManagerStub({
          ensureConfig: async (config) => {
            ensureConfigArgs = config;
            return {
              action: "started",
              state: {
                pid: 54321,
                started_at: "2026-04-18T00:00:00.000Z",
                log_path: "/tmp/daemon.log",
                stayalive: true,
                watch: true,
                auto_switch: true,
                proxy: false,
                host: "127.0.0.1",
                port: 14555,
                base_url: "http://127.0.0.1:14555/backend-api",
                openai_base_url: "http://127.0.0.1:14555/v1",
                debug: true,
              },
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(ensureConfigArgs).toMatchObject({
        stayalive: true,
        watch: true,
        auto_switch: true,
        proxy: false,
      });
      expect(stdout.read()).toContain("Enabled autoswitch.");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("autoswitch disable preserves the baseline daemon without watch mode", async () => {
    const homeDir = await createTempHome();
    let ensureConfigArgs: Record<string, unknown> | null = null;

    try {
      const store = createAccountStore(homeDir);

      const exitCode = await runCli(["autoswitch", "disable"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub({
          getStatus: async () => ({
            running: true,
            state: {
              pid: 54321,
              started_at: "2026-04-18T00:00:00.000Z",
              log_path: "/tmp/daemon.log",
              stayalive: true,
              watch: true,
              auto_switch: true,
              proxy: false,
              host: "127.0.0.1",
              port: 14555,
              base_url: "http://127.0.0.1:14555/backend-api",
              openai_base_url: "http://127.0.0.1:14555/v1",
              debug: true,
            },
          }),
          ensureConfig: async (config) => {
            ensureConfigArgs = config;
            return {
              action: "restarted",
              state: {
                pid: 54321,
                started_at: "2026-04-18T00:05:00.000Z",
                log_path: "/tmp/daemon.log",
                stayalive: true,
                watch: false,
                auto_switch: false,
                proxy: false,
                host: "127.0.0.1",
                port: 14555,
                base_url: "http://127.0.0.1:14555/backend-api",
                openai_base_url: "http://127.0.0.1:14555/v1",
                debug: true,
              },
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(ensureConfigArgs).toMatchObject({
        stayalive: true,
        watch: false,
        auto_switch: false,
        proxy: false,
      });
      expect(ensureConfigArgs).not.toBeNull();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --no-auto-switch prints quota updates even for terminal quota updates", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let applyManagedSwitchCalls = 0;
      let readManagedCurrentQuotaCalls = 0;

      const exitCode = await runCli(["watch", "--debug", "--no-auto-switch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => {
            readManagedCurrentQuotaCalls += 1;
            throw new Error("watch should use quota carried by account/rateLimits/read");
          },
          watchManagedQuotaSignals: async (options) => {
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"from_view","event":{"type":"mcp-request","request":{"id":"req-1","method":"account/rateLimits/read","params":{}}}}}',
            );
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"for_view","event":{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}}}',
            );
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}',
              shouldAutoSwitch: true,
              quota: {
                plan_type: "team",
                credits_balance: null,
                unlimited: false,
                fetched_at: "2026-04-08T15:20:00.000Z",
                five_hour: {
                  used_percent: 72,
                  window_seconds: 18_000,
                  reset_at: "2026-04-08T16:50:52.000Z",
                },
                one_week: {
                  used_percent: 63,
                  window_seconds: 604_800,
                  reset_at: "2026-04-14T09:17:35.000Z",
                },
              },
            });
          },
          applyManagedSwitch: async () => {
            applyManagedSwitchCalls += 1;
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain('"method":"Bridge.message"');
      expect(stderr.read()).toContain('"type":"mcp-request"');
      expect(stderr.read()).toContain('"type":"mcp-response"');
      expect(stderr.read()).toContain(
        '[debug] watch: quota signal matched reason=rpc_response requestId=rpc:req-1',
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
      expect(readManagedCurrentQuotaCalls).toBe(1);
      expect(applyManagedSwitchCalls).toBe(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch reads quota from managed Desktop after dirty activity instead of trusting updated payloads", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let applyManagedSwitchCalls = 0;
      let readManagedCurrentQuotaCalls = 0;
      const interruptController = new AbortController();

      const exitCode = await runCli(["watch", "--debug", "--no-auto-switch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        interruptSignal: interruptController.signal,
        watchQuotaMinReadIntervalMs: 5,
        watchQuotaIdleReadIntervalMs: 10_000,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => {
            readManagedCurrentQuotaCalls += 1;
            return {
              plan_type: "team",
              credits_balance: null,
              unlimited: false,
              fetched_at: "2026-04-08T15:20:00.000Z",
              five_hour: {
                used_percent: readManagedCurrentQuotaCalls === 1 ? 10 : 72,
                window_seconds: 18_000,
                reset_at: "2026-04-08T16:50:52.000Z",
              },
              one_week: {
                used_percent: readManagedCurrentQuotaCalls === 1 ? 20 : 63,
                window_seconds: 604_800,
                reset_at: "2026-04-14T09:17:35.000Z",
              },
            };
          },
          watchManagedQuotaSignals: async (options) => {
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"for_view","event":{"type":"mcp-notification","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":96},"secondary":{"usedPercent":16}}}}}}',
            );
            await options?.onActivitySignal?.({
              requestId: "rpc:notification:account/rateLimits/updated",
              method: "account/rateLimits/updated",
              reason: "quota_dirty",
              bodySnippet:
                '{"type":"mcp-notification","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":96},"secondary":{"usedPercent":16}}}}',
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            interruptController.abort();
          },
          applyManagedSwitch: async () => {
            applyManagedSwitchCalls += 1;
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain('"method":"account/rateLimits/updated"');
      expect(stderr.read()).toContain(
        "[debug] watch: activity signal matched reason=quota_dirty requestId=rpc:notification:account/rateLimits/updated",
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=90% left 1W=80% left/,
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
      expect(stdout.read()).not.toContain("5H=4% left");
      expect(readManagedCurrentQuotaCalls).toBe(2);
      expect(applyManagedSwitchCalls).toBe(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch refreshes quota on the idle fallback interval", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const interruptController = new AbortController();
      let readManagedCurrentQuotaCalls = 0;

      const exitCode = await runCli(["watch", "--debug", "--no-auto-switch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        interruptSignal: interruptController.signal,
        watchQuotaMinReadIntervalMs: 1,
        watchQuotaIdleReadIntervalMs: 5,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => {
            readManagedCurrentQuotaCalls += 1;
            return {
              plan_type: "team",
              credits_balance: null,
              unlimited: false,
              fetched_at: "2026-04-08T15:20:00.000Z",
              five_hour: {
                used_percent: readManagedCurrentQuotaCalls === 1 ? 10 : 20,
                window_seconds: 18_000,
                reset_at: "2026-04-08T16:50:52.000Z",
              },
              one_week: {
                used_percent: readManagedCurrentQuotaCalls === 1 ? 20 : 30,
                window_seconds: 604_800,
                reset_at: "2026-04-14T09:17:35.000Z",
              },
            };
          },
          watchManagedQuotaSignals: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            interruptController.abort();
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(readManagedCurrentQuotaCalls).toBeGreaterThanOrEqual(2);
      expect(stderr.read()).toContain("[debug] watch: reading managed Desktop quota reason=idle");
      const stdoutOutput = stdout.read();
      expect(stdoutOutput).toContain('quota account="current" usage=available');
      expect(stdoutOutput).toContain("5H=80% left");
      expect(stdoutOutput).toContain("1W=70% left");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch suppresses duplicate quota output when different MCP events read the same quota", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "plus",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 3,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 30,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":3},"secondaryWindow":{"usedPercent":30}}}}}',
              shouldAutoSwitch: false,
              quota: {
                plan_type: "plus",
                credits_balance: null,
                unlimited: false,
                fetched_at: "2026-04-08T15:20:00.000Z",
                five_hour: {
                  used_percent: 3,
                  window_seconds: 18_000,
                  reset_at: "2026-04-08T16:50:52.000Z",
                },
                one_week: {
                  used_percent: 30,
                  window_seconds: 604_800,
                  reset_at: "2026-04-14T09:17:35.000Z",
                },
              },
            });
            await options?.onQuotaSignal?.({
              requestId: "rpc:notification:account/rateLimits/updated",
              url: "mcp:account/rateLimits/updated",
              status: null,
              reason: "rpc_notification",
              bodySnippet:
                '{"type":"mcp-notification","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":3},"secondary":{"usedPercent":30}}}}',
              shouldAutoSwitch: false,
              quota: {
                plan_type: "plus",
                credits_balance: null,
                unlimited: false,
                fetched_at: "2026-04-08T15:20:00.000Z",
                five_hour: {
                  used_percent: 3,
                  window_seconds: 18_000,
                  reset_at: "2026-04-08T16:50:52.000Z",
                },
                one_week: {
                  used_percent: 30,
                  window_seconds: 604_800,
                  reset_at: "2026-04-14T09:17:35.000Z",
                },
              },
            });
          },
        }),
      });

      expect(exitCode).toBe(0);
      const quotaLines = stdout
        .read()
        .split("\n")
        .filter((line) => line.includes("quota account="));
      expect(quotaLines).toHaveLength(1);
      expect(quotaLines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=97% left 1W=70% left$/,
      );
      expect(stderr.read()).toContain(
        '[debug] watch: quota output unchanged for requestId=rpc:notification:account/rateLimits/updated',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch does not switch on non-exhausted quota reads", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const interruptController = new AbortController();

      const exitCode = await runCli(["watch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        interruptSignal: interruptController.signal,
        watchQuotaIdleReadIntervalMs: 10_000,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "team",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 72,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 63,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async () => {
            interruptController.abort();
          },
          applyManagedSwitch: async () => true,
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
      expect(stdout.read()).not.toContain('Auto-switched to');
      expect(stderr.read()).toContain('[debug] watch: auto-switch enabled');
      expect(stderr.read()).toContain(
        '[debug] watch: skipping auto switch for requestId=poll:startup because the event is informational only',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch reports connection loss and recovery while reconnecting", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--no-auto-switch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "team",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 72,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 63,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            await options?.onStatus?.({
              type: "disconnected",
              attempt: 1,
              error: "Codex Desktop devtools watch connection closed unexpectedly.",
            });
            await options?.onStatus?.({
              type: "reconnected",
              attempt: 1,
              error: null,
            });
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}',
              shouldAutoSwitch: true,
            });
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] reconnect-lost account="current" attempt=1 error="Codex Desktop devtools watch connection closed unexpectedly\."/,
      );
      expect(stderr.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] reconnect-ok account="current" attempt=1/,
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=28% left 1W=37% left/,
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch auto-switches on quota signals", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            const headers = new Headers(init?.headers);
            const accountId = headers.get("ChatGPT-Account-Id");

            if (accountId === "acct-watch-a") {
              return jsonResponse({
                plan_type: "plus",
                rate_limit: {
                  primary_window: {
                    used_percent: 100,
                    limit_window_seconds: 18_000,
                    reset_after_seconds: 500,
                    reset_at: 1_773_868_641,
                  },
                  secondary_window: {
                    used_percent: 100,
                    limit_window_seconds: 604_800,
                    reset_after_seconds: 6_000,
                    reset_at: 1_773_890_040,
                  },
                },
                credits: {
                  has_credits: false,
                  unlimited: false,
                  balance: "0",
                },
              });
            }

            if (accountId === "acct-watch-b") {
              return jsonResponse({
                plan_type: "plus",
                rate_limit: {
                  primary_window: {
                    used_percent: 20,
                    limit_window_seconds: 18_000,
                    reset_after_seconds: 500,
                    reset_at: 1_773_868_641,
                  },
                  secondary_window: {
                    used_percent: 30,
                    limit_window_seconds: 604_800,
                    reset_after_seconds: 6_000,
                    reset_at: 1_773_890_040,
                  },
                },
                credits: {
                  has_credits: true,
                  unlimited: false,
                  balance: "3",
                },
              });
            }
          }

          return textResponse("not found", 404);
        },
      });

      await writeCurrentAuth(homeDir, "acct-watch-a");
      await runCli(["save", "watch-a", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-watch-b");
      await runCli(["save", "watch-b", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-watch-a");

      const applyManagedSwitchCalls: Array<{ force?: boolean; timeoutMs?: number }> = [];
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          watchManagedQuotaSignals: async (options) => {
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"from_view","event":{"type":"mcp-request","request":{"id":"req-1","method":"account/rateLimits/read","params":{}}}}}',
            );
            options?.debugLogger?.(
              '{"method":"Bridge.message","params":{"direction":"for_view","event":{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}}}',
            );
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}',
              shouldAutoSwitch: true,
            });
          },
          applyManagedSwitch: async (options) => {
            applyManagedSwitchCalls.push({ ...options });
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain('"method":"Bridge.message"');
      expect(stderr.read()).toContain('"type":"mcp-request"');
      expect(stderr.read()).toContain('"type":"mcp-response"');
      expect(stderr.read()).toContain(
        '[debug] watch: quota signal matched reason=rpc_response requestId=rpc:req-1',
      );
      expect(stderr.read()).toContain('[debug] watch: auto-switch enabled');
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="watch-a" status=unavailable/,
      );
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] auto-switch from="watch-a" to="watch-b"/,
      );
      expect(applyManagedSwitchCalls).toEqual([{ force: false, timeoutMs: 900_000 }]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch skips switching when the shared switch lock is busy", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_860_000,
              },
              secondary_window: {
                used_percent: 10,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_880_000,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "9",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-watch-lock-a");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-watch-lock-b");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            command: "switch target",
            started_at: "2026-04-08T15:20:00.000Z",
          },
          null,
          2,
        )}\n`,
      );

      const stdout = captureWritable();
      const stderr = captureWritable();
      const exitCode = await runCli(["watch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          readManagedCurrentQuota: async () => ({
            plan_type: "plus",
            credits_balance: null,
            unlimited: false,
            fetched_at: "2026-04-08T15:20:00.000Z",
            five_hour: {
              used_percent: 100,
              window_seconds: 18_000,
              reset_at: "2026-04-08T16:50:52.000Z",
            },
            one_week: {
              used_percent: 10,
              window_seconds: 604_800,
              reset_at: "2026-04-14T09:17:35.000Z",
            },
          }),
          watchManagedQuotaSignals: async (options) => {
            await options?.onQuotaSignal?.({
              requestId: "rpc:req-1",
              url: "mcp:account/rateLimits/read",
              status: null,
              reason: "rpc_response",
              bodySnippet:
                '{"type":"mcp-response","message":{"id":"req-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}',
              shouldAutoSwitch: true,
            });
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain('auto-switch-skipped account="beta" reason=lock-busy');
      expect(stderr.read()).toContain(`switch lock is busy at ${lockPath}`);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-watch-lock-b");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch still warns when a non-managed Codex Desktop instance is running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_775_000_500,
                },
                secondary_window: {
                  used_percent: 15,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_775_006_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "5",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-switch-warning");
      await runCli(["save", "switch-warning", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-warning"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [{ pid: 321, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        }),
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain(
        'Warning: "codexm switch" updates local auth, but running Codex Desktop may still use the previous login state.',
      );
      expect(output).toContain(
        'Warning: Use "codexm launch" to start Codex Desktop with the selected auth; future switches can apply immediately to that session.',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch does not warn when the running Desktop instance is managed by codexm", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-managed");
      await runCli(["save", "switch-managed", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const calls: Array<{ force?: boolean; timeoutMs?: number }> = [];

      const exitCode = await runCli(["switch", "switch-managed"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) => {
            calls.push({ ...options });
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ force: false, timeoutMs: 120_000 }]);
      expect(stdout.read()).not.toContain("Existing sessions may still hold the previous login state.");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch skips managed Desktop refresh when the runtime already matches the target account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-same-runtime");
      await runCli(["save", "switch-same-runtime", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      let applyManagedSwitchCalls = 0;

      const exitCode = await runCli(["switch", "switch-same-runtime"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "acct-switch-same-runtime@example.com",
            plan_type: "plus",
            requires_openai_auth: false,
          }),
          applyManagedSwitch: async () => {
            applyManagedSwitchCalls += 1;
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(applyManagedSwitchCalls).toBe(0);
      expect(stdout.read()).toContain('Switched to "switch-same-runtime"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch still refreshes managed Desktop when multiple managed snapshots share the same runtime-visible identity", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 9,
                limit_window_seconds: 18_000,
                reset_after_seconds: 300,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 66,
                limit_window_seconds: 604_800,
                reset_after_seconds: 3_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "5",
            },
          });
        },
      });
      await writeCurrentAuth(homeDir, "acct-shared-runtime", "chatgpt", "plus", "user-a");
      await runCli(["save", "shared-runtime-a", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-shared-runtime", "chatgpt", "plus", "user-b");
      await runCli(["save", "shared-runtime-b", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      let applyManagedSwitchCalls = 0;

      const exitCode = await runCli(["switch", "shared-runtime-a"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "acct-shared-runtime@example.com",
            plan_type: "plus",
            requires_openai_auth: false,
          }),
          applyManagedSwitch: async () => {
            applyManagedSwitchCalls += 1;
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(applyManagedSwitchCalls).toBe(1);
      expect(stdout.read()).toContain('Switched to "shared-runtime-a"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch still refreshes managed Desktop when the runtime account differs from the target account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-runtime-drift");
      await runCli(["save", "switch-runtime-drift", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const calls: Array<{ force?: boolean; timeoutMs?: number }> = [];

      const exitCode = await runCli(["switch", "switch-runtime-drift"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          readManagedCurrentAccount: async () => ({
            auth_mode: "chatgpt",
            email: "other-account@example.com",
            plan_type: "plus",
            requires_openai_auth: false,
          }),
          applyManagedSwitch: async (options) => {
            calls.push({ ...options });
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ force: false, timeoutMs: 120_000 }]);
      expect(stdout.read()).toContain('Switched to "switch-runtime-drift"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch reports wait progress while refreshing a managed Desktop session", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-progress");
      await runCli(["save", "switch-progress", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-progress", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        managedDesktopWaitStatusDelayMs: 1,
        managedDesktopWaitStatusIntervalMs: 5,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
          applyManagedSwitch: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        account: {
          name: "switch-progress",
        },
      });
      expect(stderr.read()).toContain(
        "Waiting for the current Codex Desktop thread to finish before applying the switch...",
      );
      expect(stderr.read()).toContain("Still waiting for the current Codex Desktop thread to finish");
      expect(stderr.read()).toContain("Applied the switch to the managed Codex Desktop session.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch warns when refreshing the running codexm-managed Desktop session fails", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-restart-fail");
      await runCli(["save", "switch-restart-fail", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-restart-fail"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => {
            throw new Error("restart failed");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain(
        "Failed to refresh the running codexm-managed Codex Desktop session: restart failed",
      );
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch succeeds even when Desktop inspection fails after the auth has been switched", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-inspection");
      await runCli(["save", "switch-inspection", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-inspection"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            throw new Error("ps failed");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain('Switched to "switch-inspection"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch --force immediately restarts a codexm-managed Desktop session", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-force");
      await runCli(["save", "switch-force", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const calls: Array<{ force?: boolean; timeoutMs?: number }> = [];

      const exitCode = await runCli(["switch", "switch-force", "--force"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) => {
            calls.push({ ...options });
            return true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ force: true, timeoutMs: 120_000 }]);
      expect(stdout.read()).toContain('Switched to "switch-force"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch --force falls back to force-kill when managed Desktop devtools times out", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-force-timeout");
      await runCli(["save", "switch-force-timeout", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const applyCalls: Array<{ force?: boolean; timeoutMs?: number }> = [];
      const quitCalls: Array<{ force?: boolean } | undefined> = [];

      const exitCode = await runCli(["switch", "switch-force-timeout", "--force", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) => {
            applyCalls.push({ ...options });
            throw new Error("Timed out waiting for Codex Desktop devtools response.");
          },
          quitRunningApps: async (options) => {
            quitCalls.push(options);
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(applyCalls).toEqual([{ force: true, timeoutMs: 120_000 }]);
      expect(quitCalls).toEqual([{ force: true }]);
      const payload = JSON.parse(stdout.read());
      expect(payload.ok).toBe(true);
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Force-killed the running codexm-managed Codex Desktop session"),
        ]),
      );
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch --force falls back to force-kill when managed Desktop devtools target info is unavailable", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-force-target");
      await runCli(["save", "switch-force-target", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const quitCalls: Array<{ force?: boolean } | undefined> = [];

      const exitCode = await runCli(["switch", "switch-force-target", "--force"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => {
            throw new Error("Could not find the local Codex Desktop devtools target.");
          },
          quitRunningApps: async (options) => {
            quitCalls.push(options);
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(quitCalls).toEqual([{ force: true }]);
      expect(stdout.read()).toContain('Switched to "switch-force-target"');
      expect(stdout.read()).toContain(
        "Warning: Force-killed the running codexm-managed Codex Desktop session",
      );
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch prints debug details when --debug is enabled", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-debug");
      await runCli(["save", "switch-debug", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "switch-debug", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => true,
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain('Switched to "switch-debug"');
      expect(stderr.read()).toContain("[debug] switch: mode=manual target=switch-debug force=false");
      expect(stderr.read()).toContain("[debug] switch: completed target=switch-debug");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch does not roll back local auth when managed Desktop refresh is interrupted", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-interrupt-a");
      await runCli(["save", "switch-interrupt-a", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-switch-interrupt-b");
      await runCli(["save", "switch-interrupt-b", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const interruptController = new AbortController();
      setTimeout(() => {
        interruptController.abort();
      }, 0);

      const exitCode = await runCli(["switch", "switch-interrupt-a", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        interruptSignal: interruptController.signal,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) =>
            await new Promise<boolean>((_resolve, reject) => {
              if (options?.signal?.aborted) {
                const error = new Error("Managed Codex Desktop refresh was interrupted.");
                error.name = "AbortError";
                reject(error);
                return;
              }

              options?.signal?.addEventListener(
                "abort",
                () => {
                  const error = new Error("Managed Codex Desktop refresh was interrupted.");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            }),
        }),
      });

      expect(exitCode).toBe(0);
      const payload = JSON.parse(stdout.read());
      expect(payload).toMatchObject({
        ok: true,
        action: "switch",
        account: {
          name: "switch-interrupt-a",
          account_id: "acct-switch-interrupt-a",
        },
      });
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "Refreshing the running codexm-managed Codex Desktop session was interrupted",
          ),
        ]),
      );
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-switch-interrupt-a");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("errors on unknown flags with a suggestion instead of silently ignoring them", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["list", "--josn"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      const errorOutput = stderr.read();
      expect(errorOutput).toContain('Unknown flag "--josn" for command "list".');
      expect(errorOutput).toContain('Did you mean "--json"?');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refreshes quota automatically after switch", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 9,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 300,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 66,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 3_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "8",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-switch-a");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-switch-b");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const switchStdout = captureWritable();
      const switchCode = await runCli(["switch", "alpha", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [],
        }),
        stdout: switchStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(switchCode).toBe(0);
      expect(JSON.parse(switchStdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        account: {
          name: "alpha",
        },
        quota: {
          available: "available",
          refresh_status: "ok",
          credits_balance: 8,
          five_hour: {
            used_percent: 9,
          },
          one_week: {
            used_percent: 66,
          },
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("marks availability from 5h and 1w usage thresholds", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-threshold-a") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 91,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "5",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 15,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 100,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-threshold-a");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-threshold-b");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const code = await runCli(["list", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        successes: [
          {
            name: "alpha",
            available: "available",
          },
          {
            name: "beta",
            available: "unavailable",
          },
        ],
        failures: [],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports auto switch and dry-run selection", async () => {
    const homeDir = await createTempHome();

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-auto-alpha") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 60,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: nowSeconds + 500,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: nowSeconds + 6_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "3",
              },
            });
          }

          if (accountId === "acct-auto-beta") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 50,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: nowSeconds + 500,
                },
                secondary_window: {
                  used_percent: 80,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: nowSeconds + 6_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 100,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: nowSeconds + 500,
              },
              secondary_window: {
                used_percent: 10,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: nowSeconds + 6_000,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-auto-alpha");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-beta");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-gamma");
      await runCli(["save", "gamma", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const dryRunStdout = captureWritable();
      const dryRunCode = await runCli(["switch", "--auto", "--dry-run", "--json"], {
        store,
        stdout: dryRunStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(dryRunCode).toBe(0);
      const dryRunPayload = JSON.parse(dryRunStdout.read());
      expect(dryRunPayload).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        dry_run: true,
        selected: {
          name: "beta",
          available: "available",
          current_score: 7.5,
          remain_5h: 50,
          remain_1w: 20,
          remain_5h_in_1w_units: 7.5,
          five_hour_to_one_week_ratio: 6.67,
        },
      });
      expect(dryRunPayload.selected.score_1h).toBeCloseTo(13.96, 2);
      expect(dryRunPayload.selected.projected_5h_1h).toBeCloseTo(93.06, 1);
      expect(dryRunPayload.selected.projected_5h_in_1w_units_1h).toBeCloseTo(13.96, 2);
      expect(dryRunPayload.selected.projected_1w_1h).toBeCloseTo(20, 2);

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-gamma");

      const switchStdout = captureWritable();
      const switchCode = await runCli(["switch", "--auto", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [],
        }),
        stdout: switchStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(switchCode).toBe(0);
      const switchPayload = JSON.parse(switchStdout.read());
      expect(switchPayload).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        account: {
          name: "beta",
          account_id: "acct-auto-beta",
        },
        selected: {
          name: "beta",
          current_score: 7.5,
          five_hour_to_one_week_ratio: 6.67,
        },
        quota: {
          available: "available",
          refresh_status: "ok",
          five_hour: {
            used_percent: 50,
          },
          one_week: {
            used_percent: 80,
          },
        },
      });
      expect(switchPayload.selected.score_1h).toBeCloseTo(13.96, 2);

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-beta");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch --auto --force falls back to force-kill when managed Desktop devtools refresh fails", async () => {
    const homeDir = await createTempHome();

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-auto-force-best") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: nowSeconds + 500,
                },
                secondary_window: {
                  used_percent: 30,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: nowSeconds + 6_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 95,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: nowSeconds + 500,
              },
              secondary_window: {
                used_percent: 90,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: nowSeconds + 6_000,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-auto-force-current");
      await runCli(["save", "currentish", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-force-best");
      await runCli(["save", "best", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-force-current");

      const stdout = captureWritable();
      const stderr = captureWritable();
      const quitCalls: Array<{ force?: boolean } | undefined> = [];

      const exitCode = await runCli(["switch", "--auto", "--force", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => {
            throw new Error("Failed to communicate with Codex Desktop devtools.");
          },
          quitRunningApps: async (options) => {
            quitCalls.push(options);
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(quitCalls).toEqual([{ force: true }]);
      const payload = JSON.parse(stdout.read());
      expect(payload).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        account: {
          name: "best",
          account_id: "acct-auto-force-best",
        },
      });
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Force-killed the running codexm-managed Codex Desktop session"),
        ]),
      );
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("skips auto switch when current account is already the best available account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-best-current") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_860_000,
                },
                secondary_window: {
                  used_percent: 20,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_880_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 40,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 70,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-best-current");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-other");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-best-current");

      const stdout = captureWritable();
      const code = await runCli(["switch", "--auto", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        skipped: true,
        reason: "already_current_best",
        account: {
          name: "alpha",
          account_id: "acct-best-current",
        },
        selected: {
          name: "alpha",
          available: "available",
        },
      });

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-best-current");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch refuses to run while another switch or launch operation holds the shared lock", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-switch-lock-target");
      await runCli(["save", "target", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-switch-lock-original");

      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            command: "switch other",
            started_at: "2026-04-08T15:20:00.000Z",
          },
          null,
          2,
        )}\n`,
      );

      const stderr = captureWritable();
      const exitCode = await runCli(["switch", "target"], {
        store,
        stdout: captureWritable().stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stderr.read()).toContain("Another codexm switch or launch operation is already in progress.");
      expect(stderr.read()).toContain(lockPath);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-switch-lock-original");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("validates manual switch account name before acquiring the shared lock", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            command: "switch other",
            started_at: "2026-04-08T15:20:00.000Z",
          },
          null,
          2,
        )}\n`,
      );

      const stderr = captureWritable();
      const exitCode = await runCli(["switch", "bad/name"], {
        store,
        stdout: captureWritable().stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stderr.read()).toContain("Account name must match");
      expect(stderr.read()).not.toContain("Another codexm switch or launch operation is already in progress.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch --auto refuses to run while another switch or launch operation holds the shared lock", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_860_000,
              },
              secondary_window: {
                used_percent: 10,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_880_000,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "9",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-auto-lock-target");
      await runCli(["save", "target", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-lock-original");

      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            command: "launch --auto",
            started_at: "2026-04-08T15:20:00.000Z",
          },
          null,
          2,
        )}\n`,
      );

      const stderr = captureWritable();
      const exitCode = await runCli(["switch", "--auto"], {
        store,
        stdout: captureWritable().stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stderr.read()).toContain("Another codexm switch or launch operation is already in progress.");
      expect(stderr.read()).toContain(lockPath);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-lock-original");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("launch rejects on Linux with guidance to use codexm run", async () => {
    const homeDir = await createTempHome();
    const restorePlatform = setPlatformForTesting("linux");

    try {
      const store = createAccountStore(homeDir);
      const stderr = captureWritable();

      const exitCode = await runCli(["launch"], {
        store,
        stdout: captureWritable().stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
      });

      expect(exitCode).toBe(1);
      const output = stderr.read();
      expect(output).toContain("codexm launch is not supported on Linux");
      expect(output).toContain("codexm run");
    } finally {
      restorePlatform();
      await cleanupTempHome(homeDir);
    }
  });

  test("launch rejects on WSL with guidance to use codexm run", async () => {
    const homeDir = await createTempHome();
    const restorePlatform = setPlatformForTesting("wsl");

    try {
      const store = createAccountStore(homeDir);
      const stderr = captureWritable();

      const exitCode = await runCli(["launch"], {
        store,
        stdout: captureWritable().stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
      });

      expect(exitCode).toBe(1);
      const output = stderr.read();
      expect(output).toContain("codexm launch is not supported on WSL");
      expect(output).toContain("codexm run");
    } finally {
      restorePlatform();
      await cleanupTempHome(homeDir);
    }
  });

  test("launch --auto also rejects on non-macOS", async () => {
    const homeDir = await createTempHome();
    const restorePlatform = setPlatformForTesting("linux");

    try {
      const store = createAccountStore(homeDir);
      const stderr = captureWritable();

      const exitCode = await runCli(["launch", "--auto"], {
        store,
        stdout: captureWritable().stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
      });

      expect(exitCode).toBe(1);
      expect(stderr.read()).toContain("codexm launch is not supported on Linux");
    } finally {
      restorePlatform();
      await cleanupTempHome(homeDir);
    }
  });

  test("switch --force warns and downgrades when no Desktop session is running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_775_000_500,
                },
                secondary_window: {
                  used_percent: 15,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_775_006_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "5",
              },
            });
          }
          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-force-test");
      await runCli(["save", "force-test", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["switch", "force-test", "--force"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => false,
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [],
        }),
      });

      // Switch should still succeed (downgraded, not rejected)
      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Switched to");
      // But stderr should warn about --force being meaningless
      const stderrOutput = stderr.read();
      expect(stderrOutput).toContain("--force is only meaningful with a managed Desktop session");
      expect(stderrOutput).toContain("codexm run");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

});
