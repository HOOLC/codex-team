import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import {
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  createCodexDesktopLauncher,
} from "../src/codex-desktop-launch.js";
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

  test("launches Codex.app with fixed remote debugging port", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const launcher = createCodexDesktopLauncher({
      execFileImpl: async (file, args = []) => {
        calls.push({ file, args: [...args] });
        return { stdout: "", stderr: "" };
      },
    });

    await launcher.launch("/Applications/Codex.app");

    expect(calls).toContainEqual({
      file: "open",
      args: [
        "-na",
        "/Applications/Codex.app",
        "--args",
        `--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`,
      ],
    });
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
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223\n",
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
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223\n",
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
              webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/1",
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

  test("waits for a managed desktop thread to finish by polling renderer conversation state", async () => {
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
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223\n",
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
              webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/1",
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
      expect(sentMessages[0]).toContain("threadRuntimeStatus");
      expect(sentMessages[0]).toContain("__reactContainer$");
      expect(sentMessages[0]).toContain("fallbackPollIntervalMs");
      expect(sentMessages[0]).toContain("MutationObserver");
      expect(sentMessages[0]).not.toContain("thread/loaded/list");
      expect(sentMessages[0]).not.toContain("mcp-request");
      expect(sentMessages[0]).toContain("codex-app-server-restart");
    } finally {
      await cleanupTempHome(homeDir);
    }
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
                "123 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223\n",
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
              webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/1",
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
});
