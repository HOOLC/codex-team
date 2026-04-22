import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";

import { describe, expect, test } from "@rstest/core";

import {
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  createCodexDesktopLauncher,
} from "../src/desktop/launcher.js";
import { launchManagedDesktopProcess } from "../src/desktop/process.js";
import { buildManagedSwitchExpression } from "../src/desktop/runtime-expressions.js";
import { cleanupTempHome, createTempHome } from "./test-helpers.js";

describe("codex-desktop-launch", () => {
  test("returns installed Codex.app path when present", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const launcher = createCodexDesktopLauncher({
      execFileImpl: async (file, args = []) => {
        calls.push({ file, args: [...args] });

        if (file === "stat" && args[args.length - 1] === "/Applications/Codex.app") {
          return { stdout: "/Applications/Codex.app\n", stderr: "" };
        }

        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });

    await expect(launcher.findInstalledApp()).resolves.toBe("/Applications/Codex.app");
    expect(calls.some((call) => call.file === "stat")).toBe(true);
  });

  test("launches Codex desktop binary in managed mode", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const calls: Array<{
      appPath: string;
      binaryPath: string;
      args: string[];
    }> = [];
    const launcher = createCodexDesktopLauncher({
      statePath,
      launchProcessImpl: async (options) => {
        calls.push({
          appPath: options.appPath,
          binaryPath: options.binaryPath,
          args: [...options.args],
        });
      },
    });

    try {
      await launcher.launch("/Applications/Codex.app");
      expect(calls[0]?.appPath).toBe("/Applications/Codex.app");
      expect(calls[0]?.binaryPath).toBe("/Applications/Codex.app/Contents/MacOS/Codex");
      expect(calls[0]?.args).toEqual([
        `--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`,
      ]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("launches managed Desktop through open so app updates can relaunch cleanly", async () => {
    let spawnFile = "";
    let spawnArgs: string[] = [];
    let spawnOptions: { detached?: boolean; stdio?: string } | null = null;
    let unrefCalled = false;

    await launchManagedDesktopProcess(
      {
        appPath: "/Applications/Codex.app",
        binaryPath: "/Applications/Codex.app/Contents/MacOS/Codex",
        args: [`--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`],
      },
      ((file: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
        spawnFile = file;
        spawnArgs = [...args];
        spawnOptions = {
          detached: options.detached,
          stdio: typeof options.stdio === "string" ? options.stdio : undefined,
        };

        const child = new EventEmitter() as EventEmitter & { unref(): void };
        child.unref = () => {
          unrefCalled = true;
        };
        queueMicrotask(() => {
          child.emit("spawn");
        });
        return child as never;
      }) as never,
    );

    expect(spawnFile).toBe("open");
    expect(spawnArgs).toEqual([
      "-na",
      "/Applications/Codex.app",
      "--args",
      `--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`,
    ]);
    expect(spawnOptions).toEqual({
      detached: true,
      stdio: "ignore",
    });
    expect(unrefCalled).toBe(true);
  });

  test("passes CODEX_API_BASE_URL to Desktop launch when proxy routing is requested", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const calls: Array<{
      appPath: string;
      binaryPath: string;
      args: string[];
      env?: Record<string, string>;
    }> = [];
    const launcher = createCodexDesktopLauncher({
      statePath,
      launchProcessImpl: async (options) => {
        calls.push({
          appPath: options.appPath,
          binaryPath: options.binaryPath,
          args: [...options.args],
          env: options.env,
        });
      },
    });

    try {
      await launcher.launch("/Applications/Codex.app", {
        apiBaseUrl: "http://127.0.0.1:14555/backend-api",
      });
      expect(calls[0]?.appPath).toBe("/Applications/Codex.app");
      expect(calls[0]?.binaryPath).toBe("/Applications/Codex.app/Contents/MacOS/Codex");
      expect(calls[0]?.args).toEqual([
        `--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`,
      ]);
      expect(calls[0]?.env).toEqual({
        CODEX_API_BASE_URL: "http://127.0.0.1:14555/backend-api",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reads the managed Desktop launch-time CODEX_API_BASE_URL from the running process env", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const launcher = createCodexDesktopLauncher({
      statePath,
      execFileImpl: async (file, args = []) => {
        if (file === "ps" && args[0] === "-Ao") {
          return {
            stdout: "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
            stderr: "",
          };
        }

        if (file === "ps" && args[0] === "eww") {
          return {
            stdout:
              "  PID   TT  STAT      TIME COMMAND\n"
              + "123 ?? S 0:00.10 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223 CODEX_API_BASE_URL=http://127.0.0.1:14555/backend-api\n",
            stderr: "",
          };
        }

        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });

    try {
      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: 39223,
        managed_by_codexm: true,
        started_at: "2026-04-22T00:00:00.000Z",
        desktop_api_base_url: null,
      });

      await expect(launcher.readManagedLaunchApiBaseUrl()).resolves.toBe(
        "http://127.0.0.1:14555/backend-api",
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("treats an empty managed Desktop launch-time CODEX_API_BASE_URL as the direct backend", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const launcher = createCodexDesktopLauncher({
      statePath,
      execFileImpl: async (file, args = []) => {
        if (file === "ps" && args[0] === "-Ao") {
          return {
            stdout: "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
            stderr: "",
          };
        }

        if (file === "ps" && args[0] === "eww") {
          return {
            stdout:
              "  PID   TT  STAT      TIME COMMAND\n"
              + "123 ?? S 0:00.10 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223 CODEX_API_BASE_URL=\n",
            stderr: "",
          };
        }

        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });

    try {
      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: 39223,
        managed_by_codexm: true,
        started_at: "2026-04-22T00:00:00.000Z",
        desktop_api_base_url: "http://127.0.0.1:14555/backend-api",
      });

      await expect(launcher.readManagedLaunchApiBaseUrl()).resolves.toBeNull();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("lists running Codex Desktop processes from ps output", async () => {
    const launcher = createCodexDesktopLauncher({
      execFileImpl: async (file) => {
        if (file === "ps") {
          return {
            stdout:
              "123 /Applications/Codex.app/Contents/MacOS/Codex\n456 /Applications/Codex.app/Contents/Resources/codex app-server\n",
            stderr: "",
          };
        }

        throw new Error(`unexpected command: ${file}`);
      },
    });

    await expect(launcher.listRunningApps()).resolves.toEqual([
      { pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex" },
    ]);
  });

  test("detects when the current shell is descended from Codex Desktop", async () => {
    const originalParentPid = process.ppid;
    const launcher = createCodexDesktopLauncher({
      execFileImpl: async (file, args = []) => {
        if (file === "ps" && args.at(-1) === String(originalParentPid)) {
          return {
            stdout: `777 /bin/zsh\n`,
            stderr: "",
          };
        }

        if (file === "ps" && args.at(-1) === "777") {
          return {
            stdout: "1 /Applications/Codex.app/Contents/MacOS/Codex\n",
            stderr: "",
          };
        }

        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });

    await expect(launcher.isRunningInsideDesktopShell()).resolves.toBe(true);
  });

  test("returns false when the current shell is not descended from Codex Desktop", async () => {
    const originalParentPid = process.ppid;
    const launcher = createCodexDesktopLauncher({
      execFileImpl: async (file, args = []) => {
        if (file === "ps" && args.at(-1) === String(originalParentPid)) {
          return {
            stdout: "777 /bin/zsh\n",
            stderr: "",
          };
        }

        if (file === "ps" && args.at(-1) === "777") {
          return {
            stdout: "1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n",
            stderr: "",
          };
        }

        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });

    await expect(launcher.isRunningInsideDesktopShell()).resolves.toBe(false);
  });

  test("quits running Codex Desktop via osascript", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    let psCalls = 0;
    const launcher = createCodexDesktopLauncher({
      execFileImpl: async (file, args = []) => {
        calls.push({ file, args: [...args] });

        if (file === "ps") {
          psCalls += 1;
          return {
            stdout:
              psCalls === 1
                ? "123 /Applications/Codex.app/Contents/MacOS/Codex\n"
                : "",
            stderr: "",
          };
        }

        return { stdout: "", stderr: "" };
      },
    });

    await launcher.quitRunningApps();

    expect(calls).toContainEqual({
      file: "osascript",
      args: ["-e", 'tell application "Codex" to quit'],
    });
    expect(psCalls).toBeGreaterThanOrEqual(2);
  });

  test("force-kills running Codex Desktop processes when requested", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    let psCalls = 0;
    const launcher = createCodexDesktopLauncher({
      execFileImpl: async (file, args = []) => {
        calls.push({ file, args: [...args] });

        if (file === "ps") {
          psCalls += 1;
          return {
            stdout:
              psCalls === 1
                ? "123 /Applications/Codex.app/Contents/MacOS/Codex\n456 /Applications/Codex.app/Contents/MacOS/Codex\n"
                : "",
            stderr: "",
          };
        }

        return { stdout: "", stderr: "" };
      },
    });

    await launcher.quitRunningApps({ force: true });

    expect(calls).toContainEqual({
      file: "kill",
      args: ["-TERM", "123", "456"],
    });
    expect(calls.some((call) => call.file === "osascript")).toBe(false);
    expect(psCalls).toBeGreaterThanOrEqual(2);
  });

  test("writes reads and clears managed desktop state", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.readManagedState()).resolves.toEqual({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      expect(await readFile(statePath, "utf8")).toContain('"managed_by_codexm": true');

      await launcher.clearManagedState();
      await expect(launcher.readManagedState()).resolves.toBeNull();
      expect(await readFile(statePath, "utf8")).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("recognizes a managed desktop state when pid and command still match", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.isManagedDesktopRunning()).resolves.toBe(true);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("treats stale managed desktop state as not running", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9999\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.isManagedDesktopRunning()).resolves.toBe(false);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("restarts the managed desktop app server through devtools", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const sentMessages: string[] = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              sentMessages.push(data);
              socket.onmessage?.({
                data: JSON.stringify({
                  id: 1,
                  result: {
                    result: {
                      type: "undefined",
                    },
                  },
                }),
              });
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.applyManagedSwitch({ force: true, timeoutMs: 120_000 })).resolves.toBe(
        true,
      );
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('"method":"Runtime.evaluate"');
      expect(sentMessages[0]).toContain("codex-app-server-restart");
      expect(sentMessages[0]).toContain("restartAppServer");
      expect(sentMessages[0]).toContain("waitForAccountReadiness");
      expect(sentMessages[0]).not.toContain("account/updated");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("rejects managed switch when the connected devtools target is not Codex Desktop", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const sentMessages: string[] = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              sentMessages.push(data);
              socket.onmessage?.({
                data: JSON.stringify({
                  id: 1,
                  result: {
                    result: {
                      type: "object",
                      subtype: "error",
                      className: "Error",
                      description: "Error: Connected debug console target is not Codex Desktop.",
                    },
                    exceptionDetails: {
                      text: "Uncaught (in promise)",
                      exception: {
                        description: "Error: Connected debug console target is not Codex Desktop.",
                      },
                    },
                  },
                }),
              });
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.applyManagedSwitch({ force: true, timeoutMs: 120_000 })).rejects.toThrow(
        "Connected debug console target is not Codex Desktop.",
      );
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain("Connected debug console target is not Codex Desktop.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not try to restart the app server when the managed desktop is not running", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    let fetchCalled = false;

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return { stdout: "", stderr: "" };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => {
          fetchCalled = true;
          return {
            ok: true,
            status: 200,
            json: async () => [],
          };
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.applyManagedSwitch({ force: false, timeoutMs: 120_000 })).resolves.toBe(
        false,
      );
      expect(fetchCalled).toBe(false);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reads the current managed quota snapshot over the bridge MCP channel", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const sentMessages: string[] = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              sentMessages.push(data);
              const payload = JSON.parse(data) as { id: number };
              queueMicrotask(() => {
                socket.onmessage?.({
                  data: JSON.stringify({
                    id: payload.id,
                    result: {
                      result: {
                        type: "object",
                        value: {
                          rateLimits: {
                            planType: "plus",
                            primary: {
                              usedPercent: 12,
                              resetsAt: 1_773_868_641,
                            },
                            secondary: {
                              usedPercent: 47,
                              resetsAt: 1_773_890_040,
                            },
                            credits: {
                              hasCredits: true,
                              unlimited: false,
                              balance: "11",
                            },
                          },
                        },
                      },
                    },
                  }),
                });
              });
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.readManagedCurrentQuota()).resolves.toMatchObject({
        plan_type: "plus",
        credits_balance: 11,
        unlimited: false,
        five_hour: {
          used_percent: 12,
          reset_at: "2026-03-18T21:17:21.000Z",
        },
        one_week: {
          used_percent: 47,
          reset_at: "2026-03-19T03:14:00.000Z",
        },
      });
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('"method":"Runtime.evaluate"');
      expect(sentMessages[0]).toContain("account/rateLimits/read");
      expect(sentMessages[0]).toContain('\\"mcp-request\\"');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("returns managed current account from the Desktop bridge", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const sentMessages: string[] = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              sentMessages.push(data);
              expect(data).toContain("(async () => {");
              queueMicrotask(() => {
                socket.onmessage?.({
                  data: JSON.stringify({
                    id: 1,
                    result: {
                      result: {
                        type: "object",
                        value: {
                          account: {
                            type: "chatgpt",
                            email: "user@example.com",
                            planType: "plus",
                          },
                          requiresOpenaiAuth: true,
                        },
                      },
                    },
                  }),
                });
              });
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.readManagedCurrentAccount()).resolves.toEqual({
        auth_mode: "chatgpt",
        email: "user@example.com",
        plan_type: "plus",
        requires_openai_auth: true,
      });
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('"method":"Runtime.evaluate"');
      expect(sentMessages[0]).toContain("account/read");
      expect(sentMessages[0]).toContain("refreshToken");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("waits for a managed desktop thread to finish by polling MCP thread state", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const sentMessages: string[] = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              sentMessages.push(data);
              socket.onmessage?.({
                data: JSON.stringify({
                  id: 1,
                  result: {
                    result: {
                      type: "object",
                    },
                  },
                }),
              });
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.applyManagedSwitch({ force: false, timeoutMs: 120_000 })).resolves.toBe(
        true,
      );
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('"method":"Runtime.evaluate"');
      expect(sentMessages[0]).toContain("thread/loaded/list");
      expect(sentMessages[0]).toContain("thread/read");
      expect(sentMessages[0]).toContain('\\"mcp-request\\"');
      expect(sentMessages[0]).toContain("fallbackPollIntervalMs");
      expect(sentMessages[0]).toContain("codex-app-server-restart");
      expect(sentMessages[0]).toContain("restartAppServer");
      expect(sentMessages[0]).toContain("waitForAccountReadiness");
      expect(sentMessages[0]).not.toContain("account/updated");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refreshes the managed Desktop account surface by restarting the app server", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const sentMessages: string[] = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              sentMessages.push(data);
              socket.onmessage?.({
                data: JSON.stringify({
                  id: 1,
                  result: {
                    result: {
                      type: "object",
                    },
                  },
                }),
              });
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.refreshManagedAccountSurface()).resolves.toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('"method":"Runtime.evaluate"');
      expect(sentMessages[0]).toContain("codex-app-server-restart");
      expect(sentMessages[0]).toContain("restartAppServer");
      expect(sentMessages[0]).toContain("waitForAccountReadiness");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("managed switch ignores active threads whose active flags are empty", () => {
    const expression = buildManagedSwitchExpression({ force: false, timeoutMs: 120_000 });

    expect(expression).toContain("const isBlockingThreadStatus = (status) => {");
    expect(expression).toContain('!Object.prototype.hasOwnProperty.call(status, "activeFlags")');
    expect(expression).toContain("Array.isArray(status.activeFlags) ? status.activeFlags.length > 0 : true");
    expect(expression).toContain("if (isBlockingThreadStatus(status))");
  });

  test("passes an extended devtools timeout for managed switches", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const originalSetTimeout = globalThis.setTimeout;
    const recordedTimeouts: number[] = [];

    try {
      globalThis.setTimeout = ((
        handler: Parameters<typeof globalThis.setTimeout>[0],
        timeout?: number,
        ...args: Parameters<typeof globalThis.setTimeout> extends [
          unknown,
          unknown?,
          ...infer Rest,
        ]
          ? Rest
          : never
      ) => {
        recordedTimeouts.push(timeout ?? 0);
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof globalThis.setTimeout;

      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(_data: string) {
              queueMicrotask(() => {
                socket.onmessage?.({
                  data: JSON.stringify({
                    id: 1,
                    result: {
                      result: {
                        type: "undefined",
                      },
                    },
                  }),
                });
              });
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.applyManagedSwitch({ force: false, timeoutMs: 12_000 })).resolves.toBe(
        true,
      );
      expect(recordedTimeouts.some((value) => value >= 22_000)).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      await cleanupTempHome(homeDir);
    }
  });

  test("emits quota signals from bridge-level mcp responses with exhausted rate limits", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const debugLines: string[] = [];
    const quotaSignals: Array<{
      requestId: string;
      reason: string;
      bodySnippet: string | null;
      quota: { five_hour_used: number | null; one_week_used: number | null } | null;
    }> = [];
    const sentMethods: string[] = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };
              sentMethods.push(payload.method);

              if (payload.method === "Runtime.enable" || payload.method === "Runtime.evaluate") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });

                  if (payload.method === "Runtime.evaluate") {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"from_view","event":{"type":"mcp-request","hostId":"local","request":{"id":"req-rpc-1","method":"account/rateLimits/read","params":{}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-response","hostId":"local","message":{"id":"req-rpc-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100},"secondaryWindow":{"usedPercent":95}}}}}}',
                            },
                          ],
                        },
                      }),
                    });
                  }
                });
                return;
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        debugLogger: (line) => {
          debugLines.push(line);
        },
        onQuotaSignal: (signal) => {
          quotaSignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
            bodySnippet: signal.bodySnippet,
            quota: signal.quota
              ? {
                  five_hour_used: signal.quota.five_hour?.used_percent ?? null,
                  one_week_used: signal.quota.one_week?.used_percent ?? null,
                }
              : null,
          });
          controller.abort();
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      expect(sentMethods).toContain("Runtime.evaluate");
      expect(debugLines.some((line) => line.includes('"method":"Bridge.message"'))).toBe(true);
      expect(debugLines.some((line) => line.includes('"type":"mcp-request"'))).toBe(true);
      expect(debugLines.some((line) => line.includes('"type":"mcp-response"'))).toBe(true);
      expect(quotaSignals).toEqual([
        {
          requestId: "rpc:req-rpc-1",
          reason: "rpc_response",
          bodySnippet:
            '{"type":"mcp-response","hostId":"local","message":{"id":"req-rpc-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100},"secondaryWindow":{"usedPercent":95}}}}}',
          quota: {
            five_hour_used: 100,
            one_week_used: 95,
          },
        },
      ]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not emit quota signals from codexm self-initiated rate limit reads", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const quotaSignals: Array<{ requestId: string; reason: string }> = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };

              if (payload.method === "Runtime.enable" || payload.method === "Runtime.evaluate") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });

                  if (payload.method === "Runtime.evaluate") {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"from_view","event":{"type":"mcp-request","hostId":"local","request":{"id":"codexm-current-1","method":"account/rateLimits/read","params":{}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-response","hostId":"local","message":{"id":"codexm-current-1","result":{"rateLimits":{"primary":{"usedPercent":5},"secondary":{"usedPercent":30},"planType":"plus"}}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    queueMicrotask(() => {
                      controller.abort();
                    });
                  }
                });
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        onQuotaSignal: (signal) => {
          quotaSignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
          });
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      expect(quotaSignals).toEqual([]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("emits quota signals from bridge-level mcp notifications with usage_limit_exceeded", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const quotaSignals: Array<{ requestId: string; reason: string; bodySnippet: string | null }> =
      [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };

              if (payload.method === "Runtime.enable" || payload.method === "Runtime.evaluate") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });

                  if (payload.method === "Runtime.evaluate") {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-notification","hostId":"local","method":"error","params":{"message":"request failed","error":{"codex_error_info":"usage_limit_exceeded"}}}}',
                            },
                          ],
                        },
                      }),
                    });
                  }
                });
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        onQuotaSignal: (signal) => {
          quotaSignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
            bodySnippet: signal.bodySnippet,
          });
          controller.abort();
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      expect(quotaSignals).toEqual([
        {
          requestId: "rpc:notification:error",
          reason: "rpc_notification",
          bodySnippet:
            '{"type":"mcp-notification","hostId":"local","method":"error","params":{"message":"request failed","error":{"codex_error_info":"usage_limit_exceeded"}}}',
        },
      ]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reconnects watch after an unexpected devtools close and continues emitting quota signals", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const quotaSignals: Array<{ requestId: string; reason: string }> = [];
    let connectionCount = 0;

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          connectionCount += 1;
          const currentConnection = connectionCount;

          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };

              if (payload.method === "Runtime.enable" || payload.method === "Runtime.evaluate") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });

                  if (payload.method === "Runtime.evaluate" && currentConnection === 1) {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"from_view","event":{"type":"mcp-request","hostId":"local","request":{"id":"req-rpc-1","method":"account/rateLimits/read","params":{}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-response","hostId":"local","message":{"id":"req-rpc-1","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    queueMicrotask(() => {
                      socket.onclose?.();
                    });
                  }

                  if (payload.method === "Runtime.evaluate" && currentConnection === 2) {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"from_view","event":{"type":"mcp-request","hostId":"local","request":{"id":"req-rpc-2","method":"account/rateLimits/read","params":{}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-response","hostId":"local","message":{"id":"req-rpc-2","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}}',
                            },
                          ],
                        },
                      }),
                    });
                  }
                });
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        onQuotaSignal: (signal) => {
          quotaSignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
          });
          if (quotaSignals.length === 2) {
            controller.abort();
          }
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      expect(connectionCount).toBe(2);
      expect(quotaSignals).toEqual([
        {
          requestId: "rpc:req-rpc-1",
          reason: "rpc_response",
        },
        {
          requestId: "rpc:req-rpc-2",
          reason: "rpc_response",
        },
      ]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reconnects watch when health checks stop receiving responses", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const quotaSignals: Array<{ requestId: string; reason: string }> = [];
    let connectionCount = 0;

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        watchHealthCheckIntervalMs: 5,
        watchHealthCheckTimeoutMs: 5,
        watchReconnectDelayMs: 1,
        createWebSocketImpl: () => {
          connectionCount += 1;
          const currentConnection = connectionCount;
          let evaluateCalls = 0;

          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };

              if (payload.method === "Runtime.enable") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });
                });
                return;
              }

              if (payload.method === "Runtime.evaluate") {
                evaluateCalls += 1;

                if (currentConnection === 1 && evaluateCalls === 1) {
                  queueMicrotask(() => {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        id: payload.id,
                        result: {},
                      }),
                    });
                  });
                  return;
                }

                if (currentConnection === 2 && evaluateCalls === 1) {
                  queueMicrotask(() => {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        id: payload.id,
                        result: {},
                      }),
                    });
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"from_view","event":{"type":"mcp-request","hostId":"local","request":{"id":"req-rpc-healthy","method":"account/rateLimits/read","params":{}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-response","hostId":"local","message":{"id":"req-rpc-healthy","result":{"rateLimits":{"primaryWindow":{"usedPercent":100}}}}}}',
                            },
                          ],
                        },
                      }),
                    });
                  });
                }
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const abortTimer = setTimeout(() => {
        controller.abort();
      }, 80);

      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        onQuotaSignal: (signal) => {
          quotaSignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
          });
          controller.abort();
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      clearTimeout(abortTimer);
      expect(connectionCount).toBe(2);
      expect(quotaSignals).toEqual([
        {
          requestId: "rpc:req-rpc-healthy",
          reason: "rpc_response",
        },
      ]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not emit quota signals from generic bridge quota wording", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const quotaSignals: Array<{ requestId: string; reason: string; bodySnippet: string | null }> =
      [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };

              if (payload.method === "Runtime.enable" || payload.method === "Runtime.evaluate") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });

                  if (payload.method === "Runtime.evaluate") {
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [
                            {
                              type: "string",
                              value:
                                '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-notification","hostId":"local","method":"error","params":{"message":"quota nearly exhausted","error":{"message":"soft warning"}}}}',
                            },
                          ],
                        },
                      }),
                    });
                    queueMicrotask(() => {
                      controller.abort();
                    });
                  }
                });
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        onQuotaSignal: (signal) => {
          quotaSignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
            bodySnippet: signal.bodySnippet,
          });
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      expect(quotaSignals).toEqual([]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("emits dirty activity from rate limit notifications without trusting their quota payload", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const quotaSignals: Array<{ requestId: string }> = [];
    const activitySignals: Array<{
      requestId: string;
      reason: string;
      bodySnippet: string | null;
    }> = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };

              if (payload.method === "Runtime.enable" || payload.method === "Runtime.evaluate") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });

                  if (payload.method === "Runtime.evaluate") {
                    const notification =
                      '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-notification","hostId":"local","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":3},"secondary":{"usedPercent":30},"planType":"plus"}}}}';
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [{ type: "string", value: notification }],
                        },
                      }),
                    });
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [{ type: "string", value: notification }],
                        },
                      }),
                    });
                    queueMicrotask(() => {
                      controller.abort();
                    });
                  }
                });
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        onQuotaSignal: (signal) => {
          quotaSignals.push({ requestId: signal.requestId });
        },
        onActivitySignal: (signal) => {
          activitySignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
            bodySnippet: signal.bodySnippet,
          });
          controller.abort();
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      expect(quotaSignals).toEqual([]);
      expect(activitySignals).toEqual([
        {
          requestId: "rpc:notification:account/rateLimits/updated",
          reason: "quota_dirty",
          bodySnippet:
            '{"type":"mcp-notification","hostId":"local","method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":3},"secondary":{"usedPercent":30},"planType":"plus"}}}',
        },
      ]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("emits turn completed activity signals for quota read scheduling", async () => {
    const homeDir = await createTempHome();
    const statePath = join(homeDir, ".codex-team", "desktop-state.json");
    const activitySignals: Array<{ requestId: string; reason: string; bodySnippet: string | null }> = [];

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return {
              stdout:
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file}`);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              type: "page",
              url: "app://-/index.html?hostId=local",
              webSocketDebuggerUrl: "ws://127.0.0.1:39223/devtools/page/1",
            },
          ],
        }),
        createWebSocketImpl: () => {
          const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((event: unknown) => void) | null,
            onclose: null as (() => void) | null,
            send(data: string) {
              const payload = JSON.parse(data) as { id: number; method: string };

              if (payload.method === "Runtime.enable" || payload.method === "Runtime.evaluate") {
                queueMicrotask(() => {
                  socket.onmessage?.({
                    data: JSON.stringify({
                      id: payload.id,
                      result: {},
                    }),
                  });

                  if (payload.method === "Runtime.evaluate") {
                    const notification =
                      '__codexm_watch__{"kind":"bridge","direction":"for_view","event":{"type":"mcp-notification","hostId":"local","method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}}';
                    socket.onmessage?.({
                      data: JSON.stringify({
                        method: "Runtime.consoleAPICalled",
                        params: {
                          type: "debug",
                          args: [{ type: "string", value: notification }],
                        },
                      }),
                    });
                  }
                });
              }
            },
            close() {
              return;
            },
          };

          queueMicrotask(() => {
            socket.onopen?.();
          });

          return socket;
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      const controller = new AbortController();
      const watchPromise = launcher.watchManagedQuotaSignals({
        signal: controller.signal,
        onActivitySignal: (signal) => {
          activitySignals.push({
            requestId: signal.requestId,
            reason: signal.reason,
            bodySnippet: signal.bodySnippet,
          });
          controller.abort();
        },
      });

      await expect(watchPromise).resolves.toBeUndefined();
      expect(activitySignals).toEqual([
        {
          requestId: "rpc:notification:turn/completed",
          reason: "turn_completed",
          bodySnippet:
            '{"type":"mcp-notification","hostId":"local","method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}',
        },
      ]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

});
