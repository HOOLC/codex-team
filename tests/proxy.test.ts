import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";
import { WebSocket, WebSocketServer } from "ws";

import { createAccountStore } from "../src/account-store/index.js";
import { decodeJwtPayload, getSnapshotAccountId, getSnapshotEmail, getSnapshotUserId } from "../src/auth-snapshot.js";
import type { RunnerOptions } from "../src/codex-cli-runner.js";
import { writeDaemonState } from "../src/daemon/state.js";
import { runCli } from "../src/main.js";
import { PROXY_PORT_ENV_VAR } from "../src/proxy/constants.js";
import { formatProxyUpstreamSelectionLabel } from "../src/proxy/request-log.js";
import { readProxyState, writeProxyState } from "../src/proxy/state.js";
import {
  cleanupTempHome,
  createAuthPayload,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  readCurrentConfig,
  withEnvVar,
  writeCurrentAuth,
  writeCurrentConfig,
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
      disable: async () => {
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

function sseResponse(events: unknown[], status = 200): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for websocket open"));
    }, 1_500);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", handleOpen);
      socket.off("close", handleClose);
      socket.off("error", handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`websocket closed before open: code=${code} reason=${reason.toString("utf8")}`));
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("open", handleOpen);
    socket.once("close", handleClose);
    socket.once("error", handleError);
  });
}

async function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for websocket close"));
    }, 1_500);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", handleClose);
      socket.off("error", handleError);
    };

    const handleClose = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("close", handleClose);
    socket.once("error", handleError);
  });
}

async function sendWebSocketTurnAndCollectTerminal(
  socket: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const events: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for websocket message"));
    }, 1_500);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", handleMessage);
      socket.off("close", handleClose);
      socket.off("error", handleError);
    };

    const handleMessage = (raw: string | Buffer) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return;
      }
      const event = parsed as Record<string, unknown>;
      events.push(event);
      const eventType = typeof event.type === "string" ? event.type : null;
      if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.failed") {
        cleanup();
        resolve(events);
      }
    };

    const handleClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`websocket closed before terminal event: code=${code} reason=${reason.toString("utf8")}`));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on("message", handleMessage);
    socket.once("close", handleClose);
    socket.once("error", handleError);
    socket.send(JSON.stringify(payload));
  });
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
  const meta = JSON.parse(await readFile(accountMetaPath, "utf8")) as Record<string, unknown>;
  meta.quota = {
    status: quota.status,
    plan_type: quota.plan_type,
    fetched_at: "2026-04-18T00:00:00.000Z",
    unlimited: true,
    five_hour: {
      used_percent: quota.five_hour_used,
      window_seconds: 18_000,
      reset_at: "2026-04-18T05:00:00.000Z",
    },
    one_week: {
      used_percent: quota.one_week_used,
      window_seconds: 604_800,
      reset_at: "2026-04-25T00:00:00.000Z",
    },
  };
  await writeFile(accountMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

describe("codexm proxy", () => {
  test("proxy enable writes synthetic ChatGPT auth and disable restores direct auth", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-direct", "chatgpt", "plus", "user-direct");
      await writeCurrentConfig(
        homeDir,
        [
          'model = "gpt-5"',
          'chatgpt_base_url = "https://old.example/backend-api"',
          'preferred_auth_method = "chatgpt"',
        ].join("\n"),
      );
      const store = createAccountStore(homeDir);
      const proxyProcess = createProxyProcessManagerStub();
      const stdout = captureWritable();
      const stderr = captureWritable();

      const enableCode = await runCli(["proxy", "enable", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      expect(enableCode).toBe(0);
      expect(proxyProcess.calls).toEqual([
        { host: "127.0.0.1", port: 14555, debug: false },
      ]);
      const enablePayload = JSON.parse(stdout.read()) as Record<string, unknown>;
      expect(enablePayload).toMatchObject({
        ok: true,
        action: "proxy.enable",
        enabled: true,
        running: true,
        base_url: "http://127.0.0.1:14555/backend-api",
        openai_base_url: "http://127.0.0.1:14555/v1",
      });
      const syntheticAuth = await readCurrentAuth(homeDir);
      expect(getSnapshotEmail(syntheticAuth)).toBe("proxy@codexm.local");
      expect(getSnapshotAccountId(syntheticAuth)).toBe("codexm-proxy-account");
      expect(getSnapshotUserId(syntheticAuth)).toBe("codexm-proxy");
      const payload = decodeJwtPayload(String(syntheticAuth.tokens?.access_token));
      expect(Number(payload.exp) - Number(payload.iat)).toBeGreaterThanOrEqual(31_000_000);
      expect(payload["https://api.openai.com/profile"]).toMatchObject({
        email: "proxy@codexm.local",
      });
      const proxyConfig = await readCurrentConfig(homeDir);
      expect(proxyConfig).toContain('chatgpt_base_url = "http://127.0.0.1:14555/backend-api"');
      expect(proxyConfig).toContain('openai_base_url = "http://127.0.0.1:14555/v1"');
      expect(proxyConfig).toContain('preferred_auth_method = "chatgpt"');
      expect(proxyConfig).not.toContain('model_provider = "codexm_proxy"');
      expect(proxyConfig).not.toContain("[model_providers.codexm_proxy]");
      expect(proxyConfig).not.toContain("old.example");

      const disableStdout = captureWritable();
      const disableCode = await runCli(["proxy", "disable", "--json"], {
        store,
        stdout: disableStdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      expect(disableCode).toBe(0);
      expect(JSON.parse(disableStdout.read())).toMatchObject({
        ok: true,
        action: "proxy.disable",
        enabled: false,
        stopped: true,
      });
      const restoredAuth = await readCurrentAuth(homeDir);
      expect(getSnapshotAccountId(restoredAuth)).toBe("acct-direct");
      expect(getSnapshotUserId(restoredAuth)).toBe("user-direct");
      expect(await readCurrentConfig(homeDir)).toContain("old.example");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy disable strips proxy config when direct config backup is unavailable", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const proxyProcess = createProxyProcessManagerStub({ running: true });
      await writeCurrentConfig(
        homeDir,
        [
          'model = "gpt-5.4"',
          'model_provider = "codexm_proxy"',
          'preferred_auth_method = "chatgpt"',
          'chatgpt_base_url = "http://127.0.0.1:14555/backend-api"',
          'openai_base_url = "http://127.0.0.1:14555/v1"',
          "",
          "[model_providers.codexm_proxy]",
          'name = "codexm_proxy"',
          'base_url = "http://127.0.0.1:14555/v1"',
          'wire_api = "responses"',
          "requires_openai_auth = true",
          "supports_websockets = true",
          "",
          "[projects.main]",
          'path = "/tmp/project"',
        ].join("\n"),
      );
      await writeFile(
        store.paths.currentAuthPath,
        `${JSON.stringify(createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z")), null, 2)}\n`,
        "utf8",
      );
      await writeProxyState(store.paths.codexTeamDir, {
        pid: 12345,
        host: "127.0.0.1",
        port: 14555,
        started_at: "2026-04-18T00:00:00.000Z",
        log_path: "/tmp/codexm-proxy.log",
        base_url: "http://127.0.0.1:14555/backend-api",
        openai_base_url: "http://127.0.0.1:14555/v1",
        debug: false,
        enabled: true,
        direct_auth_backup_path: null,
        direct_config_backup_path: null,
        direct_auth_existed: true,
        direct_config_existed: true,
      });

      const exitCode = await runCli(["proxy", "disable", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      expect(exitCode).toBe(0);
      const sanitizedConfig = await readCurrentConfig(homeDir);
      expect(sanitizedConfig).toContain('model = "gpt-5.4"');
      expect(sanitizedConfig).toContain("[projects.main]");
      expect(sanitizedConfig).not.toContain("codexm_proxy");
      expect(sanitizedConfig).not.toContain("chatgpt_base_url");
      expect(sanitizedConfig).not.toContain("openai_base_url");
      expect(sanitizedConfig).not.toContain("preferred_auth_method");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy disable sanitizes proxy base urls restored from a contaminated direct config backup", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const proxyProcess = createProxyProcessManagerStub({ running: true });
      const backupConfigPath = join(homeDir, ".codex-team", "proxy-backup.toml");
      await mkdir(join(homeDir, ".codex-team"), { recursive: true });
      await writeFile(
        backupConfigPath,
        [
          'model = "gpt-5.4"',
          'preferred_auth_method = "chatgpt"',
          'chatgpt_base_url = "http://127.0.0.1:14555/backend-api"',
          'openai_base_url = "http://127.0.0.1:14555/v1"',
          "",
          "[projects.main]",
          'path = "/tmp/project"',
        ].join("\n"),
        "utf8",
      );
      await writeCurrentConfig(
        homeDir,
        [
          'model = "gpt-5.4"',
          'preferred_auth_method = "chatgpt"',
          'chatgpt_base_url = "http://127.0.0.1:14555/backend-api"',
          'openai_base_url = "http://127.0.0.1:14555/v1"',
        ].join("\n"),
      );
      await writeFile(
        store.paths.currentAuthPath,
        `${JSON.stringify(createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z")), null, 2)}\n`,
        "utf8",
      );
      await writeProxyState(store.paths.codexTeamDir, {
        pid: 12345,
        host: "127.0.0.1",
        port: 14555,
        started_at: "2026-04-18T00:00:00.000Z",
        log_path: "/tmp/codexm-proxy.log",
        base_url: "http://127.0.0.1:14555/backend-api",
        openai_base_url: "http://127.0.0.1:14555/v1",
        debug: false,
        enabled: true,
        direct_auth_backup_path: null,
        direct_config_backup_path: backupConfigPath,
        direct_auth_existed: false,
        direct_config_existed: true,
      });

      const exitCode = await runCli(["proxy", "disable", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      expect(exitCode).toBe(0);
      const restoredConfig = await readCurrentConfig(homeDir);
      expect(restoredConfig).toContain('model = "gpt-5.4"');
      expect(restoredConfig).toContain('preferred_auth_method = "chatgpt"');
      expect(restoredConfig).toContain("[projects.main]");
      expect(restoredConfig).not.toContain("chatgpt_base_url");
      expect(restoredConfig).not.toContain("openai_base_url");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("daemon stop preserves synthetic proxy auth and config for a later restart", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentConfig(
        homeDir,
        [
          'model_provider = "codexm_proxy"',
          'chatgpt_base_url = "http://127.0.0.1:14555/backend-api"',
          'openai_base_url = "http://127.0.0.1:14555/v1"',
        ].join("\n"),
      );
      await writeFile(
        store.paths.currentAuthPath,
        `${JSON.stringify(createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z")), null, 2)}\n`,
        "utf8",
      );

      const exitCode = await runCli(["daemon", "stop", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        daemonProcessManager: {
          getStatus: async () => ({
            running: true,
            state: {
              pid: 54321,
              started_at: "2026-04-18T00:00:00.000Z",
              log_path: "/tmp/daemon.log",
              stayalive: true,
              watch: false,
              auto_switch: false,
              proxy: true,
              host: "127.0.0.1",
              port: 14555,
              base_url: "http://127.0.0.1:14555/backend-api",
              openai_base_url: "http://127.0.0.1:14555/v1",
              debug: false,
            },
          }),
          ensureConfig: async () => {
            throw new Error("ensureConfig should not be called");
          },
          stop: async () => ({
            running: false,
            state: {
              pid: 54321,
              started_at: "2026-04-18T00:00:00.000Z",
              log_path: "/tmp/daemon.log",
              stayalive: true,
              watch: false,
              auto_switch: false,
              proxy: true,
              host: "127.0.0.1",
              port: 14555,
              base_url: "http://127.0.0.1:14555/backend-api",
              openai_base_url: "http://127.0.0.1:14555/v1",
              debug: false,
            },
            stopped: true,
          }),
        },
      } as never);

      expect(exitCode).toBe(0);
      expect(await readCurrentConfig(homeDir)).toContain('chatgpt_base_url = "http://127.0.0.1:14555/backend-api"');
      expect(await readCurrentConfig(homeDir)).toContain('model_provider = "codexm_proxy"');
      expect(getSnapshotAccountId(await readCurrentAuth(homeDir))).toBe("codexm-proxy-account");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy enable respects CODEXM_PROXY_PORT when --port is omitted", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-direct", "chatgpt", "plus", "user-direct");
      const store = createAccountStore(homeDir);
      const proxyProcess = createProxyProcessManagerStub();

      await withEnvVar(PROXY_PORT_ENV_VAR, "16655", async () => {
        const exitCode = await runCli(["proxy", "enable", "--json"], {
          store,
          stdout: captureWritable().stream,
          stderr: captureWritable().stream,
          desktopLauncher: createDesktopLauncherStub(),
          proxyProcessManager: proxyProcess.manager,
        } as never);

        expect(exitCode).toBe(0);
      });

      expect(proxyProcess.calls).toEqual([
        { host: "127.0.0.1", port: 16655, debug: false },
      ]);
      expect(await readCurrentConfig(homeDir)).toContain(
        'chatgpt_base_url = "http://127.0.0.1:16655/backend-api"',
      );
      expect(await readCurrentConfig(homeDir)).toContain(
        'openai_base_url = "http://127.0.0.1:16655/v1"',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("live proxy config keeps transport keys at TOML top level before later tables", async () => {
    const { buildLiveProxyConfig } = await import("../src/proxy/config.js");

    const config = buildLiveProxyConfig(
      [
        'model = "gpt-5"',
        "",
        "[marketplaces.openai-bundled]",
        'source = "https://example.com/marketplace.json"',
      ].join("\n"),
      "http://127.0.0.1:14555/backend-api",
      "http://127.0.0.1:14555/v1",
    );

    expect(config).toContain(
      [
        'model = "gpt-5"',
        'preferred_auth_method = "chatgpt"',
        'chatgpt_base_url = "http://127.0.0.1:14555/backend-api"',
        'openai_base_url = "http://127.0.0.1:14555/v1"',
        "",
        "[marketplaces.openai-bundled]",
      ].join("\n"),
    );
    expect(config).not.toContain(
      [
        "[marketplaces.openai-bundled]",
        'preferred_auth_method = "chatgpt"',
      ].join("\n"),
    );
    expect(config).not.toContain("[model_providers.codexm_proxy]");
  });

  test("proxy enable refreshes the managed Desktop session and accepts --force", async () => {
    const homeDir = await createTempHome();
    const applyManagedSwitchCalls: Array<{ force?: boolean; timeoutMs?: number }> = [];

    try {
      await writeCurrentAuth(homeDir, "acct-direct", "chatgpt", "plus", "user-direct");
      const store = createAccountStore(homeDir);
      const proxyProcess = createProxyProcessManagerStub();

      const exitCode = await runCli(["proxy", "enable", "--force", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async (options) => {
            applyManagedSwitchCalls.push({ ...options });
            return true;
          },
        }),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      expect(exitCode).toBe(0);
      expect(applyManagedSwitchCalls).toEqual([{ force: true, signal: undefined, timeoutMs: 120_000 }]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy disable emits a force warning when no managed Desktop session is running", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-direct", "chatgpt", "plus", "user-direct");
      const store = createAccountStore(homeDir);
      const proxyProcess = createProxyProcessManagerStub({ running: true });
      await runCli(["proxy", "enable", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      const stderr = captureWritable();
      const exitCode = await runCli(["proxy", "disable", "--force", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub({
          applyManagedSwitch: async () => false,
          listRunningApps: async () => [],
        }),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      expect(exitCode).toBe(0);
      expect(stderr.read()).toContain("Warning: --force is only meaningful with a managed Desktop session.");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("switching direct account while proxy is active preserves live proxy wiring and keeps proxy enabled", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-real", "chatgpt", "plus", "user-real");
      await writeCurrentConfig(
        homeDir,
        [
          'model = "gpt-5.4"',
          "",
          "[projects.main]",
          'path = "/tmp/project"',
          'preferred_auth_method = "chatgpt"',
        ].join("\n"),
      );
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("real-main");
      const proxyProcess = createProxyProcessManagerStub();

      const enableCode = await runCli(["proxy", "enable", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(enableCode).toBe(0);

      const switchCode = await runCli(["switch", "real-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(switchCode).toBe(0);

      const currentConfig = await readCurrentConfig(homeDir);
      expect(currentConfig).toContain('model = "gpt-5.4"');
      expect(currentConfig).toContain("[projects.main]");
      expect(currentConfig).toContain('preferred_auth_method = "chatgpt"');
      expect(currentConfig).toContain('chatgpt_base_url = "http://127.0.0.1:14555/backend-api"');
      expect(currentConfig).toContain('openai_base_url = "http://127.0.0.1:14555/v1"');
      expect(currentConfig).not.toContain("codexm_proxy");
      expect((await readProxyState(store.paths.codexTeamDir))?.enabled).toBe(true);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("run --proxy starts codex in an isolated synthetic proxy runtime", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-real", "chatgpt", "plus", "user-real");
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("real-main");
      const proxyProcess = createProxyProcessManagerStub();
      const stdout = captureWritable();
      const stderr = captureWritable();
      let runnerOptions: Record<string, unknown> | null = null;
      let overlayConfig = "";
      let overlayAuth = "";
      let isolatedCodexHome = "";

      const exitCode = await runCli(["run", "--proxy", "--", "--model", "o3"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
        runCodexCli: async (options: RunnerOptions) => {
          isolatedCodexHome = options.env?.CODEX_HOME ?? "";
          overlayConfig = await readFile(join(isolatedCodexHome, "config.toml"), "utf8");
          overlayAuth = await readFile(options.authFilePath ?? "", "utf8");
          runnerOptions = {
            codexArgs: options.codexArgs,
            accountId: options.accountId,
            email: options.email,
            disableAuthWatch: options.disableAuthWatch,
            registerProcess: options.registerProcess,
            codexHome: isolatedCodexHome,
          };
          return {
            exitCode: 0,
            restartCount: 0,
          };
        },
      } as never);

      expect(exitCode).toBe(0);
      expect(runnerOptions).toEqual({
        codexArgs: ["--model", "o3"],
        accountId: "codexm-proxy-account",
        email: "proxy@codexm.local",
        disableAuthWatch: true,
        registerProcess: false,
        codexHome: isolatedCodexHome,
      });
      expect(proxyProcess.calls).toHaveLength(1);
      expect(overlayConfig).toContain('cli_auth_credentials_store = "file"');
      expect(overlayConfig).toContain('model_provider = "codexm_proxy"');
      expect(overlayConfig).toContain('chatgpt_base_url = "http://127.0.0.1:14555/backend-api"');
      expect(overlayConfig).toContain('openai_base_url = "http://127.0.0.1:14555/v1"');
      expect(overlayConfig).toContain("[model_providers.codexm_proxy]");
      expect(overlayConfig).toContain("supports_websockets = true");
      expect(overlayAuth).toContain('"account_id": "codexm-proxy-account"');
      await expect(access(isolatedCodexHome)).rejects.toBeTruthy();
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain("Starting codex in isolated proxy mode");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("run --proxy respects CODEXM_PROXY_PORT when starting a new proxy daemon", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-real", "chatgpt", "plus", "user-real");
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("real-main");
      const proxyProcess = createProxyProcessManagerStub();
      let overlayConfig = "";

      await withEnvVar(PROXY_PORT_ENV_VAR, "16656", async () => {
        const exitCode = await runCli(["run", "--proxy", "--", "--version"], {
          store,
          stdout: captureWritable().stream,
          stderr: captureWritable().stream,
          desktopLauncher: createDesktopLauncherStub(),
          proxyProcessManager: proxyProcess.manager,
          runCodexCli: async (options: RunnerOptions) => {
            overlayConfig = await readFile(join(options.env?.CODEX_HOME ?? "", "config.toml"), "utf8");
            return {
              exitCode: 0,
              restartCount: 0,
            };
          },
        } as never);

        expect(exitCode).toBe(0);
      });

      expect(proxyProcess.calls).toEqual([
        { host: "127.0.0.1", port: 16656, debug: false },
      ]);
      expect(overlayConfig).toContain('chatgpt_base_url = "http://127.0.0.1:16656/backend-api"');
      expect(overlayConfig).toContain('openai_base_url = "http://127.0.0.1:16656/v1"');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("run --proxy reuses the enabled proxy daemon instead of starting the default port", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-real", "chatgpt", "plus", "user-real");
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("real-main");
      await writeProxyState(store.paths.codexTeamDir, {
        pid: 22334,
        host: "127.0.0.1",
        port: 14556,
        started_at: "2026-04-18T00:00:00.000Z",
        log_path: "/tmp/codexm-proxy.log",
        base_url: "http://127.0.0.1:14556/backend-api",
        openai_base_url: "http://127.0.0.1:14556/v1",
        debug: false,
        enabled: true,
      });
      const proxyProcess = createProxyProcessManagerStub({
        running: true,
        port: 14556,
      });
      let overlayConfig = "";

      const exitCode = await runCli(["run", "--proxy", "--", "--version"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
        runCodexCli: async (options: RunnerOptions) => {
          overlayConfig = await readFile(join(options.env?.CODEX_HOME ?? "", "config.toml"), "utf8");
          return {
            exitCode: 0,
            restartCount: 0,
          };
        },
      } as never);

      expect(exitCode).toBe(0);
      expect(proxyProcess.calls).toEqual([]);
      expect(overlayConfig).toContain('chatgpt_base_url = "http://127.0.0.1:14556/backend-api"');
      expect(overlayConfig).toContain('openai_base_url = "http://127.0.0.1:14556/v1"');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("dashboard exposes the proxy pool even when proxy mode is disabled", async () => {
    const { buildCachedAccountDashboardSnapshot } = await import("../src/commands/tui.js");
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-real", "chatgpt", "plus", "user-real");
      const store = createAccountStore(homeDir, {
        fetchImpl: async (_url, init) => {
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
      await writeQuotaMeta(
        (await store.getManagedAccount("real-main")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 12, one_week_used: 34 },
      );

      const dashboard = await buildCachedAccountDashboardSnapshot({ store });
      expect(dashboard.currentStatusLine).toBe(
        "Current managed account: real-main | [daemon:off] [proxy:off] [autoswitch:off]",
      );
      expect(dashboard.summaryLine).toContain("plus x1");
      expect(dashboard.summaryLine).not.toContain("pro x1");
      expect(dashboard.accounts[0]).toMatchObject({
        name: "proxy",
        current: false,
        authModeLabel: "proxy",
        emailLabel: "proxy@codexm.local",
        planLabel: "",
        identityLabel: "",
      });
      expect(dashboard.accounts[1]).toMatchObject({
        name: "real-main",
        current: true,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy server serves synthetic usage and adapts non-stream Responses through a real ChatGPT account", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 20, one_week_used: 40 },
      );
      await store.addAccountSnapshot("protected-beta", createAuthPayload("acct-beta", "chatgpt", "pro", "user-beta"));
      await writeQuotaMeta(
        (await store.getManagedAccount("protected-beta")).metaPath,
        { status: "ok", plan_type: "pro", five_hour_used: 95, one_week_used: 95 },
      );
      await store.setAutoSwitchEligibility("protected-beta", false);

      const forwarded: Array<{ url: string; authorization: string | null; accountId: string | null; body: unknown }> = [];
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        fetchImpl: async (url, init) => {
          forwarded.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
            accountId: new Headers(init?.headers).get("ChatGPT-Account-Id"),
            body: JSON.parse(String(init?.body ?? "{}")) as unknown,
          });
          return sseResponse([
            {
              type: "response.completed",
              response: {
                id: "resp_1",
                object: "response",
                model: "gpt-5.4",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "hello from upstream" }],
                  },
                ],
                usage: {
                  input_tokens: 1,
                  output_tokens: 2,
                  total_tokens: 3,
                },
              },
            },
          ]);
        },
      });

      try {
        const usageResponse = await fetch(`${server.baseUrl}/backend-api/wham/usage`);
        expect(usageResponse.status).toBe(200);
        const usage = await usageResponse.json() as {
          plan_type: string;
          rate_limit: {
            primary_window: { used_percent: number };
            secondary_window: { used_percent: number };
          };
        };
        expect(usage.plan_type).toBe("pro");
        expect(usage.rate_limit.primary_window.used_percent).toBe(20);
        expect(usage.rate_limit.secondary_window.used_percent).toBe(40);
        expect(requestLogs[0]).toMatchObject({
          route: "/backend-api/wham/usage",
          surface: "backend-api",
          auth_kind: "synthetic-chatgpt",
          synthetic_usage: true,
          status_code: 200,
        });

        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({ model: "gpt-5.1", input: "hello" }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: "resp_1" });
        expect(forwarded[0]).toMatchObject({
          url: "https://chatgpt.com/backend-api/codex/responses",
          accountId: "acct-alpha",
        });
        expect(forwarded[0]?.authorization).toMatch(/^Bearer .+/u);
        expect(forwarded[0]?.body).toMatchObject({
          model: "gpt-5.1",
          instructions: "You are Codex.",
          store: false,
          stream: true,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hello" }],
            },
          ],
        });
        expect(requestLogs[1]).toMatchObject({
          route: "/v1/responses",
          surface: "v1",
          auth_kind: "synthetic-chatgpt",
          selected_account_name: "alpha",
          selected_auth_mode: "chatgpt",
          upstream_kind: "chatgpt",
          status_code: 200,
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy normalizes duplicated backend-api usage routes before applying auth-specific handling", async () => {
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 20, one_week_used: 40 },
      );

      const forwardedUrls: string[] = [];
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url) => {
          forwardedUrls.push(String(url));
          if (String(url) === "https://chatgpt.com/backend-api/wham/usage") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                allowed: true,
                limit_reached: false,
                primary_window: {
                  used_percent: 7,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 120,
                  reset_at: 1_777_000_000,
                },
                secondary_window: {
                  used_percent: 11,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 240,
                  reset_at: 1_777_100_000,
                },
              },
              additional_rate_limits: [],
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "3",
              },
            });
          }
          throw new Error(`Unexpected upstream URL: ${String(url)}`);
        },
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
      });

      try {
        const syntheticUsageResponse = await fetch(`${server.baseUrl}/backend-api/backend-api/wham/usage`);
        expect(syntheticUsageResponse.status).toBe(200);
        const syntheticUsage = await syntheticUsageResponse.json() as {
          plan_type: string;
          rate_limit: {
            primary_window: { used_percent: number };
            secondary_window: { used_percent: number };
          };
        };
        expect(syntheticUsage.plan_type).toBe("pro");
        expect(syntheticUsage.rate_limit.primary_window.used_percent).toBe(20);
        expect(syntheticUsage.rate_limit.secondary_window.used_percent).toBe(40);
        expect(requestLogs[0]).toMatchObject({
          route: "/backend-api/wham/usage",
          auth_kind: "synthetic-chatgpt",
          synthetic_usage: true,
          status_code: 200,
        });

        const directUsageResponse = await fetch(`${server.baseUrl}/backend-api/backend-api/wham/usage`, {
          headers: {
            authorization: "Bearer direct-access-token",
            "ChatGPT-Account-Id": "acct-alpha",
          },
        });
        expect(directUsageResponse.status).toBe(200);
        const directUsage = await directUsageResponse.json() as {
          plan_type: string;
          rate_limit: {
            primary_window: { used_percent: number };
            secondary_window: { used_percent: number };
          };
        };
        expect(directUsage.plan_type).toBe("plus");
        expect(directUsage.rate_limit.primary_window.used_percent).toBe(7);
        expect(directUsage.rate_limit.secondary_window.used_percent).toBe(11);
        expect(forwardedUrls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
        expect(requestLogs[1]).toMatchObject({
          route: "/backend-api/wham/usage",
          auth_kind: "direct-chatgpt",
          synthetic_usage: false,
          status_code: 200,
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy injects service_tier priority for exhausted synthetic ChatGPT turns", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 100, one_week_used: 100 },
      );

      const forwardedBodies: unknown[] = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
          return sseResponse([
            {
              type: "response.completed",
              response: {
                id: "resp_fast",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
          ]);
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            input: "hello",
          }),
        });

        expect(response.status).toBe(200);
        expect(forwardedBodies[0]).toMatchObject({
          service_tier: "priority",
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy leaves service_tier unchanged for available synthetic ChatGPT turns", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 99.9, one_week_used: 99.9 },
      );

      const forwardedBodies: unknown[] = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
          return sseResponse([
            {
              type: "response.completed",
              response: {
                id: "resp_normal",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
          ]);
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            input: "hello",
          }),
        });

        expect(response.status).toBe(200);
        expect(forwardedBodies[0]).not.toMatchObject({
          service_tier: "priority",
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy uses the manually selected direct account when autoswitch is off", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { writeSyntheticProxyRuntime } = await import("../src/proxy/config.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "pro", "user-beta"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 5, one_week_used: 10 },
      );
      await writeQuotaMeta(
        (await store.getManagedAccount("beta")).metaPath,
        { status: "ok", plan_type: "pro", five_hour_used: 60, one_week_used: 65 },
      );

      await store.switchAccount("beta");
      const proxyRuntimeState = await writeSyntheticProxyRuntime({
        store,
        state: {
          pid: 12345,
          host: "127.0.0.1",
          port: 14555,
          started_at: "2026-04-18T00:00:00.000Z",
          log_path: "/tmp/codexm-proxy.log",
          base_url: "http://127.0.0.1:14555/backend-api",
          openai_base_url: "http://127.0.0.1:14555/v1",
          debug: false,
        },
      });
      await writeProxyState(store.paths.codexTeamDir, proxyRuntimeState);
      await writeDaemonState(store.paths.codexTeamDir, {
        pid: 54321,
        started_at: "2026-04-18T00:00:00.000Z",
        log_path: "/tmp/daemon.log",
        stayalive: true,
        watch: false,
        auto_switch: false,
        proxy: true,
        host: "127.0.0.1",
        port: 14555,
        base_url: "http://127.0.0.1:14555/backend-api",
        openai_base_url: "http://127.0.0.1:14555/v1",
        debug: false,
      });

      const forwardedBodies: Array<Record<string, unknown>> = [];
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return sseResponse([
            {
              type: "response.completed",
              response: {
                id: "resp_manual",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
          ]);
        },
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            input: "hello",
          }),
        });

        expect(response.status).toBe(200);
        expect(forwardedBodies).toHaveLength(1);
      } finally {
        await server.close();
      }

      expect(requestLogs.at(-1)).toMatchObject({
        selected_account_name: "beta",
        selected_auth_mode: "chatgpt",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy follows the saved direct account even when autoswitch is on", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { writeSyntheticProxyRuntime } = await import("../src/proxy/config.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "pro", "user-beta"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 5, one_week_used: 10 },
      );
      await writeQuotaMeta(
        (await store.getManagedAccount("beta")).metaPath,
        { status: "ok", plan_type: "pro", five_hour_used: 60, one_week_used: 65 },
      );

      await store.switchAccount("beta");
      const proxyRuntimeState = await writeSyntheticProxyRuntime({
        store,
        state: {
          pid: 12345,
          host: "127.0.0.1",
          port: 14555,
          started_at: "2026-04-18T00:00:00.000Z",
          log_path: "/tmp/codexm-proxy.log",
          base_url: "http://127.0.0.1:14555/backend-api",
          openai_base_url: "http://127.0.0.1:14555/v1",
          debug: false,
        },
      });
      await writeProxyState(store.paths.codexTeamDir, proxyRuntimeState);
      await writeDaemonState(store.paths.codexTeamDir, {
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
      });

      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async () => sseResponse([
          {
            type: "response.completed",
            response: {
              id: "resp_manual_autoswitch",
              object: "response",
              model: "gpt-5.4",
              output: [],
            },
          },
        ]),
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            input: "hello",
          }),
        });

        expect(response.status).toBe(200);
      } finally {
        await server.close();
      }

      expect(requestLogs.at(-1)).toMatchObject({
        selected_account_name: "beta",
        selected_auth_mode: "chatgpt",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy synthetic usage rounds fractional aggregate percents for Desktop compatibility", async () => {
    const { buildProxyUsagePayload } = await import("../src/proxy/quota.js");

    const usage = buildProxyUsagePayload({
      name: "proxy",
      account_id: "codexm-proxy-account",
      user_id: "codexm-proxy",
      identity: "codexm-proxy-account:codexm-proxy",
      auto_switch_eligible: true,
      plan_type: "pro",
      credits_balance: null,
      status: "ok",
      fetched_at: "2026-04-21T06:31:18.767Z",
      error_message: null,
      unlimited: true,
      five_hour: {
        used_percent: 35.7,
        window_seconds: 18_000,
        reset_after_seconds: 12_052,
        reset_at: "2026-04-21T09:15:41.000Z",
      },
      one_week: {
        used_percent: 10.7,
        window_seconds: 604_800,
        reset_after_seconds: 581_524,
        reset_at: "2026-04-27T23:00:13.000Z",
      },
    });

    expect(usage.rate_limit.primary_window?.used_percent).toBe(36);
    expect(usage.rate_limit.secondary_window?.used_percent).toBe(11);
    expect(Number.isInteger(usage.rate_limit.primary_window?.used_percent)).toBe(true);
    expect(Number.isInteger(usage.rate_limit.secondary_window?.used_percent)).toBe(true);
  });

  test("proxy server adapts chat completions through ChatGPT codex responses", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 20, one_week_used: 40 },
      );

      const forwarded: Array<{ url: string; accountId: string | null; body: unknown }> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url, init) => {
          forwarded.push({
            url: String(url),
            accountId: new Headers(init?.headers).get("ChatGPT-Account-Id"),
            body: JSON.parse(String(init?.body ?? "{}")) as unknown,
          });
          return sseResponse([
            {
              type: "response.completed",
              response: {
                id: "resp_2",
                object: "response",
                model: "gpt-5.4",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "OK" }],
                  },
                ],
              },
            },
          ]);
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            messages: [{ role: "user", content: "Reply with OK only." }],
          }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          object: "chat.completion",
          choices: [{ message: { content: "OK" } }],
        });
        expect(forwarded[0]).toMatchObject({
          url: "https://chatgpt.com/backend-api/codex/responses",
          accountId: "acct-alpha",
          body: {
            model: "gpt-5.4",
            instructions: "You are Codex.",
            store: false,
            stream: true,
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: "Reply with OK only." }],
              },
            ],
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy websocket keeps a turn on one upstream account and reconstructs full input when the next turn switches accounts", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    const upstreamHttp = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamHttp });
    const upstreamConnections: Array<{
      accountId: string | null;
      bodies: Record<string, unknown>[];
    }> = [];
    const debugLogs: string[] = [];
    const requestLogs: Array<Record<string, unknown>> = [];

    try {
      await new Promise<void>((resolve, reject) => {
        upstreamHttp.once("error", reject);
        upstreamHttp.listen(0, "127.0.0.1", () => {
          upstreamHttp.off("error", reject);
          resolve();
        });
      });
      const upstreamAddress = upstreamHttp.address();
      const upstreamPort = typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;
      const upstreamUrl = `ws://127.0.0.1:${upstreamPort}/backend-api/codex/responses`;

      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 5, one_week_used: 5 },
      );
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeQuotaMeta(
        (await store.getManagedAccount("beta")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 20, one_week_used: 20 },
      );
      await writeDaemonState(store.paths.codexTeamDir, {
        pid: 54321,
        started_at: "2026-04-18T00:00:00.000Z",
        log_path: "/tmp/daemon.log",
        stayalive: true,
        watch: false,
        auto_switch: true,
        proxy: true,
        host: "127.0.0.1",
        port: 14555,
        base_url: "http://127.0.0.1:14555/backend-api",
        openai_base_url: "http://127.0.0.1:14555/v1",
        debug: false,
      });

      upstreamWs.on("connection", (socket, request) => {
        const connection = {
          accountId: typeof request.headers["chatgpt-account-id"] === "string"
            ? request.headers["chatgpt-account-id"]
            : null,
          bodies: [] as Record<string, unknown>[],
        };
        upstreamConnections.push(connection);

        socket.on("message", async (raw) => {
          const body = JSON.parse(raw.toString()) as Record<string, unknown>;
          connection.bodies.push(body);
          if (connection.bodies.length === 1 && connection.accountId === "acct-alpha") {
            socket.send(JSON.stringify({
              type: "response.created",
              response: { id: "resp_1" },
            }));
            socket.send(JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "one" }],
              },
            }));
            socket.send(JSON.stringify({
              type: "response.output_item.done",
              output_index: 1,
              item: {
                id: "fc_1",
                type: "function_call",
                call_id: "call_replay",
                name: "lookup",
                arguments: "{\"query\":\"hello\"}",
                status: "completed",
              },
            }));
            socket.send(JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_1",
                output: [],
              },
            }));

            await writeQuotaMeta(
              (await store.getManagedAccount("alpha")).metaPath,
              { status: "ok", plan_type: "plus", five_hour_used: 100, one_week_used: 100 },
            );
            await writeQuotaMeta(
              (await store.getManagedAccount("beta")).metaPath,
              { status: "ok", plan_type: "plus", five_hour_used: 10, one_week_used: 10 },
            );
            return;
          }

          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_2" },
          }));
          socket.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_2",
              output: [],
            },
          }));
        });
      });

      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        debugLog: (message) => {
          debugLogs.push(message);
        },
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        connectWebSocketImpl: async (options) => await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(upstreamUrl, {
            headers: options.headers,
            perMessageDeflate: false,
          });
          socket.once("open", () => resolve(socket));
          socket.once("error", reject);
        }),
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const downstream = new WebSocket(`${server.openaiBaseUrl.replace(/^http/u, "ws")}/responses`, {
          headers: {
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          perMessageDeflate: false,
        });
        await waitForWebSocketOpen(downstream);

        const runTurn = async (payload: Record<string, unknown>) => {
          try {
            return await sendWebSocketTurnAndCollectTerminal(downstream, payload);
          } catch (error) {
            const details = {
              upstreamConnections,
              debugLogs,
              requestLogs,
            };
            throw new Error(`${(error as Error).message}\n${JSON.stringify(details, null, 2)}`);
          }
        };

        const firstEvents = await runTurn({
          type: "response.create",
          model: "gpt-5.4",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hello" }],
            },
          ],
        });
        expect(firstEvents.map((event) => event.type)).toContain("response.completed");
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const summaries = await store.listQuotaSummaries();
          const alpha = summaries.accounts.find((account) => account.name === "alpha");
          const beta = summaries.accounts.find((account) => account.name === "beta");
          if (alpha?.five_hour?.used_percent === 100 && beta?.five_hour?.used_percent === 10) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const secondEvents = await runTurn({
          type: "response.create",
          model: "gpt-5.4",
          previous_response_id: "resp_1",
          input: [
            {
              type: "function_call_output",
              call_id: "call_replay",
              output: "{\"result\":\"ok\"}",
            },
          ],
        });
        expect(secondEvents.map((event) => event.type)).toContain("response.completed");

        expect(upstreamConnections).toHaveLength(2);
        expect(upstreamConnections[0]?.accountId).toBe("acct-alpha");
        expect(upstreamConnections[1]?.accountId).toBe("acct-beta");
        expect(upstreamConnections[0]?.bodies[0]).toMatchObject({
          type: "response.create",
          model: "gpt-5.4",
        });
        expect((upstreamConnections[0]?.bodies[0]?.input as unknown[] | undefined)?.length).toBe(1);
        expect(upstreamConnections[1]?.bodies[0]).toMatchObject({
          type: "response.create",
          model: "gpt-5.4",
        });
        expect(upstreamConnections[1]?.bodies[0]?.previous_response_id).toBeUndefined();
        const replayedInput = upstreamConnections[1]?.bodies[0]?.input as Array<Record<string, unknown>> | undefined;
        expect(replayedInput?.length).toBe(4);
        expect(replayedInput?.[1]).toEqual({
          role: "assistant",
          content: [{ type: "output_text", text: "one" }],
        });
        expect(replayedInput?.[2]).toEqual({
          type: "function_call",
          call_id: "call_replay",
          name: "lookup",
          arguments: "{\"query\":\"hello\"}",
        });
        expect(replayedInput?.[3]).toEqual({
          type: "function_call_output",
          call_id: "call_replay",
          output: "{\"result\":\"ok\"}",
        });

        downstream.close();
        await waitForWebSocketClose(downstream);
      } finally {
        await server.close();
      }
    } finally {
      for (const client of upstreamWs.clients) {
        client.terminate();
      }
      upstreamWs.close();
      await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy websocket injects service_tier priority for exhausted synthetic turns", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    const upstreamHttp = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamHttp });
    const upstreamBodies: Record<string, unknown>[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        upstreamHttp.once("error", reject);
        upstreamHttp.listen(0, "127.0.0.1", () => {
          upstreamHttp.off("error", reject);
          resolve();
        });
      });
      const upstreamAddress = upstreamHttp.address();
      const upstreamPort = typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;
      const upstreamUrl = `ws://127.0.0.1:${upstreamPort}/backend-api/codex/responses`;

      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 100, one_week_used: 100 },
      );

      upstreamWs.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const body = JSON.parse(raw.toString()) as Record<string, unknown>;
          upstreamBodies.push(body);
          socket.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_fast_ws",
              output: [],
            },
          }));
        });
      });

      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        connectWebSocketImpl: async (options) => await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(upstreamUrl, {
            headers: options.headers,
            perMessageDeflate: false,
          });
          socket.once("open", () => resolve(socket));
          socket.once("error", reject);
        }),
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const downstream = new WebSocket(`${server.openaiBaseUrl.replace(/^http/u, "ws")}/responses`, {
          headers: {
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          perMessageDeflate: false,
        });
        await waitForWebSocketOpen(downstream);
        await sendWebSocketTurnAndCollectTerminal(downstream, {
          type: "response.create",
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        });

        expect(upstreamBodies[0]).toMatchObject({
          service_tier: "priority",
        });

        downstream.close();
        await waitForWebSocketClose(downstream);
      } finally {
        await server.close();
      }
    } finally {
      for (const client of upstreamWs.clients) {
        client.terminate();
      }
      upstreamWs.close();
      await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy server preserves text from SSE output_item events for non-stream responses", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 20, one_week_used: 40 },
      );

      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async () => sseResponse([
          {
            type: "response.created",
            response: {
              id: "resp_stream",
              object: "response",
              model: "gpt-5.4",
              output: [],
            },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "msg_stream",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OK" }],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_stream",
              object: "response",
              model: "gpt-5.4",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 1,
                output_tokens: 2,
                total_tokens: 3,
              },
            },
          },
        ]),
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));

        const responses = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false }),
        });
        expect(responses.status).toBe(200);
        expect(await responses.json()).toMatchObject({
          id: "resp_stream",
          status: "completed",
          output_text: "OK",
        });

        const chat = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          }),
        });
        expect(chat.status).toBe(200);
        expect(await chat.json()).toMatchObject({
          id: "chatcmpl_stream",
          choices: [
            {
              message: {
                content: "OK",
              },
            },
          ],
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy transparently forwards unsupported ChatGPT-compatible /v1 routes like responses/compact", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 10, one_week_used: 10 },
      );

      const forwarded: Array<{ url: string; body: unknown; accountId: string | null }> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url, init) => {
          forwarded.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as unknown,
            accountId: new Headers(init?.headers).get("ChatGPT-Account-Id"),
          });
          return jsonResponse({
            id: "compact_1",
            object: "response.compact",
            summary: "ok",
          });
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/responses/compact`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            response_id: "resp_123",
            compression: "auto",
          }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          id: "compact_1",
          object: "response.compact",
        });
        expect(forwarded[0]).toMatchObject({
          url: "https://chatgpt.com/backend-api/codex/responses/compact",
          accountId: "acct-alpha",
          body: {
            model: "gpt-5.4",
            response_id: "resp_123",
            compression: "auto",
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy server adapts chat completions and transparently forwards API-key OpenAI routes", async () => {
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot(
        "api-main",
        {
          auth_mode: "apikey",
          OPENAI_API_KEY: "sk-test-proxy",
        },
        {
          rawConfig: 'base_url = "https://api.example.test/v1"\n',
        },
      );
      const forwarded: Array<{ url: string; authorization: string | null; body: unknown }> = [];
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        fetchImpl: async (url, init) => {
          forwarded.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
            body: JSON.parse(String(init?.body ?? "{}")) as unknown,
          });
          return jsonResponse({
            id: "chatcmpl_1",
            object: "chat.completion",
            model: "gpt-4.1",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello" },
                finish_reason: "stop",
              },
            ],
          });
        },
      });

      try {
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4.1",
            messages: [{ role: "user", content: "hi" }],
          }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          object: "chat.completion",
          choices: [{ message: { content: "hello" } }],
        });
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]).toMatchObject({
          url: "https://api.example.test/v1/chat/completions",
          authorization: "Bearer sk-test-proxy",
        });
        expect(forwarded[0]?.body).toMatchObject({ model: "gpt-4.1" });
        expect(requestLogs[0]).toMatchObject({
          route: "/v1/chat/completions",
          surface: "v1",
          auth_kind: "apikey",
          selected_account_name: "api-main",
          selected_auth_mode: "apikey",
          upstream_kind: "openai",
          status_code: 200,
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

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
          reset_at: "2026-04-18T05:00:00.000Z",
        },
        one_week: {
          used_percent: 90,
          window_seconds: 604_800,
          reset_at: "2026-04-25T00:00:00.000Z",
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
          reset_at: "2026-04-18T04:00:00.000Z",
        },
        one_week: {
          used_percent: 10,
          window_seconds: 604_800,
          reset_at: "2026-04-24T00:00:00.000Z",
        },
        auto_switch_eligible: true,
      },
    ]);

    expect(aggregate).not.toBeNull();
    expect(aggregate?.summary.five_hour?.used_percent).toBe(17.3);
    expect(aggregate?.summary.one_week?.used_percent).toBe(18.6);
    expect(aggregate?.watchEtaTarget.remaining_5h_eq_1w).toBe(136.5);
    expect(aggregate?.watchEtaTarget.remaining_1w).toBe(760);
    expect(aggregate?.summary.five_hour?.reset_at).toBe("2026-04-18T04:00:00.000Z");
    expect(aggregate?.summary.one_week?.reset_at).toBe("2026-04-24T00:00:00.000Z");
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
