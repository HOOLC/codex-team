import { createServer, request as httpRequest } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, test } from "@rstest/core";
import { WebSocket, WebSocketServer } from "ws";

import { createAccountStore } from "../src/account-store/index.js";
import { decodeJwtPayload, getSnapshotAccountId, getSnapshotEmail, getSnapshotUserId, readAuthSnapshotFile } from "../src/auth-snapshot.js";
import type { RunnerOptions } from "../src/codex-cli-runner.js";
import { writeDaemonState } from "../src/daemon/state.js";
import { runCli } from "../src/main.js";
import { buildCachedAccountDashboardSnapshot } from "../src/commands/tui.js";
import { PROXY_ACCOUNT_ID, PROXY_PORT_ENV_VAR } from "../src/proxy/constants.js";
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

async function writeProxyManualUpstreamAuth(homeDir: string, authPath: string): Promise<void> {
  const proxyDir = join(homeDir, ".codex-team", "proxy");
  await mkdir(proxyDir, { recursive: true });
  await writeFile(
    join(proxyDir, "last-direct-auth.json"),
    await readFile(authPath, "utf8"),
    "utf8",
  );
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
      const store = createAccountStore(homeDir, {
        fetchImpl: async () =>
          jsonResponse({
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
          }),
      });
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
        running: true,
        base_url: "http://127.0.0.1:14555/backend-api",
      });
      const statusStdout = captureWritable();
      const statusCode = await runCli(["proxy", "status", "--json"], {
        store,
        stdout: statusStdout.stream,
        stderr: stderr.stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(statusCode).toBe(0);
      expect(JSON.parse(statusStdout.read())).toMatchObject({
        ok: true,
        action: "proxy.status",
        enabled: false,
        running: true,
      });
      const restoredAuth = await readCurrentAuth(homeDir);
      expect(getSnapshotAccountId(restoredAuth)).toBe("acct-direct");
      expect(getSnapshotUserId(restoredAuth)).toBe("user-direct");
      expect(await readCurrentConfig(homeDir)).toContain("old.example");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy drift recovery reapplies synthetic auth without overwriting the saved upstream backup", async () => {
    const { ensureSyntheticProxyRuntimeActive } = await import("../src/proxy/runtime.js");
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-plus3", "chatgpt", "plus", "user-plus3");
      await writeCurrentConfig(
        homeDir,
        [
          'model = "gpt-5"',
          'preferred_auth_method = "chatgpt"',
        ].join("\n"),
      );
      const store = createAccountStore(homeDir);
      const proxyProcess = createProxyProcessManagerStub();

      const enableCode = await runCli(["proxy", "enable", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(enableCode).toBe(0);

      await writeCurrentAuth(homeDir, "acct-plus1", "chatgpt", "plus", "user-plus1");
      await writeCurrentConfig(
        homeDir,
        [
          'model = "gpt-5"',
          'preferred_auth_method = "chatgpt"',
        ].join("\n"),
      );

      const recovered = await ensureSyntheticProxyRuntimeActive(store);
      expect(recovered).toMatchObject({
        restored: true,
        authWasSynthetic: false,
        configWasSynthetic: false,
      });

      const recoveredAuth = await readCurrentAuth(homeDir);
      expect(getSnapshotEmail(recoveredAuth)).toBe("proxy@codexm.local");
      expect(getSnapshotAccountId(recoveredAuth)).toBe("codexm-proxy-account");

      const savedDirectAuth = await readAuthSnapshotFile(join(store.paths.codexTeamDir, "proxy", "last-direct-auth.json"));
      expect(getSnapshotAccountId(savedDirectAuth)).toBe("acct-plus3");

      const recoveredConfig = await readCurrentConfig(homeDir);
      expect(recoveredConfig).toContain('chatgpt_base_url = "http://127.0.0.1:14555/backend-api"');
      expect(recoveredConfig).toContain('openai_base_url = "http://127.0.0.1:14555/v1"');
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

  test("proxy disable sanitizes proxy base urls restored from a contaminated direct config backup with a stale port", async () => {
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
        port: 14655,
        started_at: "2026-04-18T00:00:00.000Z",
        log_path: "/tmp/codexm-proxy.log",
        base_url: "http://127.0.0.1:14655/backend-api",
        openai_base_url: "http://127.0.0.1:14655/v1",
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

  test("proxy disable keeps the shared daemon listener running while restoring direct runtime", async () => {
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

      const stdout = captureWritable();
      const exitCode = await runCli(["proxy", "disable"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain("Proxy daemon is still listening at http://127.0.0.1:14555/backend-api.");
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

      const stdout = captureWritable();
      const switchCode = await runCli(["switch", "real-main", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
        proxyProcessManager: proxyProcess.manager,
      } as never);
      expect(switchCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        backup_path: null,
        effective_current_account_name: "proxy",
        proxy_retained: true,
      });

      const currentConfig = await readCurrentConfig(homeDir);
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("codexm-proxy-account");
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

  test("list and dashboard keep @ on the configured proxy upstream even before any request log hit", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-real", "chatgpt", "plus", "user-real");
      const store = createAccountStore(homeDir, {
        fetchImpl: async () =>
          jsonResponse({
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
          }),
      });
      await store.saveCurrentAccount("real-main");
      const savedDirectAuth = await readFile(store.paths.currentAuthPath, "utf8");
      const backupAuthPath = join(homeDir, ".codex-team", "proxy", "last-direct-auth.json");
      await mkdir(join(homeDir, ".codex-team", "proxy"), { recursive: true });
      await writeFile(backupAuthPath, savedDirectAuth, "utf8");
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
        log_path: join(homeDir, ".codex-team", "logs", "proxy.log"),
        base_url: "http://127.0.0.1:14555/backend-api",
        openai_base_url: "http://127.0.0.1:14555/v1",
        debug: false,
        enabled: true,
        direct_auth_backup_path: backupAuthPath,
        direct_config_backup_path: null,
        direct_auth_existed: true,
        direct_config_existed: false,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
      } as never);
      expect(listCode).toBe(0);
      const listPayload = JSON.parse(listStdout.read()) as {
        proxy_current_upstream: { account_name: string } | null;
        proxy_last_upstream: { account_name: string } | null;
      };
      expect(listPayload.proxy_current_upstream).toEqual({
        account_name: "real-main",
      });
      expect(listPayload.proxy_last_upstream).toBeNull();

      const textListStdout = captureWritable();
      const textListCode = await runCli(["list"], {
        store,
        stdout: textListStdout.stream,
        stderr: captureWritable().stream,
        desktopLauncher: createDesktopLauncherStub(),
      } as never);
      expect(textListCode).toBe(0);
      const textListOutput = stripAnsi(textListStdout.read());
      expect(textListOutput).not.toContain("Proxy last upstream:");
      expect(textListOutput).toMatch(/^[ *]@\s+real-main\b/m);

      const dashboard = await buildCachedAccountDashboardSnapshot({ store });
      expect(dashboard.accounts.find((account) => account.name === "real-main")).toMatchObject({
        proxyUpstreamActive: true,
      });
      expect(
        (dashboard.accounts.find((account) => account.name === "proxy")?.detailLines ?? [])
          .map(stripAnsi)
          .some((line) => line.startsWith("Last upstream:")),
      ).toBe(false);
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

  test("run --proxy lets a codex message auto-replay after quota exhaustion", async () => {
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
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

      const forwarded: Array<{ accountId: string | null; body: Record<string, unknown> }> = [];
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        fetchImpl: async (url, init) => {
          if (String(url) !== "https://chatgpt.com/backend-api/codex/responses") {
            throw new Error(`Unexpected upstream URL: ${String(url)}`);
          }
          const headers = new Headers(init?.headers);
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const accountId = headers.get("ChatGPT-Account-Id");
          forwarded.push({ accountId, body });

          if (accountId === "acct-alpha") {
            return jsonResponse({
              error: {
                codex_error_info: "usage_limit_exceeded",
                message: "You've hit your usage limit.",
              },
            }, 429);
          }

          return jsonResponse({
            id: "resp_run_retry",
            object: "response",
            model: "gpt-5.4",
            output: [{
              id: "msg_run_retry",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "replayed from run" }],
            }],
          });
        },
      });

      try {
        const serverUrl = new URL(server.baseUrl);
        const port = Number(serverUrl.port);
        await writeProxyState(store.paths.codexTeamDir, {
          pid: 22334,
          host: "127.0.0.1",
          port,
          started_at: "2026-04-18T00:00:00.000Z",
          log_path: "/tmp/codexm-proxy.log",
          base_url: server.backendBaseUrl,
          openai_base_url: server.openaiBaseUrl,
          debug: false,
          enabled: true,
        });

        const proxyProcess = createProxyProcessManagerStub({
          running: true,
          port,
        });
        const codexOutput: string[] = [];
        let overlayConfig = "";
        let responseStatus = 0;
        const exitCode = await runCli(["run", "--proxy", "--", "exec", "hello"], {
          store,
          stdout: captureWritable().stream,
          stderr: captureWritable().stream,
          desktopLauncher: createDesktopLauncherStub(),
          proxyProcessManager: proxyProcess.manager,
          runCodexCli: async (options: RunnerOptions) => {
            const codexHome = options.env?.CODEX_HOME ?? "";
            const overlayAuth = JSON.parse(await readFile(options.authFilePath ?? "", "utf8")) as {
              tokens?: { access_token?: string };
            };
            overlayConfig = await readFile(join(codexHome, "config.toml"), "utf8");

            const response = await fetch(`${server.openaiBaseUrl}/responses`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${String(overlayAuth.tokens?.access_token)}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: "gpt-5.4",
                input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
                stream: false,
              }),
            });
            responseStatus = response.status;
            codexOutput.push(await response.text());

            return {
              exitCode: 0,
              restartCount: 0,
            };
          },
        } as never);

        expect(exitCode).toBe(0);
        expect(overlayConfig).toContain(`openai_base_url = "${server.openaiBaseUrl}"`);
        expect(responseStatus).toBe(200);
        expect(proxyProcess.calls).toEqual([]);
        expect(forwarded.map((entry) => entry.accountId)).toEqual(["acct-alpha", "acct-beta"]);
        expect(codexOutput.join("\n")).toContain("replayed from run");
        expect((await readAuthSnapshotFile(join(homeDir, ".codex-team", "proxy", "last-direct-auth.json"))).tokens?.account_id)
          .toBe("acct-beta");
        expect(
          requestLogs.find((entry) => entry.route === "/v1/responses" && entry.status_code === 200),
        ).toMatchObject({
          selected_account_name: "beta",
          replay_attempted: true,
          replay_count: 1,
          replay_succeeded: true,
          replayed_from_account_names: ["alpha"],
        });
      } finally {
        await server.close();
      }
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
          service_tier: "default",
          synthetic_usage: true,
          status_code: 200,
        });
        expect(requestLogs[0]).toMatchObject({
          request_body_text: "",
          upstream_url: null,
          upstream_request_headers: null,
          response_headers: {
            "content-type": "application/json",
          },
        });
        expect(
          JSON.parse(String(requestLogs[0]?.response_body_text ?? "{}")) as Record<string, unknown>,
        ).toMatchObject({
          plan_type: "pro",
        });

        const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
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
        expect(await response.json()).toMatchObject({ id: expect.stringMatching(/^resp_pxy_/u) });
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
          service_tier: "default",
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
        expect(requestLogs[1]).toMatchObject({
          request_headers: {
            authorization: "Bearer direct-access-token",
            "chatgpt-account-id": "acct-alpha",
          },
          request_body_text: "",
          upstream_url: "https://chatgpt.com/backend-api/wham/usage",
          upstream_request_headers: {
            authorization: "Bearer direct-access-token",
            "chatgpt-account-id": "acct-alpha",
          },
        });
        expect(
          JSON.parse(String(requestLogs[1]?.response_body_text ?? "{}")) as Record<string, unknown>,
        ).toMatchObject({
          plan_type: "plus",
        });

        const desktopUsageResponse = await fetch(`${server.baseUrl}/backend-api/backend-api/wham/usage`, {
          headers: {
            authorization: "Bearer direct-access-token",
            "ChatGPT-Account-Id": "acct-alpha",
            "User-Agent": "Codex Desktop/0.122.0-alpha.13 (Mac OS 26.4.1; arm64)",
          },
        });
        expect(desktopUsageResponse.status).toBe(200);
        const desktopUsage = await desktopUsageResponse.json() as {
          plan_type: string;
          rate_limit: {
            primary_window: { used_percent: number };
            secondary_window: { used_percent: number };
          };
        };
        expect(desktopUsage.plan_type).toBe("pro");
        expect(desktopUsage.rate_limit.primary_window.used_percent).toBe(20);
        expect(desktopUsage.rate_limit.secondary_window.used_percent).toBe(40);
        expect(requestLogs[2]).toMatchObject({
          route: "/backend-api/wham/usage",
          auth_kind: "synthetic-chatgpt",
          synthetic_usage: true,
          status_code: 200,
        });
        expect(requestLogs[2]).toMatchObject({
          request_headers: {
            authorization: "Bearer direct-access-token",
            "chatgpt-account-id": "acct-alpha",
            "user-agent": "Codex Desktop/0.122.0-alpha.13 (Mac OS 26.4.1; arm64)",
          },
        });
        expect(forwardedUrls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy serves a synthetic desktop account surface for usage helper routes and preserves direct passthrough", async () => {
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
          if (String(url) === "https://chatgpt.com/backend-api/wham/accounts/check") {
            return jsonResponse({
              accounts: [
                {
                  id: "acct-alpha",
                  account_user_id: "user-alpha__acct-alpha",
                  structure: "personal",
                  plan_type: "plus",
                  name: "alpha",
                  profile_picture_url: null,
                },
              ],
              default_account_id: "acct-alpha",
              account_ordering: ["acct-alpha"],
            });
          }
          if (String(url) === "https://chatgpt.com/backend-api/subscriptions/auto_top_up/settings") {
            return jsonResponse({
              is_enabled: true,
              recharge_threshold: 25,
              recharge_target: 50,
            });
          }
          if (String(url) === "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27") {
            return jsonResponse({
              accounts: {
                "acct-alpha": {
                  account: {
                    account_user_role: "owner",
                  },
                  entitlement: {
                    billing_currency: "JPY",
                  },
                },
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
        const syntheticWhamAccounts = await fetch(`${server.baseUrl}/backend-api/wham/accounts/check`);
        expect(syntheticWhamAccounts.status).toBe(200);
        expect(await syntheticWhamAccounts.json()).toMatchObject({
          default_account_id: PROXY_ACCOUNT_ID,
          account_ordering: [PROXY_ACCOUNT_ID],
          accounts: [
            {
              id: PROXY_ACCOUNT_ID,
              plan_type: "pro",
              name: "proxy",
            },
          ],
        });

        const desktopWhamAccounts = await fetch(`${server.baseUrl}/backend-api/wham/accounts/check`, {
          headers: {
            authorization: "Bearer direct-account-token",
            "ChatGPT-Account-Id": "acct-alpha",
            "User-Agent": "Codex Desktop/0.122.0-alpha.13 (Mac OS 26.4.1; arm64)",
          },
        });
        expect(desktopWhamAccounts.status).toBe(200);
        expect(await desktopWhamAccounts.json()).toMatchObject({
          default_account_id: PROXY_ACCOUNT_ID,
        });

        const directWhamAccounts = await fetch(`${server.baseUrl}/backend-api/wham/accounts/check`, {
          headers: {
            authorization: "Bearer direct-account-token",
            "ChatGPT-Account-Id": "acct-alpha",
          },
        });
        expect(directWhamAccounts.status).toBe(200);
        expect(await directWhamAccounts.json()).toMatchObject({
          default_account_id: "acct-alpha",
          account_ordering: ["acct-alpha"],
          accounts: [
            {
              id: "acct-alpha",
              plan_type: "plus",
              name: "alpha",
            },
          ],
        });

        const syntheticAutoTopUp = await fetch(`${server.baseUrl}/backend-api/subscriptions/auto_top_up/settings`);
        expect(syntheticAutoTopUp.status).toBe(200);
        expect(await syntheticAutoTopUp.json()).toEqual({
          is_enabled: false,
          recharge_threshold: null,
          recharge_target: null,
        });

        const directAutoTopUp = await fetch(`${server.baseUrl}/backend-api/subscriptions/auto_top_up/settings`, {
          headers: {
            authorization: "Bearer direct-account-token",
            "ChatGPT-Account-Id": "acct-alpha",
          },
        });
        expect(directAutoTopUp.status).toBe(200);
        expect(await directAutoTopUp.json()).toEqual({
          is_enabled: true,
          recharge_threshold: 25,
          recharge_target: 50,
        });

        const syntheticAccountCheck = await fetch(`${server.baseUrl}/backend-api/accounts/check/v4-2023-04-27`);
        expect(syntheticAccountCheck.status).toBe(200);
        expect(await syntheticAccountCheck.json()).toMatchObject({
          accounts: {
            [PROXY_ACCOUNT_ID]: {
              account: {
                account_user_role: "owner",
              },
              entitlement: {
                billing_currency: "USD",
              },
            },
          },
        });

        const directAccountCheck = await fetch(`${server.baseUrl}/backend-api/accounts/check/v4-2023-04-27`, {
          headers: {
            authorization: "Bearer direct-account-token",
            "ChatGPT-Account-Id": "acct-alpha",
          },
        });
        expect(directAccountCheck.status).toBe(200);
        expect(await directAccountCheck.json()).toMatchObject({
          accounts: {
            "acct-alpha": {
              account: {
                account_user_role: "owner",
              },
              entitlement: {
                billing_currency: "JPY",
              },
            },
          },
        });

        expect(forwardedUrls).toEqual([
          "https://chatgpt.com/backend-api/wham/accounts/check",
          "https://chatgpt.com/backend-api/subscriptions/auto_top_up/settings",
          "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
        ]);
        expect(requestLogs).toHaveLength(7);
        expect(requestLogs[0]).toMatchObject({
          route: "/backend-api/wham/accounts/check",
          auth_kind: "synthetic-chatgpt",
          upstream_url: null,
          status_code: 200,
        });
        expect(requestLogs[1]).toMatchObject({
          route: "/backend-api/wham/accounts/check",
          auth_kind: "synthetic-chatgpt",
          upstream_url: null,
          request_headers: {
            authorization: "Bearer direct-account-token",
            "chatgpt-account-id": "acct-alpha",
            "user-agent": "Codex Desktop/0.122.0-alpha.13 (Mac OS 26.4.1; arm64)",
          },
        });
        expect(requestLogs[2]).toMatchObject({
          route: "/backend-api/wham/accounts/check",
          auth_kind: "direct-chatgpt",
          upstream_url: "https://chatgpt.com/backend-api/wham/accounts/check",
        });
        expect(requestLogs[3]).toMatchObject({
          route: "/backend-api/subscriptions/auto_top_up/settings",
          auth_kind: "synthetic-chatgpt",
          upstream_url: null,
        });
        expect(requestLogs[4]).toMatchObject({
          route: "/backend-api/subscriptions/auto_top_up/settings",
          auth_kind: "direct-chatgpt",
          upstream_url: "https://chatgpt.com/backend-api/subscriptions/auto_top_up/settings",
        });
        expect(requestLogs[5]).toMatchObject({
          route: "/backend-api/accounts/check/v4-2023-04-27",
          auth_kind: "synthetic-chatgpt",
          upstream_url: null,
        });
        expect(requestLogs[6]).toMatchObject({
          route: "/backend-api/accounts/check/v4-2023-04-27",
          auth_kind: "direct-chatgpt",
          upstream_url: "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy requests identity encoding for ChatGPT backend routes", async () => {
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const forwardedHeaders: Headers[] = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url, init) => {
          if (String(url) !== "https://chatgpt.com/backend-api/plugins/featured") {
            throw new Error(`Unexpected upstream URL: ${String(url)}`);
          }
          forwardedHeaders.push(new Headers(init?.headers));
          return jsonResponse(["github@openai-curated"]);
        },
      });

      try {
        const response = await fetch(`${server.baseUrl}/backend-api/plugins/featured`, {
          headers: {
            authorization: "Bearer direct-account-token",
            "ChatGPT-Account-Id": "acct-alpha",
            "accept-encoding": "gzip, deflate",
          },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(["github@openai-curated"]);
        expect(forwardedHeaders[0]?.get("accept-encoding")).toBe("identity");
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy preserves direct usage helper responses when diagnostic buffering fails", async () => {
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url) => {
          if (String(url) !== "https://chatgpt.com/backend-api/wham/usage") {
            throw new Error(`Unexpected upstream URL: ${String(url)}`);
          }

          const response = jsonResponse({
            plan_type: "team",
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: { used_percent: 100 },
              secondary_window: { used_percent: 47 },
            },
          });
          Object.defineProperty(response, "text", {
            value: async () => {
              throw new Error("Decompression failed");
            },
          });
          return response;
        },
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
      });

      try {
        const directUsage = await fetch(`${server.baseUrl}/backend-api/wham/usage`, {
          headers: {
            authorization: "Bearer direct-account-token",
            "ChatGPT-Account-Id": "acct-alpha",
            "accept-encoding": "gzip, deflate",
          },
        });

        expect(directUsage.status).toBe(200);
        expect(await directUsage.json()).toMatchObject({
          plan_type: "team",
          rate_limit: {
            limit_reached: true,
          },
        });
        expect(requestLogs[0]).toMatchObject({
          route: "/backend-api/wham/usage",
          auth_kind: "direct-chatgpt",
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
      const requestLogs: Array<Record<string, unknown>> = [];
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
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
      });

      try {
        const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
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
        expect(requestLogs.at(-1)).toMatchObject({
          route: "/v1/responses",
          service_tier: "priority",
          status_code: 200,
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy decodes compressed request bodies and mirrors downstream accept-encoding upstream", async () => {
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

      const forwardedHeaders: Headers[] = [];
      const forwardedBodies: unknown[] = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          forwardedHeaders.push(new Headers(init?.headers));
          forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
          return jsonResponse({
            id: "resp_ae",
            object: "response",
            model: "gpt-5.4",
            output: [],
          });
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "accept-encoding": "gzip, br",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: gzipSync(Buffer.from(JSON.stringify({
            model: "gpt-5.4",
            input: "hello",
            stream: false,
          }))),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: expect.stringMatching(/^resp_pxy_/u) });
        expect(forwardedBodies[0]).toMatchObject({
          model: "gpt-5.4",
          stream: true,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hello" }],
            },
          ],
        });
        expect(forwardedHeaders[0]?.get("content-encoding")).toBeNull();
        expect(forwardedHeaders[0]?.get("accept-encoding")).toBe("gzip, br");

        const secondResponse = await new Promise<{ statusCode: number; bodyText: string }>((resolve, reject) => {
          const request = httpRequest(`${server.baseUrl}/v1/responses`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
            },
          }, (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            incoming.on("end", () => {
              resolve({
                statusCode: incoming.statusCode ?? 0,
                bodyText: Buffer.concat(chunks).toString("utf8"),
              });
            });
            incoming.on("error", reject);
          });
          request.on("error", reject);
          request.end(JSON.stringify({ model: "gpt-5.4", input: "hi again", stream: false }));
        });

        expect(secondResponse.statusCode).toBe(200);
        expect(JSON.parse(secondResponse.bodyText) as Record<string, unknown>).toMatchObject({
          id: expect.stringMatching(/^resp_pxy_/u),
        });
        expect(forwardedBodies[1]).toMatchObject({
          model: "gpt-5.4",
          stream: true,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hi again" }],
            },
          ],
        });
        expect(forwardedHeaders[1]?.get("accept-encoding")).toBe("identity");
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });


  test("proxy captures full diagnostic payloads for backend account check routes", async () => {
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url, init) => {
          expect(String(url)).toBe("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer direct-account-token");
          expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("acct-direct");
          return jsonResponse({
            accounts: {
              "acct-direct": {
                account: {
                  account_user_role: "owner",
                },
              },
            },
          });
        },
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
      });

      try {
        const response = await fetch(`${server.baseUrl}/backend-api/accounts/check/v4-2023-04-27`, {
          headers: {
            authorization: "Bearer direct-account-token",
            "ChatGPT-Account-Id": "acct-direct",
          },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          accounts: {
            "acct-direct": {
              account: {
                account_user_role: "owner",
              },
            },
          },
        });
        expect(requestLogs).toHaveLength(1);
        expect(requestLogs[0]).toMatchObject({
          route: "/backend-api/accounts/check/v4-2023-04-27",
          auth_kind: "direct-chatgpt",
          status_code: 200,
          request_headers: {
            authorization: "Bearer direct-account-token",
            "chatgpt-account-id": "acct-direct",
          },
          request_body_text: "",
          upstream_url: "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
          upstream_request_headers: {
            authorization: "Bearer direct-account-token",
            "chatgpt-account-id": "acct-direct",
          },
        });
        expect(
          JSON.parse(String(requestLogs[0]?.response_body_text ?? "{}")) as Record<string, unknown>,
        ).toMatchObject({
          accounts: {
            "acct-direct": {
              account: {
                account_user_role: "owner",
              },
            },
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy writes non-200 OpenAI traffic to the separate error logger without changing metadata logs", async () => {
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const requestLogs: Array<Record<string, unknown>> = [];
      const errorLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url, init) => {
          expect(String(url)).toBe("https://api.openai.com/v1/responses/compact");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-direct");
          return jsonResponse({
            error: {
              message: "compact unsupported",
            },
          }, 501);
        },
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        errorRequestLogger: async (payload) => {
          errorLogs.push(payload);
        },
      });

      try {
        const response = await fetch(`${server.baseUrl}/v1/responses/compact`, {
          method: "POST",
          headers: {
            authorization: "Bearer sk-direct",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: "resp_123",
          }),
        });

        expect(response.status).toBe(501);
        expect(await response.json()).toMatchObject({
          error: {
            message: "compact unsupported",
          },
        });
        expect(requestLogs).toHaveLength(1);
        expect(requestLogs[0]).toMatchObject({
          route: "/v1/responses/compact",
          surface: "v1",
          auth_kind: "apikey",
          selected_account_name: null,
          selected_auth_mode: null,
          upstream_kind: "openai",
          status_code: 501,
        });
        expect("request_body_text" in requestLogs[0]).toBe(false);

        expect(errorLogs).toHaveLength(1);
        expect(errorLogs[0]).toMatchObject({
          route: "/v1/responses/compact",
          status_code: 501,
          request_headers: {
            authorization: "Bearer sk-direct",
            "content-type": "application/json",
          },
          request_body_text: "{\"id\":\"resp_123\"}",
          upstream_url: "https://api.openai.com/v1/responses/compact",
          upstream_request_headers: {
            authorization: "Bearer sk-direct",
            "content-type": "application/json",
          },
          response_headers: {
            "content-type": "application/json",
          },
        });
        expect(
          JSON.parse(String(errorLogs[0]?.response_body_text ?? "{}")) as Record<string, unknown>,
        ).toMatchObject({
          error: {
            message: "compact unsupported",
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy writes local non-200 proxy errors to the separate error logger", async () => {
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

      const requestLogs: Array<Record<string, unknown>> = [];
      const errorLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async () => {
          throw new Error("embeddings should not hit upstream");
        },
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        errorRequestLogger: async (payload) => {
          errorLogs.push(payload);
        },
      });

      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const response = await fetch(`${server.baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: "hello",
          }),
        });

        expect(response.status).toBe(501);
        expect(await response.json()).toMatchObject({
          error: {
            message: "Embeddings require an API-key upstream account.",
          },
        });
        expect(requestLogs).toHaveLength(1);
        expect(requestLogs[0]).toMatchObject({
          route: "/v1/embeddings",
          auth_kind: "synthetic-chatgpt",
          selected_account_name: "alpha",
          selected_auth_mode: "chatgpt",
          status_code: 501,
        });
        expect(errorLogs).toHaveLength(1);
        expect(errorLogs[0]).toMatchObject({
          route: "/v1/embeddings",
          auth_kind: "synthetic-chatgpt",
          selected_account_name: "alpha",
          selected_auth_mode: "chatgpt",
          status_code: 501,
          request_body_text: "{\"model\":\"text-embedding-3-small\",\"input\":\"hello\"}",
          upstream_url: null,
          upstream_request_headers: null,
          response_headers: {
            "content-type": "application/json",
          },
        });
        expect(
          JSON.parse(String(errorLogs[0]?.response_body_text ?? "{}")) as Record<string, unknown>,
        ).toMatchObject({
          error: {
            message: "Embeddings require an API-key upstream account.",
          },
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

  test("proxy follows the saved direct account even when autoswitch is on and the manual account is protected", async () => {
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
      await store.setAutoSwitchEligibility("beta", false);

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
        const firstCreatedId = typeof (firstEvents.find((event) => event.type === "response.created") as {
          response?: { id?: unknown };
        } | undefined)?.response?.id === "string"
          ? String((firstEvents.find((event) => event.type === "response.created") as {
              response?: { id?: unknown };
            }).response?.id)
          : null;
        expect(firstCreatedId).toMatch(/^resp_pxy_/u);
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
          previous_response_id: firstCreatedId,
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

  test("proxy websocket reconstructs custom tool calls before replaying tool outputs across accounts", async () => {
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
              response: { id: "resp_custom_1" },
            }));
            socket.send(JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "msg_custom_1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "one" }],
              },
            }));
            socket.send(JSON.stringify({
              type: "response.output_item.done",
              output_index: 1,
              item: {
                id: "ctc_1",
                type: "custom_tool_call",
                call_id: "call_custom_replay",
                name: "apply_patch",
                input: "*** Begin Patch\n*** End Patch\n",
                status: "completed",
              },
            }));
            socket.send(JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_custom_1",
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
            response: { id: "resp_custom_2" },
          }));
          socket.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_custom_2",
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
        const firstCreatedId = typeof (firstEvents.find((event) => event.type === "response.created") as {
          response?: { id?: unknown };
        } | undefined)?.response?.id === "string"
          ? String((firstEvents.find((event) => event.type === "response.created") as {
              response?: { id?: unknown };
            }).response?.id)
          : null;
        expect(firstCreatedId).toMatch(/^resp_pxy_/u);
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
          previous_response_id: firstCreatedId,
          input: [
            {
              type: "custom_tool_call_output",
              call_id: "call_custom_replay",
              output: "{\"output\":\"ok\"}",
            },
          ],
        });
        expect(secondEvents.map((event) => event.type)).toContain("response.completed");

        expect(upstreamConnections).toHaveLength(2);
        expect(upstreamConnections[0]?.accountId).toBe("acct-alpha");
        expect(upstreamConnections[1]?.accountId).toBe("acct-beta");
        expect(upstreamConnections[1]?.bodies[0]?.previous_response_id).toBeUndefined();
        const replayedInput = upstreamConnections[1]?.bodies[0]?.input as Array<Record<string, unknown>> | undefined;
        expect(replayedInput?.length).toBe(4);
        expect(replayedInput?.[1]).toEqual({
          role: "assistant",
          content: [{ type: "output_text", text: "one" }],
        });
        expect(replayedInput?.[2]).toEqual({
          type: "custom_tool_call",
          call_id: "call_custom_replay",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch\n",
          status: "completed",
        });
        expect(replayedInput?.[3]).toEqual({
          type: "custom_tool_call_output",
          call_id: "call_custom_replay",
          output: "{\"output\":\"ok\"}",
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
  test("proxy websocket auto-replays quota failures before output starts when autoswitch is enabled", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    const upstreamHttp = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamHttp });
    const upstreamConnections: Array<{
      accountId: string | null;
      bodies: Record<string, unknown>[];
    }> = [];
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
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
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
        socket.on("message", (raw) => {
          const body = JSON.parse(raw.toString()) as Record<string, unknown>;
          connection.bodies.push(body);
          if (connection.accountId === "acct-alpha") {
            socket.send(JSON.stringify({
              type: "response.created",
              response: { id: "resp_fail" },
            }));
            socket.send(JSON.stringify({
              type: "response.failed",
              error: {
                codex_error_info: "usage_limit_exceeded",
                message: "You've hit your usage limit.",
              },
              response: {
                id: "resp_fail",
                output: [],
              },
            }));
            return;
          }

          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_retry" },
          }));
          socket.send(JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "msg_retry",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "retried" }],
            },
          }));
          socket.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_retry",
              output: [],
            },
          }));
        });
      });

      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
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

        const events = await sendWebSocketTurnAndCollectTerminal(downstream, {
          type: "response.create",
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        });

        expect(events.map((event) => event.type)).toEqual([
          "response.created",
          "response.output_item.done",
          "response.completed",
        ]);
        expect(upstreamConnections.map((connection) => connection.accountId)).toEqual(["acct-alpha", "acct-beta"]);
        expect((await readAuthSnapshotFile(join(homeDir, ".codex-team", "proxy", "last-direct-auth.json"))).tokens?.account_id)
          .toBe("acct-beta");
        expect(
          requestLogs.find((entry) => entry.route === "/v1/responses" && entry.status_code === 200),
        ).toMatchObject({
          selected_account_name: "beta",
          replay_count: 1,
          replayed_from_account_names: ["alpha"],
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

  test("proxy websocket normalizes minimal response.create payloads before forwarding upstream", async () => {
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
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);

      upstreamWs.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const body = JSON.parse(raw.toString()) as Record<string, unknown>;
          upstreamBodies.push(body);
          socket.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_ws_normalized",
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

        const events = await sendWebSocketTurnAndCollectTerminal(downstream, {
          type: "response.create",
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        });

        expect(events.map((event) => event.type)).toContain("response.completed");
        expect(upstreamBodies).toHaveLength(1);
        expect(upstreamBodies[0]).toMatchObject({
          type: "response.create",
          model: "gpt-5.4",
          instructions: "You are Codex.",
          store: false,
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
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

  test("proxy websocket auto-replays wrapped usage_limit_reached errors with status_code and writes them to the error logger", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    const upstreamHttp = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamHttp });
    const upstreamConnections: Array<{
      accountId: string | null;
      bodies: Record<string, unknown>[];
    }> = [];
    const requestLogs: Array<Record<string, unknown>> = [];
    const errorLogs: Array<Record<string, unknown>> = [];

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
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
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
        socket.on("message", (raw) => {
          const body = JSON.parse(raw.toString()) as Record<string, unknown>;
          connection.bodies.push(body);
          if (connection.accountId === "acct-alpha") {
            socket.send(JSON.stringify({
              type: "error",
              status_code: 429,
              error: {
                type: "usage_limit_reached",
                message: "The usage limit has been reached",
                plan_type: "pro",
                resets_at: 1738888888,
              },
              headers: {
                "x-codex-primary-used-percent": "100.0",
              },
            }));
            return;
          }

          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_wrapped_retry" },
          }));
          socket.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_wrapped_retry",
              output: [],
            },
          }));
        });
      });

      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        errorRequestLogger: async (payload) => {
          errorLogs.push(payload);
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

        const events = await sendWebSocketTurnAndCollectTerminal(downstream, {
          type: "response.create",
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        });

        expect(events.map((event) => event.type)).toEqual([
          "response.created",
          "response.completed",
        ]);
        expect(upstreamConnections.map((connection) => connection.accountId)).toEqual(["acct-alpha", "acct-beta"]);
        expect(
          requestLogs.find((entry) => entry.route === "/v1/responses" && entry.status_code === 200),
        ).toMatchObject({
          selected_account_name: "beta",
          replay_count: 1,
          replayed_from_account_names: ["alpha"],
          replay_succeeded: true,
        });
        expect(errorLogs).toHaveLength(1);
        expect(errorLogs[0]).toMatchObject({
          method: "WS",
          route: "/v1/responses",
          auth_kind: "synthetic-chatgpt",
          selected_account_name: "alpha",
          selected_auth_mode: "chatgpt",
          upstream_kind: "chatgpt",
          status_code: 429,
          upstream_url: "wss://chatgpt.com/backend-api/codex/responses",
          response_headers: null,
        });
        expect(String(errorLogs[0]?.request_body_text ?? "")).toContain("\"type\":\"response.create\"");
        expect(String(errorLogs[0]?.response_body_text ?? "")).toContain("\"usage_limit_reached\"");
        expect(String(errorLogs[0]?.response_body_text ?? "")).toContain("\"status_code\":429");

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

  test("proxy websocket still replays after protocol prelude events when user-visible output has not started", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    const upstreamHttp = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamHttp });
    const upstreamConnections: Array<string | null> = [];
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
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
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
        upstreamConnections.push(typeof request.headers["chatgpt-account-id"] === "string"
          ? request.headers["chatgpt-account-id"]
          : null);
        socket.on("message", () => {
          if (typeof request.headers["chatgpt-account-id"] === "string" && request.headers["chatgpt-account-id"] === "acct-alpha") {
            socket.send(JSON.stringify({
              type: "response.created",
              response: { id: "resp_prelude_fail" },
            }));
            socket.send(JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "msg_placeholder",
                type: "message",
                role: "assistant",
                content: [],
              },
            }));
            socket.send(JSON.stringify({
              type: "response.failed",
              error: {
                codex_error_info: "usage_limit_exceeded",
                message: "You've hit your usage limit.",
              },
              response: {
                id: "resp_prelude_fail",
                output: [],
              },
            }));
            return;
          }

          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_prelude_retry" },
          }));
          socket.send(JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "msg_prelude_retry",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "retried after prelude" }],
            },
          }));
          socket.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_prelude_retry",
              output: [],
            },
          }));
        });
      });

      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
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

        const events = await sendWebSocketTurnAndCollectTerminal(downstream, {
          type: "response.create",
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        });

        expect(events.map((event) => event.type)).toEqual([
          "response.created",
          "response.output_item.done",
          "response.completed",
        ]);
        expect(upstreamConnections).toEqual(["acct-alpha", "acct-beta"]);
        expect(
          requestLogs.find((entry) => entry.route === "/v1/responses" && entry.status_code === 200),
        ).toMatchObject({
          selected_account_name: "beta",
          replay_count: 1,
          replayed_from_account_names: ["alpha"],
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

  test("proxy websocket does not auto-replay after downstream output has started", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    const upstreamHttp = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamHttp });
    const upstreamConnections: Array<string | null> = [];
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
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
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
        upstreamConnections.push(typeof request.headers["chatgpt-account-id"] === "string"
          ? request.headers["chatgpt-account-id"]
          : null);
        socket.on("message", () => {
          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_partial" },
          }));
          socket.send(JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "msg_partial",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "partial" }],
            },
          }));
          socket.send(JSON.stringify({
            type: "response.failed",
            error: {
              code: "insufficient_quota",
              message: "Insufficient quota.",
            },
            response: {
              id: "resp_partial",
              output: [],
            },
          }));
        });
      });

      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
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

        const events = await sendWebSocketTurnAndCollectTerminal(downstream, {
          type: "response.create",
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        });

        expect(events.map((event) => event.type)).toEqual([
          "response.created",
          "response.output_item.done",
          "response.failed",
        ]);
        expect(upstreamConnections).toEqual(["acct-alpha"]);
        expect((await readAuthSnapshotFile(join(homeDir, ".codex-team", "proxy", "last-direct-auth.json"))).tokens?.account_id)
          .toBe("acct-alpha");
        expect(
          requestLogs.find((entry) => entry.route === "/v1/responses" && entry.status_code === 502),
        ).toMatchObject({
          selected_account_name: "alpha",
          replay_attempted: true,
          replay_count: 0,
          replay_locked_by_item_type: "message",
          replay_locked_by_type: "response.output_item.done",
          replay_skip_reason: "replay_locked",
          replay_succeeded: false,
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
        await sendWebSocketTurnAndCollectTerminal(downstream, {
          type: "response.create",
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        });

      expect(upstreamBodies[0]).toMatchObject({
        service_tier: "priority",
      });
      expect(requestLogs.at(-1)).toMatchObject({
        method: "WS",
        route: "/v1/responses",
        service_tier: "priority",
        status_code: 200,
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

  test("proxy auto-replays buffered REST requests after quota exhaustion and persists the new upstream", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
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

      const forwarded: Array<{ url: string; accountId: string | null; body: Record<string, unknown> }> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (url, init) => {
          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          forwarded.push({
            url: String(url),
            accountId,
            body,
          });
          if (accountId === "acct-alpha") {
            return jsonResponse({
              error: {
                codex_error_info: "usage_limit_exceeded",
                message: "You've hit your usage limit.",
              },
            }, 429);
          }
          return sseResponse([
            {
              type: "response.created",
              response: {
                id: "resp_retry_rest",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "msg_retry_rest",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "REST OK" }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_retry_rest",
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
        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
        };

        const responses = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false }),
        });
        expect(responses.status).toBe(200);
        expect(await responses.json()).toMatchObject({
          id: expect.stringMatching(/^resp_pxy_/u),
          output_text: "REST OK",
        });
        expect(forwarded.slice(-2).map((entry) => entry.accountId)).toEqual(["acct-alpha", "acct-beta"]);

        await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
        const chat = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "gpt-5.4",
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          }),
        });
        expect(chat.status).toBe(200);
        expect(await chat.json()).toMatchObject({
          choices: [{ message: { content: "REST OK" } }],
        });
        expect(forwarded.slice(-2).map((entry) => entry.accountId)).toEqual(["acct-alpha", "acct-beta"]);

        await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
        const completion = await fetch(`${server.baseUrl}/v1/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "gpt-5.4",
            prompt: "hello",
            stream: false,
          }),
        });
        expect(completion.status).toBe(200);
        expect(await completion.json()).toMatchObject({
          choices: [{ text: "REST OK" }],
        });
        expect(forwarded.slice(-2).map((entry) => entry.accountId)).toEqual(["acct-alpha", "acct-beta"]);
        expect((await readAuthSnapshotFile(join(homeDir, ".codex-team", "proxy", "last-direct-auth.json"))).tokens?.account_id)
          .toBe("acct-beta");
      } finally {
        await server.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy auto-replays buffered API-key REST requests after quota exhaustion", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot(
        "api-one",
        {
          auth_mode: "apikey",
          OPENAI_API_KEY: "sk-one",
        },
        {
          rawConfig: 'base_url = "https://api.example.test/v1"\nmodel_provider = "openai"\n',
        },
      );
      await store.addAccountSnapshot(
        "api-two",
        {
          auth_mode: "apikey",
          OPENAI_API_KEY: "sk-two",
        },
        {
          rawConfig: 'base_url = "https://api.example.test/v1"\nmodel_provider = "openai"\n',
        },
      );
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("api-one")).authPath);
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

      const authorizations: string[] = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          const authorization = new Headers(init?.headers).get("authorization") ?? "";
          authorizations.push(authorization);
          if (authorization === "Bearer sk-one") {
            return jsonResponse({
              error: {
                code: "insufficient_quota",
                message: "Insufficient quota.",
              },
            }, 429);
          }
          return jsonResponse({
            id: "chatcmpl_retry_api",
            object: "chat.completion",
            model: "gpt-4.1",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "API OK" },
                finish_reason: "stop",
              },
            ],
          });
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
            model: "gpt-4.1",
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          choices: [{ message: { content: "API OK" } }],
        });
        expect(authorizations).toEqual(["Bearer sk-one", "Bearer sk-two"]);
        expect((await readAuthSnapshotFile(join(homeDir, ".codex-team", "proxy", "last-direct-auth.json"))).OPENAI_API_KEY)
          .toBe("sk-two");
      } finally {
        await server.close();
      }
    } finally {
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
          id: expect.stringMatching(/^resp_pxy_/u),
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

  test("proxy restores persisted response checkpoints across restarts for previous_response_id fallback", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 5, one_week_used: 5 },
      );
      await writeQuotaMeta(
        (await store.getManagedAccount("beta")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 40, one_week_used: 40 },
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

      const firstForwarded: Array<Record<string, unknown>> = [];
      const firstServer = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          firstForwarded.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return sseResponse([
            {
              type: "response.created",
              response: {
                id: "resp_upstream_first",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "msg_first",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "one" }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_upstream_first",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
          ]);
        },
      });

      let firstResponseId: string | null = null;
      try {
        const syntheticAuth = createSyntheticProxyAuthSnapshot(new Date("2026-04-18T00:00:00.000Z"));
        const firstResponse = await fetch(`${firstServer.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false }),
        });
        expect(firstResponse.status).toBe(200);
        const firstPayload = await firstResponse.json() as { id?: string };
        firstResponseId = firstPayload.id ?? null;
        expect(firstResponseId).toMatch(/^resp_pxy_/u);
        expect(firstForwarded[0]?.input).toEqual([
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ]);
        expect(firstForwarded[0]?.previous_response_id).toBeUndefined();
      } finally {
        await firstServer.close();
      }

      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 100, one_week_used: 100 },
      );
      await writeQuotaMeta(
        (await store.getManagedAccount("beta")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 10, one_week_used: 10 },
      );
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("beta")).authPath);
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

      const secondForwarded: Array<{ accountId: string | null; body: Record<string, unknown> }> = [];
      const secondServer = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          secondForwarded.push({
            accountId: headers.get("chatgpt-account-id"),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          });
          return sseResponse([
            {
              type: "response.created",
              response: {
                id: "resp_upstream_second",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_upstream_second",
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
        const secondResponse = await fetch(`${secondServer.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${String(syntheticAuth.tokens?.access_token)}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            previous_response_id: firstResponseId,
            input: "next",
            stream: false,
          }),
        });
        expect(secondResponse.status).toBe(200);
        expect((await secondResponse.json() as { id?: string }).id).toMatch(/^resp_pxy_/u);
        expect(secondForwarded[0]?.accountId).toBe("acct-beta");
        expect(secondForwarded[0]?.body.previous_response_id).toBeUndefined();
        expect(secondForwarded[0]?.body.input).toEqual([
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "one" }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "next" }],
          },
        ]);
      } finally {
        await secondServer.close();
      }
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("proxy drops unknown upstream previous_response_id values instead of forwarding stale resp ids", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 5, one_week_used: 5 },
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

      const forwardedBodies: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        fetchImpl: async (_url, init) => {
          forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return sseResponse([
            {
              type: "response.created",
              response: {
                id: "resp_upstream_new",
                object: "response",
                model: "gpt-5.4",
                output: [],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_upstream_new",
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
            previous_response_id: "resp_0806f3fad3c9d9f10169ea492690808191b3455e39351f1842",
            input: "hello again",
            stream: false,
          }),
        });

        expect(response.status).toBe(200);
        expect((await response.json() as { id?: string }).id).toMatch(/^resp_pxy_/u);
        expect(forwardedBodies[0]?.previous_response_id).toBeUndefined();
        expect(forwardedBodies[0]?.input).toEqual([
          {
            role: "user",
            content: [{ type: "input_text", text: "hello again" }],
          },
        ]);
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

  test("proxy replays synthetic responses/compact requests after quota exhaustion", async () => {
    const { createSyntheticProxyAuthSnapshot } = await import("../src/proxy/synthetic-auth.js");
    const { startProxyServer } = await import("../src/proxy/server.js");
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("alpha", createAuthPayload("acct-alpha", "chatgpt", "plus", "user-alpha"));
      await store.addAccountSnapshot("beta", createAuthPayload("acct-beta", "chatgpt", "plus", "user-beta"));
      await writeQuotaMeta(
        (await store.getManagedAccount("alpha")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 100, one_week_used: 10 },
      );
      await writeQuotaMeta(
        (await store.getManagedAccount("beta")).metaPath,
        { status: "ok", plan_type: "plus", five_hour_used: 20, one_week_used: 10 },
      );
      await writeProxyManualUpstreamAuth(homeDir, (await store.getManagedAccount("alpha")).authPath);
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

      const forwarded: Array<{ accountId: string | null; body: Record<string, unknown> }> = [];
      const requestLogs: Array<Record<string, unknown>> = [];
      const server = await startProxyServer({
        store,
        host: "127.0.0.1",
        port: 0,
        requestLogger: async (payload) => {
          requestLogs.push(payload);
        },
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          forwarded.push({
            accountId,
            body,
          });
          if (accountId === "acct-alpha") {
            return jsonResponse({
              error: {
                codex_error_info: "usage_limit_exceeded",
                message: "You've hit your usage limit.",
              },
            }, 429);
          }
          return jsonResponse({
            id: "compact_retry",
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
          id: "compact_retry",
          object: "response.compact",
        });
        expect(forwarded.slice(-2).map((entry) => entry.accountId)).toEqual(["acct-alpha", "acct-beta"]);
        expect(forwarded.slice(-1)[0]?.body).toMatchObject({
          model: "gpt-5.4",
          response_id: "resp_123",
          compression: "auto",
        });
        expect(
          requestLogs.find((entry) => entry.route === "/v1/responses/compact" && entry.status_code === 200),
        ).toMatchObject({
          selected_account_name: "beta",
          replay_attempted: true,
          replay_count: 1,
          replay_skip_reason: null,
          replay_succeeded: true,
          replayed_from_account_names: ["alpha"],
        });
        expect((await readAuthSnapshotFile(join(homeDir, ".codex-team", "proxy", "last-direct-auth.json"))).tokens?.account_id)
          .toBe("acct-beta");
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

});
