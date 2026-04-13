import { describe, expect, test } from "@rstest/core";

import {
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  createCodexDesktopLauncher,
  type CodexDirectClient,
} from "../src/codex-desktop-launch.js";
import { cleanupTempHome, createTempHome } from "./test-helpers.js";

function createFakeDirectClient(responseByMethod: Record<string, unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fakeClient: CodexDirectClient = {
    async request(method, params = {}) {
      calls.push({ method, params });
      return responseByMethod[method] ?? null;
    },
    async close() {
      return;
    },
  };

  return { fakeClient, calls };
}

describe("codex runtime read paths", () => {
  test("prefers the Desktop bridge for current runtime quota reads", async () => {
    const homeDir = await createTempHome();
    const statePath = `${homeDir}/.codex-team/desktop-state.json`;
    const { fakeClient, calls } = createFakeDirectClient({
      "account/rateLimits/read": {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 90 },
        },
      },
    });

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
                            primary: { usedPercent: 12 },
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
        createDirectClientImpl: async () => fakeClient,
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.readCurrentRuntimeQuotaResult()).resolves.toMatchObject({
        source: "desktop",
        snapshot: {
          plan_type: "plus",
          five_hour: { used_percent: 12 },
        },
      });
      expect(calls).toEqual([]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("falls back to the direct client when the connected devtools target is not Codex Desktop", async () => {
    const homeDir = await createTempHome();
    const statePath = `${homeDir}/.codex-team/desktop-state.json`;
    const { fakeClient, calls } = createFakeDirectClient({
      "account/rateLimits/read": {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 90 },
        },
      },
    });

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
            send(_data: string) {
              queueMicrotask(() => {
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
        createDirectClientImpl: async () => fakeClient,
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.readCurrentRuntimeQuotaResult()).resolves.toMatchObject({
        source: "direct",
        snapshot: {
          plan_type: "plus",
          five_hour: {
            used_percent: 90,
          },
        },
      });
      expect(calls.map((call) => call.method)).toEqual(["account/rateLimits/read"]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("falls back to the direct client when the Desktop bridge is unavailable", async () => {
    const homeDir = await createTempHome();
    const statePath = `${homeDir}/.codex-team/desktop-state.json`;
    const { fakeClient, calls } = createFakeDirectClient({
      "account/read": {
        account: {
          type: "chatgpt",
          email: "fallback@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      },
    });

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return { stdout: "", stderr: "" };
          }
          throw new Error(`unexpected command: ${file}`);
        },
        createDirectClientImpl: async () => fakeClient,
      });

      await expect(launcher.readCurrentRuntimeAccountResult()).resolves.toEqual({
        source: "direct",
        snapshot: {
          auth_mode: "chatgpt",
          email: "fallback@example.com",
          plan_type: "pro",
          requires_openai_auth: true,
        },
      });
      expect(calls).toEqual([{ method: "account/read", params: { refreshToken: false } }]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("falls back to the direct client when the Desktop bridge read fails", async () => {
    const homeDir = await createTempHome();
    const statePath = `${homeDir}/.codex-team/desktop-state.json`;
    const { fakeClient, calls } = createFakeDirectClient({
      "account/rateLimits/read": {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 33 },
        },
      },
    });

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
            send(_data: string) {
              queueMicrotask(() => {
                socket.onmessage?.({
                  data: JSON.stringify({
                    id: 1,
                    result: {
                      exceptionDetails: {
                        text: "boom",
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
        createDirectClientImpl: async () => fakeClient,
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.readCurrentRuntimeQuotaResult()).resolves.toMatchObject({
        source: "direct",
        snapshot: {
          plan_type: "pro",
          five_hour: { used_percent: 33 },
        },
      });
      expect(calls).toEqual([{ method: "account/rateLimits/read", params: {} }]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("keeps managed Desktop quota reads Desktop-only", async () => {
    const homeDir = await createTempHome();
    const statePath = `${homeDir}/.codex-team/desktop-state.json`;
    let directClientCreated = false;

    try {
      const launcher = createCodexDesktopLauncher({
        statePath,
        execFileImpl: async (file) => {
          if (file === "ps") {
            return { stdout: "", stderr: "" };
          }
          throw new Error(`unexpected command: ${file}`);
        },
        createDirectClientImpl: async () => {
          directClientCreated = true;
          const { fakeClient } = createFakeDirectClient({});
          return fakeClient;
        },
      });

      await expect(launcher.readManagedCurrentQuota()).resolves.toBeNull();
      expect(directClientCreated).toBe(false);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not touch the direct client for managed switch operations", async () => {
    const homeDir = await createTempHome();
    const statePath = `${homeDir}/.codex-team/desktop-state.json`;
    let directClientCreated = false;

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
        createDirectClientImpl: async () => {
          directClientCreated = true;
          throw new Error("should not be called");
        },
      });

      await launcher.writeManagedState({
        pid: 123,
        app_path: "/Applications/Codex.app",
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: "2026-04-07T00:00:00.000Z",
      });

      await expect(launcher.applyManagedSwitch({ force: true, timeoutMs: 10_000 })).resolves.toBe(
        true,
      );
      expect(directClientCreated).toBe(false);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
