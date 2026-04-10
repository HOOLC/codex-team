import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  textResponse,
  writeCurrentAuth,
} from "./test-helpers.js";
import {
  captureWritable,
  createDesktopLauncherStub,
  createInteractiveStdin,
  createWatchProcessManagerStub,
} from "./cli-fixtures.js";

describe("CLI", () => {
  test("watch refuses to run when there is no managed desktop session", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => false,
        }),
      });

      expect(exitCode).toBe(1);
      expect(stderr.read()).toContain("No codexm-managed Codex Desktop session is running.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch writes quota history records when runtime quota changes", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-watch-history");
      await store.saveCurrentAccount("plus-main");

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
      expect(history).toContain("\"used_percent\":10");
      expect(history).toContain("\"used_percent\":20");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --status reports when no background watch is running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--status"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: false,
            state: null,
          }),
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Watch: not running");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --status reports running background watch details", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["watch", "--status"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        watchProcessManager: createWatchProcessManagerStub({
          getStatus: async () => ({
            running: true,
            state: {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              debug: false,
            },
          }),
        }),
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("Watch: running (pid 43210)");
      expect(output).toContain("Started at: 2026-04-08T13:58:00.000Z");
      expect(output).toContain("Auto-switch: enabled");
      expect(output).toContain("Log: /tmp/watch.log");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --detach starts a background auto-switch watcher by default", async () => {
    const homeDir = await createTempHome();
    let startedOptions: { autoSwitch: boolean; debug: boolean } | null = null;

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["watch", "--detach", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
        }),
        watchProcessManager: createWatchProcessManagerStub({
          startDetached: async (options) => {
            startedOptions = options;
            return {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              debug: true,
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(startedOptions).toEqual({
        autoSwitch: true,
        debug: true,
      });
      expect(stdout.read()).toContain("Started background watch (pid 43210).");
      expect(stdout.read()).toContain("Log: /tmp/watch.log");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --detach --no-auto-switch starts a background watcher without auto-switch", async () => {
    const homeDir = await createTempHome();
    let startedOptions: { autoSwitch: boolean; debug: boolean } | null = null;

    try {
      const store = createAccountStore(homeDir);

      const exitCode = await runCli(["watch", "--detach", "--no-auto-switch"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub({
          isManagedDesktopRunning: async () => true,
        }),
        watchProcessManager: createWatchProcessManagerStub({
          startDetached: async (options) => {
            startedOptions = options;
            return {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: false,
              debug: false,
            };
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(startedOptions).toEqual({
        autoSwitch: false,
        debug: false,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("watch --stop stops the background watcher", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["watch", "--stop"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        watchProcessManager: createWatchProcessManagerStub({
          stop: async () => ({
            running: false,
            stopped: true,
            state: {
              pid: 43210,
              started_at: "2026-04-08T13:58:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              debug: false,
            },
          }),
        }),
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Stopped background watch (pid 43210).");
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
            await new Promise((resolve) => setTimeout(resolve, 15));
            interruptController.abort();
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(readManagedCurrentQuotaCalls).toBeGreaterThanOrEqual(2);
      expect(stderr.read()).toContain("[debug] watch: reading managed Desktop quota reason=idle");
      expect(stdout.read()).toMatch(
        /\[\d{2}:\d{2}:\d{2}\] quota account="current" usage=available 5H=80% left 1W=70% left/,
      );
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
      expect(applyManagedSwitchCalls).toEqual([{ force: false, timeoutMs: 600_000 }]);
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
            available: "almost unavailable",
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
          current_score: 6.25,
          remain_5h: 50,
          remain_1w: 20,
          remain_5h_in_1w_units: 6.25,
          five_hour_windows_per_week: 8,
        },
      });
      expect(dryRunPayload.selected.score_1h).toBeCloseTo(11.63, 2);
      expect(dryRunPayload.selected.projected_5h_1h).toBeCloseTo(93.06, 1);
      expect(dryRunPayload.selected.projected_5h_in_1w_units_1h).toBeCloseTo(11.63, 2);
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
          current_score: 6.25,
          five_hour_windows_per_week: 8,
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
      expect(switchPayload.selected.score_1h).toBeCloseTo(11.63, 2);

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-beta");
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
});
