import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createCodexDirectClient,
  type CodexDirectClient,
} from "../codex-direct-client.js";
import {
  createDefaultWebSocket,
  evaluateDevtoolsExpression,
  evaluateDevtoolsExpressionWithResult,
  resolveLocalDevtoolsTarget,
  type CreateWebSocketLike,
  type FetchLike,
} from "./devtools.js";
import {
  isManagedDesktopProcess,
  launchManagedDesktopProcess,
  pathExistsViaStat,
  readProcessParentAndCommand,
  type LaunchProcessLike,
} from "./process.js";
import {
  CODEX_APP_NAME,
  CODEX_APP_SERVER_RESTART_EXPRESSION,
  CODEX_BINARY_SUFFIX,
  DEFAULT_CODEX_DESKTOP_STATE_PATH,
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
  DEFAULT_WATCH_HEALTH_CHECK_INTERVAL_MS,
  DEFAULT_WATCH_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_WATCH_RECONNECT_DELAY_MS,
  DEVTOOLS_REQUEST_TIMEOUT_MS,
  DEVTOOLS_SWITCH_TIMEOUT_BUFFER_MS,
  delay,
  isRecord,
  toErrorMessage,
  waitForPromiseOrAbort,
} from "./shared.js";
import { ensureStateDirectory, parseManagedState } from "./state.js";
import {
  buildManagedCurrentAccountExpression,
  buildManagedCurrentQuotaExpression,
  buildManagedSwitchExpression,
  buildManagedWatchProbeExpression,
  extractProbeConsolePayload,
  extractRpcActivitySignal,
  extractRpcQuotaSignal,
  extractRuntimeConsoleText,
  formatBridgeDebugLine,
  normalizeBridgeProbePayload,
  normalizeRuntimeAccountSnapshot,
  normalizeRuntimeQuotaSnapshot,
} from "./runtime.js";
import type {
  CodexDesktopLauncher,
  ExecFileLike,
  ManagedQuotaSignal,
  ManagedWatchActivitySignal,
  ManagedWatchStatusEvent,
  ManagedCodexDesktopState,
  RunningCodexDesktop,
  RuntimeAccountSnapshot,
  RuntimeQuotaSnapshot,
  RuntimeReadResult,
} from "./types.js";
export type { CodexDirectClient } from "../codex-direct-client.js";
export type {
  CodexDesktopLauncher,
  ExecFileLike,
  ManagedCodexDesktopState,
  ManagedCurrentAccountSnapshot,
  ManagedCurrentQuotaSnapshot,
  ManagedQuotaSignal,
  ManagedWatchActivitySignal,
  ManagedWatchStatusEvent,
  RunningCodexDesktop,
  RuntimeAccountSnapshot,
  RuntimeQuotaSnapshot,
  RuntimeReadResult,
  RuntimeReadSource,
} from "./types.js";
export {
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
} from "./shared.js";

const execFile = promisify(execFileCallback);

export function createCodexDesktopLauncher(options: {
  execFileImpl?: ExecFileLike;
  statePath?: string;
  readFileImpl?: (path: string) => Promise<string>;
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  fetchImpl?: FetchLike;
  createWebSocketImpl?: CreateWebSocketLike;
  launchProcessImpl?: LaunchProcessLike;
  createDirectClientImpl?: () => Promise<CodexDirectClient>;
  watchReconnectDelayMs?: number;
  watchHealthCheckIntervalMs?: number;
  watchHealthCheckTimeoutMs?: number;
} = {}): CodexDesktopLauncher {
  const execFileImpl = options.execFileImpl ?? execFile;
  const statePath = options.statePath ?? DEFAULT_CODEX_DESKTOP_STATE_PATH;
  const readFileImpl = options.readFileImpl ?? (async (path: string) => readFile(path, "utf8"));
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const createWebSocketImpl = options.createWebSocketImpl ?? createDefaultWebSocket;
  const launchProcessImpl = options.launchProcessImpl ?? launchManagedDesktopProcess;
  const createDirectClientImpl = options.createDirectClientImpl ?? createCodexDirectClient;
  const watchReconnectDelayMs = options.watchReconnectDelayMs ?? DEFAULT_WATCH_RECONNECT_DELAY_MS;
  const watchHealthCheckIntervalMs =
    options.watchHealthCheckIntervalMs ?? DEFAULT_WATCH_HEALTH_CHECK_INTERVAL_MS;
  const watchHealthCheckTimeoutMs =
    options.watchHealthCheckTimeoutMs ?? DEFAULT_WATCH_HEALTH_CHECK_TIMEOUT_MS;

  async function findInstalledApp(): Promise<string | null> {
    const candidates = [
      "/Applications/Codex.app",
      join(homedir(), "Applications", "Codex.app"),
    ];

    for (const candidate of candidates) {
      if (await pathExistsViaStat(execFileImpl, candidate)) {
        return candidate;
      }
    }

    try {
      const { stdout } = await execFileImpl("mdfind", [
        'kMDItemFSName == "Codex.app"',
      ]);

      for (const line of stdout.split("\n")) {
        const candidate = line.trim();
        if (candidate === "") {
          continue;
        }

        if (await pathExistsViaStat(execFileImpl, candidate)) {
          return candidate;
        }
      }
    } catch {
      // Keep the lookup best-effort and fall back to null below.
    }

    return null;
  }

  async function listRunningApps(): Promise<RunningCodexDesktop[]> {
    const { stdout } = await execFileImpl("ps", ["-Ao", "pid=,command="]);
    const running: RunningCodexDesktop[] = [];

    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }

      const pid = Number(match[1]);
      const command = match[2];

      if (pid === process.pid || !command.includes(CODEX_BINARY_SUFFIX)) {
        continue;
      }

      running.push({ pid, command });
    }

    return running;
  }

  async function isRunningInsideDesktopShell(): Promise<boolean> {
    let currentPid = process.ppid;
    const visited = new Set<number>();

    while (currentPid > 1 && !visited.has(currentPid)) {
      visited.add(currentPid);
      const processInfo = await readProcessParentAndCommand(execFileImpl, currentPid);
      if (!processInfo) {
        return false;
      }

      if (processInfo.command.includes(CODEX_BINARY_SUFFIX)) {
        return true;
      }

      currentPid = processInfo.ppid;
    }

    return false;
  }

  async function quitRunningApps(options?: { force?: boolean }): Promise<void> {
    const running = await listRunningApps();
    if (running.length === 0) {
      return;
    }

    if (options?.force === true) {
      const pids = running.map((app) => String(app.pid));
      await execFileImpl("kill", ["-TERM", ...pids]);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const remaining = await listRunningApps();
        if (remaining.length === 0) {
          return;
        }

        await delay(300);
      }

      const remaining = await listRunningApps();
      if (remaining.length === 0) {
        return;
      }

      await execFileImpl("kill", ["-KILL", ...remaining.map((app) => String(app.pid))]);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const stillRunning = await listRunningApps();
        if (stillRunning.length === 0) {
          return;
        }

        await delay(100);
      }

      throw new Error("Timed out waiting for Codex Desktop to terminate.");
    }

    await execFileImpl("osascript", ["-e", `tell application "${CODEX_APP_NAME}" to quit`]);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const remaining = await listRunningApps();
      if (remaining.length === 0) {
        return;
      }

      await delay(300);
    }

    throw new Error("Timed out waiting for Codex Desktop to quit.");
  }

  async function launch(appPath: string): Promise<void> {
    const binaryPath = `${appPath}${CODEX_BINARY_SUFFIX}`;

    await launchProcessImpl({
      appPath,
      binaryPath,
      args: [`--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`],
    });
  }

  async function activateApp(appPath: string): Promise<void> {
    if (appPath.trim() === "") {
      throw new Error("App path is required to activate Codex Desktop.");
    }

    await execFileImpl("osascript", ["-e", `tell application "${CODEX_APP_NAME}" to activate`]);
  }

  async function readManagedState(): Promise<ManagedCodexDesktopState | null> {
    try {
      return parseManagedState(await readFileImpl(statePath));
    } catch {
      return null;
    }
  }

  async function writeManagedState(
    state: ManagedCodexDesktopState,
  ): Promise<void> {
    await ensureStateDirectory(statePath);
    await writeFileImpl(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async function clearManagedState(): Promise<void> {
    await ensureStateDirectory(statePath);
    await writeFileImpl(statePath, "");
  }

  async function isManagedDesktopRunning(): Promise<boolean> {
    const state = await readManagedState();
    if (!state) {
      return false;
    }

    const runningApps = await listRunningApps();
    return isManagedDesktopProcess(runningApps, state);
  }

  async function readDesktopRuntimeSnapshot<TSnapshot>(
    expression: string,
    normalize: (rawResult: unknown) => TSnapshot | null,
  ): Promise<TSnapshot | null> {
    const state = await readManagedState();
    if (!state) {
      return null;
    }

    const runningApps = await listRunningApps();
    if (!isManagedDesktopProcess(runningApps, state)) {
      return null;
    }

    const webSocketDebuggerUrl = await resolveLocalDevtoolsTarget(fetchImpl, state);
    const rawResult = await evaluateDevtoolsExpressionWithResult<unknown>(
      createWebSocketImpl,
      webSocketDebuggerUrl,
      expression,
      DEVTOOLS_REQUEST_TIMEOUT_MS,
    );

    return normalize(rawResult);
  }

  async function readDesktopRuntimeAccount(): Promise<RuntimeAccountSnapshot | null> {
    return await readDesktopRuntimeSnapshot(
      buildManagedCurrentAccountExpression(),
      normalizeRuntimeAccountSnapshot,
    );
  }

  async function readDesktopRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null> {
    return await readDesktopRuntimeSnapshot(
      buildManagedCurrentQuotaExpression(),
      normalizeRuntimeQuotaSnapshot,
    );
  }

  async function readDirectRuntimeSnapshot<TSnapshot>(options: {
    method: string;
    params: Record<string, unknown>;
    normalize: (rawResult: unknown) => TSnapshot | null;
  }): Promise<TSnapshot | null> {
    const directClient = await createDirectClientImpl();

    try {
      const rawResult = await directClient.request(options.method, options.params);
      return options.normalize(rawResult);
    } finally {
      await directClient.close();
    }
  }

  async function readDirectRuntimeAccount(): Promise<RuntimeAccountSnapshot | null> {
    return await readDirectRuntimeSnapshot({
      method: "account/read",
      params: {
        refreshToken: false,
      },
      normalize: normalizeRuntimeAccountSnapshot,
    });
  }

  async function readDirectRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null> {
    return await readDirectRuntimeSnapshot({
      method: "account/rateLimits/read",
      params: {},
      normalize: normalizeRuntimeQuotaSnapshot,
    });
  }

  async function readCurrentRuntimeSnapshotResult<TSnapshot>(options: {
    readDesktop: () => Promise<TSnapshot | null>;
    readDirect: () => Promise<TSnapshot | null>;
    desktopFailureMessage: string;
    directFailureMessage: string;
  }): Promise<RuntimeReadResult<TSnapshot> | null> {
    let desktopError: Error | null = null;

    try {
      const desktopSnapshot = await options.readDesktop();
      if (desktopSnapshot) {
        return {
          snapshot: desktopSnapshot,
          source: "desktop",
        };
      }
    } catch (error) {
      desktopError = toErrorMessage(error, options.desktopFailureMessage);
    }

    try {
      const directSnapshot = await options.readDirect();
      if (!directSnapshot) {
        return null;
      }

      return {
        snapshot: directSnapshot,
        source: "direct",
      };
    } catch (error) {
      const directError = toErrorMessage(error, options.directFailureMessage);
      if (!desktopError) {
        throw directError;
      }

      throw new Error(
        `${desktopError.message} Fallback direct runtime read failed: ${directError.message}`,
      );
    }
  }

  async function readCurrentRuntimeAccountResult(): Promise<RuntimeReadResult<RuntimeAccountSnapshot> | null> {
    return await readCurrentRuntimeSnapshotResult({
      readDesktop: readDesktopRuntimeAccount,
      readDirect: readDirectRuntimeAccount,
      desktopFailureMessage: "Failed to read the current Desktop runtime account.",
      directFailureMessage: "Failed to read the direct runtime account.",
    });
  }

  async function readCurrentRuntimeQuotaResult(): Promise<RuntimeReadResult<RuntimeQuotaSnapshot> | null> {
    return await readCurrentRuntimeSnapshotResult({
      readDesktop: readDesktopRuntimeQuota,
      readDirect: readDirectRuntimeQuota,
      desktopFailureMessage: "Failed to read the current Desktop runtime quota.",
      directFailureMessage: "Failed to read the direct runtime quota.",
    });
  }

  async function readCurrentRuntimeAccount(): Promise<RuntimeAccountSnapshot | null> {
    return (await readCurrentRuntimeAccountResult())?.snapshot ?? null;
  }

  async function readCurrentRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null> {
    return (await readCurrentRuntimeQuotaResult())?.snapshot ?? null;
  }

  async function readManagedCurrentAccount(): Promise<RuntimeAccountSnapshot | null> {
    return await readDesktopRuntimeAccount();
  }

  async function readManagedCurrentQuota(): Promise<RuntimeQuotaSnapshot | null> {
    return await readDesktopRuntimeQuota();
  }

  async function applyManagedSwitch(options?: {
    force?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const state = await readManagedState();
    if (!state) {
      return false;
    }

    const runningApps = await listRunningApps();
    if (!isManagedDesktopProcess(runningApps, state)) {
      return false;
    }

    const webSocketDebuggerUrl = await resolveLocalDevtoolsTarget(fetchImpl, state);

    const devtoolsTimeoutMs =
      options?.force === true
        ? DEVTOOLS_REQUEST_TIMEOUT_MS
        : Math.max(
            DEVTOOLS_REQUEST_TIMEOUT_MS,
            (options?.timeoutMs ?? DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS) +
              DEVTOOLS_SWITCH_TIMEOUT_BUFFER_MS,
          );

    await waitForPromiseOrAbort(
      evaluateDevtoolsExpression(
        createWebSocketImpl,
        webSocketDebuggerUrl,
        options?.force === true
          ? CODEX_APP_SERVER_RESTART_EXPRESSION
          : buildManagedSwitchExpression(options),
        devtoolsTimeoutMs,
      ),
      options?.signal,
    );
    return true;
  }

  async function watchManagedQuotaSignalsSession(sessionOptions: {
    signal?: AbortSignal;
    debugLogger?: (line: string) => void;
    onQuotaSignal?: (signal: ManagedQuotaSignal) => Promise<void> | void;
    onActivitySignal?: (signal: ManagedWatchActivitySignal) => Promise<void> | void;
    dedupeState: { lastFingerprint: string | null };
    onReady?: () => Promise<void> | void;
  }): Promise<void> {
    const state = await readManagedState();
    if (!state) {
      throw new Error("No codexm-managed Codex Desktop session is running.");
    }

    const runningApps = await listRunningApps();
    if (!isManagedDesktopProcess(runningApps, state)) {
      throw new Error("No codexm-managed Codex Desktop session is running.");
    }

    const webSocketDebuggerUrl = await resolveLocalDevtoolsTarget(fetchImpl, state);
    const socket = createWebSocketImpl(webSocketDebuggerUrl);
    const debugLogger = sessionOptions.debugLogger;
    const rpcRequestMethods = new Map<string, string>();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let closedByClient = false;
      let nextCommandId = 1;
      let healthCheckTimer: NodeJS.Timeout | null = null;
      let healthCheckTimeout: NodeJS.Timeout | null = null;
      let ready = false;
      const pendingCommands = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

      const clearHealthCheckTimers = () => {
        if (healthCheckTimer) {
          clearInterval(healthCheckTimer);
          healthCheckTimer = null;
        }
        if (healthCheckTimeout) {
          clearTimeout(healthCheckTimeout);
          healthCheckTimeout = null;
        }
      };

      const cleanup = () => {
        clearHealthCheckTimers();
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (sessionOptions.signal) {
          sessionOptions.signal.removeEventListener("abort", onAbort);
        }

        for (const pending of pendingCommands.values()) {
          pending.reject(new Error("Codex Desktop devtools watch stopped before completing a request."));
        }
        pendingCommands.clear();
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(toErrorMessage(error, "Codex Desktop devtools watch failed."));
      };

      const onAbort = () => {
        closedByClient = true;
        try {
          socket.close();
        } catch {
          // Ignore close failures while aborting the watch loop.
        }
        finish();
      };

      const sendCommand = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<unknown>((commandResolve, commandReject) => {
          const commandId = nextCommandId;
          nextCommandId += 1;
          pendingCommands.set(commandId, {
            resolve: commandResolve,
            reject: commandReject,
          });

          try {
            socket.send(
              JSON.stringify({
                id: commandId,
                method,
                params,
              }),
            );
          } catch (error) {
            pendingCommands.delete(commandId);
            commandReject(toErrorMessage(error, "Failed to send Codex Desktop devtools command."));
          }
        });

      const startHealthChecks = () => {
        if (watchHealthCheckIntervalMs <= 0 || watchHealthCheckTimeoutMs <= 0) {
          return;
        }

        healthCheckTimer = setInterval(() => {
          if (settled || !ready || healthCheckTimeout) {
            return;
          }

          let timeoutFired = false;
          healthCheckTimeout = setTimeout(() => {
            timeoutFired = true;
            healthCheckTimeout = null;
            try {
              socket.close();
            } catch {
              // Keep the timeout path best-effort before surfacing the failure.
            }
            fail(new Error("Codex Desktop devtools watch health check timed out."));
          }, watchHealthCheckTimeoutMs);

          void sendCommand("Runtime.evaluate", {
            expression: "void 0",
            returnByValue: true,
          }).then(
            () => {
              if (healthCheckTimeout) {
                clearTimeout(healthCheckTimeout);
                healthCheckTimeout = null;
              }
            },
            (error) => {
              if (timeoutFired) {
                return;
              }
              if (healthCheckTimeout) {
                clearTimeout(healthCheckTimeout);
                healthCheckTimeout = null;
              }
              fail(error);
            },
          );
        }, watchHealthCheckIntervalMs);
      };

      const emitQuotaSignal = async (signal: ManagedQuotaSignal) => {
        const fingerprint = JSON.stringify({
          url: signal.url,
          reason: signal.reason,
          shouldAutoSwitch: signal.shouldAutoSwitch,
          bodySnippet: signal.bodySnippet,
        });
        if (sessionOptions.dedupeState.lastFingerprint === fingerprint) {
          return;
        }
        sessionOptions.dedupeState.lastFingerprint = fingerprint;
        await sessionOptions.onQuotaSignal?.(signal);
      };

      socket.onopen = () => {
        void sendCommand("Runtime.enable")
          .then(() =>
            sendCommand("Runtime.evaluate", {
              expression: buildManagedWatchProbeExpression(),
              awaitPromise: true,
              returnByValue: true,
            }),
          )
          .then(async () => {
            ready = true;
            startHealthChecks();
            await sessionOptions.onReady?.();
          })
          .catch((error) => {
            fail(error);
          });
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!isRecord(payload)) {
          return;
        }

        if (typeof payload.id === "number") {
          const pending = pendingCommands.get(payload.id);
          if (!pending) {
            return;
          }
          pendingCommands.delete(payload.id);

          if (isRecord(payload.error)) {
            pending.reject(
              toErrorMessage(payload.error, "Codex Desktop devtools command failed."),
            );
            return;
          }

          pending.resolve(payload.result);
          return;
        }

        if (typeof payload.method !== "string") {
          return;
        }

        const params = isRecord(payload.params) ? payload.params : null;
        if (!params) {
          return;
        }

        if (payload.method === "Runtime.consoleAPICalled") {
          const runtimeMessage = extractRuntimeConsoleText(params);
          const probePayload = extractProbeConsolePayload(runtimeMessage);
          const bridgePayload = normalizeBridgeProbePayload(probePayload);
          if (bridgePayload) {
            debugLogger?.(formatBridgeDebugLine(bridgePayload));
          }

          const rpcQuotaSignal = extractRpcQuotaSignal(bridgePayload, rpcRequestMethods);
          if (rpcQuotaSignal) {
            void emitQuotaSignal(rpcQuotaSignal).catch((error) => {
              fail(error);
            });
          }

          const rpcActivitySignal = extractRpcActivitySignal(bridgePayload);
          if (rpcActivitySignal) {
            void Promise.resolve(sessionOptions.onActivitySignal?.(rpcActivitySignal)).catch(
              (error) => {
                fail(error);
              },
            );
          }
          return;
        }
      };

      socket.onerror = (event) => {
        fail(event);
      };

      socket.onclose = () => {
        if (closedByClient) {
          finish();
          return;
        }
        fail(new Error("Codex Desktop devtools watch connection closed unexpectedly."));
      };

      if (sessionOptions.signal) {
        if (sessionOptions.signal.aborted) {
          onAbort();
          return;
        }
        sessionOptions.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async function watchManagedQuotaSignals(options?: {
    signal?: AbortSignal;
    debugLogger?: (line: string) => void;
    onQuotaSignal?: (signal: ManagedQuotaSignal) => Promise<void> | void;
    onActivitySignal?: (signal: ManagedWatchActivitySignal) => Promise<void> | void;
    onStatus?: (event: ManagedWatchStatusEvent) => Promise<void> | void;
  }): Promise<void> {
    const dedupeState = { lastFingerprint: null as string | null };
    let reconnectAttempt = 0;

    while (true) {
      if (options?.signal?.aborted) {
        return;
      }

      try {
        await watchManagedQuotaSignalsSession({
          signal: options?.signal,
          debugLogger: options?.debugLogger,
          onQuotaSignal: options?.onQuotaSignal,
          onActivitySignal: options?.onActivitySignal,
          dedupeState,
          onReady: async () => {
            if (reconnectAttempt > 0) {
              await options?.onStatus?.({
                type: "reconnected",
                attempt: reconnectAttempt,
                error: null,
              });
              reconnectAttempt = 0;
            }
          },
        });
        return;
      } catch (error) {
        if (options?.signal?.aborted || (error as Error).name === "AbortError") {
          return;
        }

        reconnectAttempt += 1;
        await options?.onStatus?.({
          type: "disconnected",
          attempt: reconnectAttempt,
          error: (error as Error).message,
        });
        await delay(watchReconnectDelayMs);
      }
    }
  }

  return {
    findInstalledApp,
    listRunningApps,
    isRunningInsideDesktopShell,
    quitRunningApps,
    launch,
    activateApp,
    readManagedState,
    writeManagedState,
    clearManagedState,
    isManagedDesktopRunning,
    readDirectRuntimeAccount,
    readDirectRuntimeQuota,
    readCurrentRuntimeAccountResult,
    readCurrentRuntimeQuotaResult,
    readCurrentRuntimeAccount,
    readCurrentRuntimeQuota,
    readManagedCurrentAccount,
    readManagedCurrentQuota,
    applyManagedSwitch,
    watchManagedQuotaSignals,
  };
}
