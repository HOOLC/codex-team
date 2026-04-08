import { PassThrough } from "node:stream";

import { describe, expect, test } from "@rstest/core";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import packageJson from "../package.json";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store.js";
import type {
  CodexDesktopLauncher,
  ManagedCodexDesktopState,
  RunningCodexDesktop,
} from "../src/codex-desktop-launch.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  textResponse,
  writeCurrentConfig,
  writeCurrentApiKeyAuth,
  writeCurrentAuth,
} from "./test-helpers.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function captureWritable(): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => output,
  };
}

function createDesktopLauncherStub(overrides: Partial<{
  findInstalledApp: () => Promise<string | null>;
  listRunningApps: () => Promise<RunningCodexDesktop[]>;
  quitRunningApps: () => Promise<void>;
  launch: (appPath: string) => Promise<void>;
  writeManagedState: (state: ManagedCodexDesktopState) => Promise<void>;
  readManagedState: () => Promise<ManagedCodexDesktopState | null>;
  clearManagedState: () => Promise<void>;
  isManagedDesktopRunning: () => Promise<boolean>;
  applyManagedSwitch: (options?: {
    force?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<boolean>;
}> = {}): CodexDesktopLauncher {
  return {
    findInstalledApp: overrides.findInstalledApp ?? (async () => "/Applications/Codex.app"),
    listRunningApps: overrides.listRunningApps ?? (async () => []),
    quitRunningApps: overrides.quitRunningApps ?? (async () => undefined),
    launch: overrides.launch ?? (async () => undefined),
    writeManagedState: overrides.writeManagedState ?? (async () => undefined),
    readManagedState: overrides.readManagedState ?? (async () => null),
    clearManagedState: overrides.clearManagedState ?? (async () => undefined),
    isManagedDesktopRunning: overrides.isManagedDesktopRunning ?? (async () => false),
    applyManagedSwitch: overrides.applyManagedSwitch ?? (async () => false),
  };
}

function createInteractiveStdin(): NodeJS.ReadStream & {
  emitInput: (value: string) => void;
  pauseCalls: number;
  resumeCalls: number;
} {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    emitInput: (value: string) => void;
    pauseCalls: number;
    resumeCalls: number;
  };

  stream.isTTY = true;
  stream.pauseCalls = 0;
  stream.resumeCalls = 0;

  const originalPause = stream.pause.bind(stream);
  stream.pause = (() => {
    stream.pauseCalls += 1;
    return originalPause();
  }) as typeof stream.pause;

  const originalResume = stream.resume.bind(stream);
  stream.resume = (() => {
    stream.resumeCalls += 1;
    return originalResume();
  }) as typeof stream.resume;

  stream.emitInput = (value: string) => {
    stream.write(value);
  };

  return stream;
}

describe("CLI", () => {
  test("prints version from --version", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["--version"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toBe(`${packageJson.version}\n`);
    expect(stderr.read()).toBe("");
  });

  test("includes version flag in help output", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const output = await (async () => {
      const exitCode = await runCli(["--help"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      return stdout.read();
    })();

    expect(output).toContain("codexm --version");
    expect(output).toContain("codexm launch [name] [--json]");
    expect(stderr.read()).toBe("");
  });

  test("supports save and current in json mode", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli");

      const stdout = captureWritable();
      const stderr = captureWritable();

      const saveCode = await runCli(["save", "cli-main", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(saveCode).toBe(0);
      expect(JSON.parse(stdout.read()).account.name).toBe("cli-main");

      const currentStdout = captureWritable();
      const currentCode = await runCli(["current", "--json"], {
        store,
        stdout: currentStdout.stream,
        stderr: stderr.stream,
      });

      expect(currentCode).toBe(0);
      expect(JSON.parse(currentStdout.read())).toMatchObject({
        exists: true,
        managed: true,
        matched_accounts: ["cli-main"],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports current and list for apikey auth snapshots", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-cli-primary");
      await writeCurrentConfig(
        homeDir,
        `model_provider = "custom"

[model_providers.custom]
base_url = "https://proxy-cli.example/v1"
wire_api = "responses"
`,
      );

      const saveCode = await runCli(["save", "cli-key", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      expect(saveCode).toBe(0);

      const currentStdout = captureWritable();
      const currentCode = await runCli(["current", "--json"], {
        store,
        stdout: currentStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(currentCode).toBe(0);
      expect(JSON.parse(currentStdout.read())).toMatchObject({
        exists: true,
        auth_mode: "apikey",
        managed: true,
        matched_accounts: ["cli-key"],
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);
      expect(JSON.parse(listStdout.read())).toMatchObject({
        successes: [
          {
            name: "cli-key",
            refresh_status: "unsupported",
            available: null,
            plan_type: null,
            credits_balance: null,
            five_hour: null,
            one_week: null,
          },
        ],
        failures: [],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports update and rejects unmanaged current auth", async () => {
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
                  used_percent: 20,
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
                balance: "3",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-update");
      await runCli(["save", "cli-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-update", "chatgpt", "pro");
      const updateStdout = captureWritable();
      const updateStderr = captureWritable();
      const updateCode = await runCli(["update", "--json"], {
        store,
        stdout: updateStdout.stream,
        stderr: updateStderr.stream,
      });

      expect(updateCode).toBe(0);
      expect(JSON.parse(updateStdout.read())).toMatchObject({
        ok: true,
        action: "update",
        account: {
          name: "cli-main",
          auth_mode: "chatgpt",
        },
        quota: {
          refresh_status: "ok",
          credits_balance: 3,
          plan_type: "plus",
          five_hour: {
            used_percent: 20,
          },
          one_week: {
            used_percent: 70,
          },
        },
      });

      await writeCurrentAuth(homeDir, "acct-unmanaged");
      const unmanagedStdout = captureWritable();
      const unmanagedStderr = captureWritable();
      const unmanagedCode = await runCli(["update", "--json"], {
        store,
        stdout: unmanagedStdout.stream,
        stderr: unmanagedStderr.stream,
      });

      expect(unmanagedCode).toBe(1);
      expect(JSON.parse(unmanagedStderr.read())).toMatchObject({
        ok: false,
        error: "Current account is not managed.",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports interactive remove without leaving stdin active", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-remove");
      await runCli(["save", "remove-me", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdin = createInteractiveStdin();
      const stdout = captureWritable();
      const stderr = captureWritable();
      const removePromise = runCli(["remove", "remove-me"], {
        store,
        stdin,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      stdin.emitInput("y\n");

      const removeCode = await removePromise;
      expect(removeCode).toBe(0);
      expect(stdout.read()).toBe('Remove saved account "remove-me"? [y/N] \nRemoved account "remove-me".\n');
      expect(stderr.read()).toBe("");
      expect(stdin.resumeCalls).toBeGreaterThanOrEqual(1);
      expect(stdin.pauseCalls).toBeGreaterThanOrEqual(1);

      const accounts = await store.listAccounts();
      expect(accounts.accounts).toHaveLength(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
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
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 501, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
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
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => {
            listCalls += 1;
            return listCalls === 1
              ? []
              : [{ pid: 502, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
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
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async () => undefined,
        launch: async () => undefined,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("Refusing to relaunch Codex Desktop in a non-interactive terminal.");
  });

  test("fails when Codex Desktop is not installed", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
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

  test("aborts relaunch when the user rejects confirmation", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
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
    expect(stdout.read()).toContain("Aborted.");
    expect(stderr.read()).toBe("");
  });

  test("relaunches an existing Desktop instance after confirmation", async () => {
    const stdin = createInteractiveStdin();
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];
    let listCalls = 0;

    const launchPromise = runCli(["launch"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => {
          listCalls += 1;
          return listCalls <= 2
            ? [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }]
            : [{ pid: 456, command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223" }];
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

    stdin.emitInput("y\n");
    const exitCode = await launchPromise;

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["quit", "launch", "write-state"]);
    expect(stdout.read()).toContain("Closed existing Codex Desktop instance and launched a new one.");
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
      desktopLauncher: createDesktopLauncherStub({
        listRunningApps: async () => [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" }],
        quitRunningApps: async () => {
          calls.push("quit");
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
    expect(calls).toEqual(["quit"]);
    expect(stderr.read()).toContain("quit failed");
  });

  test("fails launch when managed desktop tracking cannot be recorded", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const calls: string[] = [];

    const exitCode = await runCli(["launch"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
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
        desktopLauncher: createDesktopLauncherStub({
          listRunningApps: async () => [],
          launch: async () => undefined,
        }),
      });

      expect(exitCode).toBe(1);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-launch-original");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switch still warns when a non-managed Codex Desktop instance is running", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
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

  test("supports list as quota refresh in json mode", async () => {
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
                  used_percent: 15,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota");
      await runCli(["save", "quota-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });
      expect(listCode).toBe(0);
      expect(JSON.parse(listStdout.read())).toMatchObject({
        current: {
          exists: true,
          managed: true,
          matched_accounts: ["quota-main"],
        },
        successes: [
          {
            name: "quota-main",
            is_current: true,
            available: "available",
            credits_balance: 11,
            refresh_status: "ok",
            five_hour: {
              used_percent: 15,
            },
            one_week: {
              used_percent: 45,
            },
          },
        ],
        failures: [],
      });

      const removedStdout = captureWritable();
      const removedStderr = captureWritable();
      const removedCode = await runCli(["lsit", "--json"], {
        store,
        stdout: removedStdout.stream,
        stderr: removedStderr.stream,
      });
      expect(removedCode).toBe(1);
      expect(JSON.parse(removedStderr.read())).toMatchObject({
        ok: false,
        error: 'Unknown command "lsit".',
        suggestion: "list",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("marks the current account in list text output while keeping the table aligned", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: accountId === "acct-cli-quota-text-a" ? 15 : 25,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: accountId === "acct-cli-quota-text-a" ? 45 : 55,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota-text-a");
      await runCli(["save", "quota-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota-text-b");
      await runCli(["save", "quota-backup", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await runCli(["switch", "quota-main", "--json"], {
        store,
        desktopLauncher: createDesktopLauncherStub(),
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await runCli(["list", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const output = listStdout.read();
      const lines = output.trimEnd().split("\n");
      const tableStartIndex = lines.findIndex((line) => line.includes("NAME"));
      const tableLines = lines.slice(tableStartIndex, tableStartIndex + 4);
      const currentRow = tableLines.find((line) => line.includes("quota-main"));

      expect(lines[0]).toBe("Current managed account: quota-main");
      expect(output).not.toContain("CREDITS");
      expect(output).toContain("AVAILABLE");
      expect(output).toContain("available");
      expect(output).toContain("* quota-main");
      expect(output).toContain("  quota-backup");
      expect(output).toContain(
        dayjs.utc("2026-03-18T21:17:21.000Z").tz(dayjs.tz.guess()).format("MM-DD HH:mm"),
      );
      expect(output).toContain(
        dayjs.utc("2026-03-19T03:14:00.000Z").tz(dayjs.tz.guess()).format("MM-DD HH:mm"),
      );
      expect(tableLines).toHaveLength(4);
      expect(currentRow).toBeDefined();
      expect(tableLines[0]?.indexOf("NAME")).toBe(currentRow?.indexOf("quota-main"));
      expect(tableLines[0]?.indexOf("IDENTITY")).toBe(currentRow?.indexOf("acct-c"));
      expect(tableLines[0]?.indexOf("PLAN TYPE")).toBe(tableLines[3]?.indexOf("plus"));
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
                  reset_at: 1_773_860_000,
                },
                secondary_window: {
                  used_percent: 80,
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
                used_percent: 100,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 10,
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
      expect(JSON.parse(dryRunStdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        dry_run: true,
        selected: {
          name: "beta",
          available: "available",
          effective_score: 50,
          remain_5h: 50,
          remain_1w_eq_5h: 60,
        },
      });

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
      expect(JSON.parse(switchStdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        account: {
          name: "beta",
          account_id: "acct-auto-beta",
        },
        selected: {
          name: "beta",
          effective_score: 50,
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
});
