import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import { setPlatformForTesting } from "../src/platform.js";
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

describe("CLI Launch", () => {
  let restorePlatform: (() => void) | undefined;

  beforeEach(() => {
    restorePlatform = setPlatformForTesting("darwin");
  });

  afterEach(() => {
    restorePlatform?.();
    restorePlatform = undefined;
  });

  test("launches desktop with current auth when no account is provided", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const calls: string[] = [];
      const stdout = captureWritable();
      const stderr = captureWritable();
      let listCalls = 0;

      const exitCode = await runCli(["launch"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 501, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
          },
          quitRunningApps: async () => {
            calls.push("quit");
          },
          launch: async () => {
            calls.push("launch");
          },
          writeManagedState: async () => {
            calls.push("write-state");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual(["launch", "write-state"]);
      expect(stdout.read()).toContain("Launched Codex Desktop with current auth.");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("prints debug details during launch when --debug is enabled", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let listCalls = 0;

      const exitCode = await runCli(["launch", "--debug"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 501, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
          },
          launch: async () => undefined,
        }),
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain("[debug] launch: using app path /Applications/Codex.app");
      expect(stderr.read()).toContain("[debug] launch: recorded managed desktop pid=501 port=39223");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("validates launch account name before desktop checks", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      let insideDesktopChecks = 0;

      const exitCode = await runCli(["launch", "bad/name"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          isRunningInsideDesktopShell: async () => {
            insideDesktopChecks += 1;
            return true;
          },
        }),
      });

      expect(exitCode).toBe(1);
      expect(insideDesktopChecks).toBe(0);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain("Account name must match");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switches account before launch when account is provided", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch");
      await runCli(["save", "launch-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const calls: string[] = [];
      const stdout = captureWritable();
      const stderr = captureWritable();
      let listCalls = 0;
      const exitCode = await runCli(["launch", "launch-main"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 502, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
          },
          quitRunningApps: async () => {
            calls.push("quit");
          },
          launch: async () => {
            calls.push("launch");
          },
          writeManagedState: async () => {
            calls.push("write-state");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual(["launch", "write-state"]);
      expect(stdout.read()).toContain('Switched to "launch-main"');
      expect(stdout.read()).toContain('Launched Codex Desktop with "launch-main"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refuses to relaunch running desktop in non-interactive mode", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      daemonProcessManager: createDaemonProcessManagerStub(),
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async () => undefined,
        launch: async () => undefined,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("Refusing to relaunch Codex Desktop in a non-interactive terminal.");
  });

  test("refuses launch from inside Codex Desktop before switching accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch-target");
      await runCli(["save", "launch-target", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-original");
      const stdout = captureWritable();
      const stderr = captureWritable();
      const exitCode = await runCli(["launch", "launch-target"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          isRunningInsideDesktopShell: async () => true,
        }),
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain(
        'Refusing to run "codexm launch" from inside Codex Desktop because quitting the app would terminate this session. Run this command from an external terminal instead.',
      );
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-original");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("fails when Codex Desktop is not installed", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      daemonProcessManager: createDaemonProcessManagerStub(),
      desktopLauncher: createDesktopLauncherStub({
        findInstalledApp: async () => null,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("Codex Desktop not found at /Applications/Codex.app.");
  });

  test("does not switch accounts when launch fails before Desktop startup", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch-before");
      await runCli(["save", "launch-before", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-current");

      const exitCode = await runCli(["launch", "launch-before"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          findInstalledApp: async () => null,
        }),
      });

      expect(exitCode).toBe(1);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-current");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("aborts non-managed relaunch when the user rejects force-kill confirmation", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      daemonProcessManager: createDaemonProcessManagerStub(),
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async () => {
          calls.push("quit");
        },
        launch: async () => {
          calls.push("launch");
        },
      }),
    });

    stdin.emitInput("n\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(stdout.read()).toContain("Force-kill it and relaunch with the selected auth?");
    expect(stdout.read()).toContain("Aborted.");
    expect(stderr.read()).toBe("");
  });

  test("force-kills a non-managed Desktop instance after confirmation", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];
    let listCalls = 0;

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      daemonProcessManager: createDaemonProcessManagerStub(),
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => {
          listCalls += 1;
          return listCalls <= 2
            ? [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }]
            : [{ pid: 456, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
        },
        quitRunningApps: async (options) => {
          calls.push(options?.force === true ? "quit:force" : "quit");
        },
        launch: async () => {
          calls.push("launch");
        },
        writeManagedState: async () => {
          calls.push("write-state");
        },
      }),
    });

    stdin.emitInput("y\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["quit:force", "launch", "write-state"]);
    expect(stdout.read()).toContain("Force-kill it and relaunch with the selected auth?");
    expect(stdout.read()).toContain("Closed existing Codex Desktop instance and launched a new one.");
    expect(stderr.read()).toBe("");
  });

  test("relaunches a codexm-managed Desktop instance without force-kill", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];
    let listCalls = 0;

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      daemonProcessManager: createDaemonProcessManagerStub(),
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => {
          listCalls += 1;
          return listCalls <= 2
            ? [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }]
            : [{ pid: 456, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
        },
        readManagedState: async () => ({
          pid: 123,
          app_path: "/Applications/Codex.app",
          remote_debugging_port: 39223,
          managed_by_codexm: true,
          started_at: "2026-04-08T00:00:00.000Z",
        }),
        quitRunningApps: async (options) => {
          calls.push(options?.force === true ? "quit:force" : "quit");
        },
        launch: async () => {
          calls.push("launch");
        },
        writeManagedState: async () => {
          calls.push("write-state");
        },
      }),
    });

    stdin.emitInput("y\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["quit", "launch", "write-state"]);
    expect(stdout.read()).toContain("Close it and relaunch with the selected auth?");
    expect(stderr.read()).toBe("");
  });

  test("does not launch a new Desktop instance when quitting the old one fails", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      daemonProcessManager: createDaemonProcessManagerStub(),
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async (options) => {
          calls.push(options?.force === true ? "quit:force" : "quit");
          throw new Error("quit failed");
        },
        launch: async () => {
          calls.push("launch");
        },
      }),
    });

    stdin.emitInput("y\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(1);
    expect(calls).toEqual(["quit:force"]);
    expect(stderr.read()).toContain("quit failed");
  });

  test("fails launch when managed desktop tracking cannot be recorded", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      daemonProcessManager: createDaemonProcessManagerStub(),
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [],
        launch: async () => {
          calls.push("launch");
        },
        clearManagedState: async () => {
          calls.push("clear-state");
        },
        writeManagedState: async () => {
          calls.push("write-state");
        },
      }),
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual(["launch", "clear-state"]);
    expect(stderr.read()).toContain(
      "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
    );
  });

  test("restores the previous auth when launch fails after switching accounts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-launch-target");
      await runCli(["save", "launch-target", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-original");

      const exitCode = await runCli(["launch", "launch-target"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => [
            { pid: 999, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" },
          ],
          launch: async () => undefined,
          writeManagedState: async () => {
            throw new Error("write-state failed");
          },
          clearManagedState: async () => undefined,
        }),
      });

      expect(exitCode).toBe(1);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-original");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("launch --auto selects the best account before launching Desktop", async () => {
    const homeDir = await createTempHome();
    const nowSeconds = 1_775_000_000;

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-launch-auto-best") {
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
                  used_percent: 20,
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
                used_percent: 70,
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
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-launch-auto-best");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-auto-other");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-launch-auto-other");

      const stdout = captureWritable();
      const calls: string[] = [];
      let listCalls = 0;
      const exitCode = await runCli(["launch", "--auto"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        daemonProcessManager: createDaemonProcessManagerStub(),
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 503, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
          },
          launch: async () => {
            calls.push("launch");
          },
          writeManagedState: async () => {
            calls.push("write-state");
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual(["launch", "write-state"]);
      expect(stdout.read()).toContain('Switched to "alpha"');
      expect(stdout.read()).toContain('Launched Codex Desktop with "alpha"');
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-auto-best");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("launch starts the baseline daemon by default", async () => {
    const homeDir = await createTempHome();
    let ensureConfigArgs: Record<string, unknown> | null = null;
    let listCalls = 0;

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();

      const exitCode = await runCli(["launch"], {
        store,
        stdout: stdout.stream,
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
                port: 14555,
                base_url: "http://127.0.0.1:14555/backend-api",
                openai_base_url: "http://127.0.0.1:14555/v1",
                debug: false,
              },
            };
          },
        }),
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 503, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
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
      expect(stdout.read()).toContain("Started background daemon (pid 54321).");
      expect(stdout.read()).toContain("Launched Codex Desktop with current auth.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("launch respects CODEXM_PROXY_PORT when starting the shared daemon", async () => {
    const homeDir = await createTempHome();
    let ensureConfigArgs: Record<string, unknown> | null = null;
    let listCalls = 0;

    try {
      const store = createAccountStore(homeDir);

      await withEnvVar(PROXY_PORT_ENV_VAR, "16658", async () => {
        const exitCode = await runCli(["launch"], {
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
                  port: 16658,
                  base_url: "http://127.0.0.1:16658/backend-api",
                  openai_base_url: "http://127.0.0.1:16658/v1",
                  debug: false,
                },
              };
            },
          }),
          desktopLauncher: createDesktopLauncherStub({
            listRunningApps: async () => {
              listCalls += 1;
              return listCalls === 1
                ? []
                : [{ pid: 503, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223" }];
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
        port: 16658,
        base_url: "http://127.0.0.1:16658/backend-api",
        openai_base_url: "http://127.0.0.1:16658/v1",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
