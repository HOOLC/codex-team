import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const DEFAULT_CODEX_REMOTE_DEBUGGING_PORT = 9223;
const DEFAULT_CODEX_DESKTOP_STATE_PATH = join(
  homedir(),
  ".codex-team",
  "desktop-state.json",
);
const CODEX_BINARY_SUFFIX = "/Contents/MacOS/Codex";
const CODEX_APP_NAME = "Codex";
const CODEX_LOCAL_HOST_ID = "local";
export const DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS = 120_000;
const CODEX_APP_SERVER_RESTART_EXPRESSION =
  'window.electronBridge.sendMessageFromView({ type: "codex-app-server-restart", hostId: "local" })';
const DEVTOOLS_REQUEST_TIMEOUT_MS = 5_000;

export interface ExecFileLike {
  (
    file: string,
    args?: readonly string[],
  ): Promise<{ stdout: string; stderr: string }>;
}

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<FetchLikeResponse>;

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type CreateWebSocketLike = (url: string) => WebSocketLike;

export interface RunningCodexDesktop {
  pid: number;
  command: string;
}

export interface ManagedCodexDesktopState {
  pid: number;
  app_path: string;
  remote_debugging_port: number;
  managed_by_codexm: true;
  started_at: string;
}

export interface CodexDesktopLauncher {
  findInstalledApp(): Promise<string | null>;
  listRunningApps(): Promise<RunningCodexDesktop[]>;
  quitRunningApps(): Promise<void>;
  launch(appPath: string): Promise<void>;
  readManagedState(): Promise<ManagedCodexDesktopState | null>;
  writeManagedState(state: ManagedCodexDesktopState): Promise<void>;
  clearManagedState(): Promise<void>;
  isManagedDesktopRunning(): Promise<boolean>;
  applyManagedSwitch(options?: { force?: boolean; timeoutMs?: number }): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExistsViaStat(
  execFileImpl: ExecFileLike,
  path: string,
): Promise<boolean> {
  try {
    await execFileImpl("stat", ["-f", "%N", path]);
    return true;
  } catch {
    return false;
  }
}

function parseManagedState(raw: string): ManagedCodexDesktopState | null {
  if (raw.trim() === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const pid = parsed.pid;
  const appPath = parsed.app_path;
  const remoteDebuggingPort = parsed.remote_debugging_port;
  const managedByCodexm = parsed.managed_by_codexm;
  const startedAt = parsed.started_at;

  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !isNonEmptyString(appPath) ||
    typeof remoteDebuggingPort !== "number" ||
    !Number.isInteger(remoteDebuggingPort) ||
    remoteDebuggingPort <= 0 ||
    managedByCodexm !== true ||
    !isNonEmptyString(startedAt)
  ) {
    return null;
  }

  return {
    pid,
    app_path: appPath,
    remote_debugging_port: remoteDebuggingPort,
    managed_by_codexm: true,
    started_at: startedAt,
  };
}

async function ensureStateDirectory(statePath: string): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
}

function createDefaultWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function isDevtoolsTarget(value: unknown): value is {
  type?: unknown;
  url?: unknown;
  webSocketDebuggerUrl?: unknown;
} {
  return isRecord(value);
}

function isManagedDesktopProcess(
  runningApps: RunningCodexDesktop[],
  state: ManagedCodexDesktopState,
): boolean {
  const expectedBinaryPath = `${state.app_path}${CODEX_BINARY_SUFFIX}`;
  const expectedPort = `--remote-debugging-port=${state.remote_debugging_port}`;

  return runningApps.some(
    (entry) =>
      entry.pid === state.pid &&
      entry.command.includes(expectedBinaryPath) &&
      entry.command.includes(expectedPort),
  );
}

async function evaluateDevtoolsExpression(
  createWebSocketImpl: CreateWebSocketLike,
  webSocketDebuggerUrl: string,
  expression: string,
): Promise<void> {
  const socket = createWebSocketImpl(webSocketDebuggerUrl);

  await new Promise<void>((resolve, reject) => {
    const requestId = 1;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Codex Desktop devtools response."));
    }, DEVTOOLS_REQUEST_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    };

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
          },
        }),
      );
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

      if (!isRecord(payload) || payload.id !== requestId) {
        return;
      }

      if (isRecord(payload.error)) {
        cleanup();
        reject(new Error(String(payload.error.message ?? "Codex Desktop devtools request failed.")));
        return;
      }

      const result = isRecord(payload.result) ? payload.result : null;
      if (result && isRecord(result.exceptionDetails)) {
        cleanup();
        reject(new Error("Codex Desktop rejected the app-server restart request."));
        return;
      }

      cleanup();
      resolve();
    };

    socket.onerror = () => {
      cleanup();
      reject(new Error("Failed to communicate with Codex Desktop devtools."));
    };

    socket.onclose = () => {
      cleanup();
      reject(new Error("Codex Desktop devtools connection closed before replying."));
    };
  });
}

function buildManagedSwitchExpression(options?: {
  force?: boolean;
  timeoutMs?: number;
}): string {
  const force = options?.force === true;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS;

  return `(async () => {
  const hostId = ${JSON.stringify(CODEX_LOCAL_HOST_ID)};
  const force = ${JSON.stringify(force)};
  const timeoutMs = ${JSON.stringify(timeoutMs)};
  const requestTimeoutMs = 5000;
  let requestCounter = 0;

  const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const toError = (value, fallback) => {
    if (value instanceof Error) {
      return value;
    }

    const message =
      typeof value === "string"
        ? value
        : isRecord(value) && typeof value.message === "string"
          ? value.message
          : fallback;
    return new Error(message);
  };

  const postMessage = async (message) => {
    if (!window.electronBridge || typeof window.electronBridge.sendMessageFromView !== "function") {
      throw new Error("Codex Desktop bridge is unavailable.");
    }

    await window.electronBridge.sendMessageFromView(message);
  };

  const extractResponse = (data) => {
    if (!isRecord(data) || data.type !== "mcp-response") {
      return null;
    }

    if (isRecord(data.response)) {
      return data.response;
    }

    if (isRecord(data.result)) {
      return data.result;
    }

    return null;
  };

  const extractNotification = (data) => {
    if (isRecord(data) && data.type === "mcp-notification") {
      if (isRecord(data.notification)) {
        return data.notification;
      }

      if (isRecord(data.request)) {
        return data.request;
      }
    }

    if (isRecord(data) && typeof data.method === "string") {
      return data;
    }

    return null;
  };

  const request = async (method, params) => {
    const id = \`codexm-managed-switch-\${Date.now()}-\${++requestCounter}\`;

    return await new Promise(async (resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error(\`Timed out waiting for \${method}.\`));
      }, requestTimeoutMs);

      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };

      const onMessage = (event) => {
        const response = extractResponse(event.data);
        if (!isRecord(response) || String(response.id) !== id) {
          return;
        }

        cleanup();

        if (isRecord(response.error)) {
          reject(
            new Error(
              typeof response.error.message === "string"
                ? response.error.message
                : \`\${method} failed.\`,
            ),
          );
          return;
        }

        resolve(isRecord(response.result) ? response.result : {});
      };

      window.addEventListener("message", onMessage);

      try {
        await postMessage({
          type: "mcp-request",
          hostId,
          request: params === undefined ? { id, method } : { id, method, params },
        });
      } catch (error) {
        cleanup();
        reject(toError(error, \`\${method} failed.\`));
      }
    });
  };

  const restart = async () => {
    await postMessage({
      type: "codex-app-server-restart",
      hostId,
    });
  };

  const isActiveStatus = (status) => isRecord(status) && status.type === "active";

  const listActiveLoadedThreadIds = async () => {
    const loadedResult = await request("thread/loaded/list");
    const loadedThreadIds = Array.isArray(loadedResult.data)
      ? loadedResult.data.filter((value) => typeof value === "string" && value.length > 0)
      : [];

    const activeThreadIds = [];
    for (const threadId of loadedThreadIds) {
      const threadResult = await request("thread/read", { threadId });
      const thread = isRecord(threadResult.thread) ? threadResult.thread : null;
      const status = thread && isRecord(thread.status) ? thread.status : null;

      if (isActiveStatus(status)) {
        activeThreadIds.push(threadId);
      }
    }

    return activeThreadIds;
  };

  if (force) {
    await restart();
    return { mode: "force" };
  }

  let activeThreadIds = await listActiveLoadedThreadIds();
  if (activeThreadIds.length === 0) {
    await restart();
    return { mode: "immediate" };
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;

    const cleanup = () => {
      window.clearTimeout(timeoutHandle);
      window.removeEventListener("message", onMessage);
    };

    const finishWithError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const finishWithRestart = async () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      try {
        await restart();
        resolve(undefined);
      } catch (error) {
        reject(toError(error, "Failed to restart the Codex app server."));
      }
    };

    const maybeRestart = async () => {
      if (settled || checking) {
        return;
      }

      checking = true;
      try {
        activeThreadIds = await listActiveLoadedThreadIds();
        if (activeThreadIds.length === 0) {
          await finishWithRestart();
        }
      } catch (error) {
        finishWithError(toError(error, "Failed to refresh active thread state."));
      } finally {
        checking = false;
      }
    };

    const timeoutHandle = window.setTimeout(() => {
      finishWithError(
        new Error("Timed out waiting for the current Codex thread to finish."),
      );
    }, timeoutMs);

    const onMessage = (event) => {
      const notification = extractNotification(event.data);
      if (!isRecord(notification) || typeof notification.method !== "string") {
        return;
      }

      const params = isRecord(notification.params) ? notification.params : null;
      const threadId = params && typeof params.threadId === "string" ? params.threadId : null;
      if (threadId && !activeThreadIds.includes(threadId)) {
        return;
      }

      if (notification.method === "thread/status/changed") {
        const status = params && isRecord(params.status) ? params.status : null;
        if (!isActiveStatus(status)) {
          void maybeRestart();
        }
        return;
      }

      if (notification.method === "turn/completed") {
        void maybeRestart();
      }
    };

    window.addEventListener("message", onMessage);
  });

  return { mode: "waited" };
})()`;
}

export function createCodexDesktopLauncher(options: {
  execFileImpl?: ExecFileLike;
  statePath?: string;
  readFileImpl?: (path: string) => Promise<string>;
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  fetchImpl?: FetchLike;
  createWebSocketImpl?: CreateWebSocketLike;
} = {}): CodexDesktopLauncher {
  const execFileImpl = options.execFileImpl ?? execFile;
  const statePath = options.statePath ?? DEFAULT_CODEX_DESKTOP_STATE_PATH;
  const readFileImpl = options.readFileImpl ?? (async (path: string) => readFile(path, "utf8"));
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const createWebSocketImpl = options.createWebSocketImpl ?? createDefaultWebSocket;

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

  async function quitRunningApps(): Promise<void> {
    const running = await listRunningApps();
    if (running.length === 0) {
      return;
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
    await execFileImpl("open", [
      "-na",
      appPath,
      "--args",
      `--remote-debugging-port=${DEFAULT_CODEX_REMOTE_DEBUGGING_PORT}`,
    ]);
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

  async function applyManagedSwitch(options?: {
    force?: boolean;
    timeoutMs?: number;
  }): Promise<boolean> {
    const state = await readManagedState();
    if (!state) {
      return false;
    }

    const runningApps = await listRunningApps();
    if (!isManagedDesktopProcess(runningApps, state)) {
      return false;
    }

    const response = await fetchImpl(
      `http://127.0.0.1:${state.remote_debugging_port}/json/list`,
    );
    if (!response.ok) {
      throw new Error(
        `Failed to query Codex Desktop devtools targets (HTTP ${response.status}).`,
      );
    }

    const targets = await response.json();
    if (!Array.isArray(targets)) {
      throw new Error("Codex Desktop devtools target list was not an array.");
    }

    const localTarget = targets.find((target) => {
      if (!isDevtoolsTarget(target)) {
        return false;
      }

      return (
        target.type === "page" &&
        target.url === `app://-/index.html?hostId=${CODEX_LOCAL_HOST_ID}` &&
        isNonEmptyString(target.webSocketDebuggerUrl)
      );
    });

    if (!localTarget || !isNonEmptyString(localTarget.webSocketDebuggerUrl)) {
      throw new Error("Could not find the local Codex Desktop devtools target.");
    }

    await evaluateDevtoolsExpression(
      createWebSocketImpl,
      localTarget.webSocketDebuggerUrl,
      options?.force === true
        ? CODEX_APP_SERVER_RESTART_EXPRESSION
        : buildManagedSwitchExpression(options),
    );
    return true;
  }

  return {
    findInstalledApp,
    listRunningApps,
    quitRunningApps,
    launch,
    readManagedState,
    writeManagedState,
    clearManagedState,
    isManagedDesktopRunning,
    applyManagedSwitch,
  };
}
