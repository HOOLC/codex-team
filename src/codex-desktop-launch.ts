import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  createCodexDirectClient,
  type CodexDirectClient,
} from "./codex-direct-client.js";
export type { CodexDirectClient } from "./codex-direct-client.js";

const execFile = promisify(execFileCallback);

export const DEFAULT_CODEX_REMOTE_DEBUGGING_PORT = 39223;
const DEFAULT_CODEX_DESKTOP_STATE_PATH = join(
  homedir(),
  ".codex-team",
  "desktop-state.json",
);
const CODEX_BINARY_SUFFIX = "/Contents/MacOS/Codex";
const CODEX_APP_NAME = "Codex";
const CODEX_LOCAL_HOST_ID = "local";
export const DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS = 120_000;
const CODEXM_WATCH_CONSOLE_PREFIX = "__codexm_watch__";
const DEVTOOLS_REQUEST_TIMEOUT_MS = 5_000;
const DEVTOOLS_SWITCH_TIMEOUT_BUFFER_MS = 10_000;
const DEFAULT_WATCH_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_WATCH_HEALTH_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_HEALTH_CHECK_TIMEOUT_MS = 3_000;

function buildCodexDesktopGuardExpression(): string {
  return `
  const expectedHref = ${JSON.stringify(`app://-/index.html?hostId=${CODEX_LOCAL_HOST_ID}`)};
  const actualHref =
    typeof window !== "undefined" &&
    window.location &&
    typeof window.location.href === "string"
      ? window.location.href
      : null;
  const hasBridge =
    typeof window !== "undefined" &&
    !!window.electronBridge &&
    typeof window.electronBridge.sendMessageFromView === "function";

  if (actualHref !== expectedHref || !hasBridge) {
    throw new Error("Connected debug console target is not Codex Desktop.");
  }
`;
}

const CODEX_APP_SERVER_RESTART_EXPRESSION = `(async () => {${buildCodexDesktopGuardExpression()}
  await window.electronBridge.sendMessageFromView({ type: "codex-app-server-restart", hostId: "local" });
})()`;

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
type LaunchProcessLike = (options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
}) => Promise<void>;

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

export interface ManagedQuotaSignal {
  requestId: string;
  url: string;
  status: number | null;
  reason: "rpc_response" | "rpc_notification";
  bodySnippet: string | null;
  shouldAutoSwitch: boolean;
  quota: RuntimeQuotaSnapshot | null;
}

export interface ManagedWatchActivitySignal {
  requestId: string;
  method: string;
  reason: "quota_dirty" | "turn_completed";
  bodySnippet: string | null;
}

export interface ManagedWatchStatusEvent {
  type: "disconnected" | "reconnected";
  attempt: number;
  error: string | null;
}

export interface RuntimeQuotaSnapshot {
  plan_type: string | null;
  credits_balance: number | null;
  unlimited: boolean;
  five_hour: {
    used_percent: number;
    window_seconds: number;
    reset_at: string | null;
  } | null;
  one_week: {
    used_percent: number;
    window_seconds: number;
    reset_at: string | null;
  } | null;
  fetched_at: string;
}

export interface RuntimeAccountSnapshot {
  auth_mode: string | null;
  email: string | null;
  plan_type: string | null;
  requires_openai_auth: boolean | null;
}

export type RuntimeReadSource = "desktop" | "direct";

export interface RuntimeReadResult<TSnapshot> {
  snapshot: TSnapshot;
  source: RuntimeReadSource;
}

export type ManagedCurrentQuotaSnapshot = RuntimeQuotaSnapshot;
export type ManagedCurrentAccountSnapshot = RuntimeAccountSnapshot;

export interface CodexDesktopLauncher {
  findInstalledApp(): Promise<string | null>;
  listRunningApps(): Promise<RunningCodexDesktop[]>;
  isRunningInsideDesktopShell(): Promise<boolean>;
  quitRunningApps(options?: { force?: boolean }): Promise<void>;
  launch(appPath: string): Promise<void>;
  readManagedState(): Promise<ManagedCodexDesktopState | null>;
  writeManagedState(state: ManagedCodexDesktopState): Promise<void>;
  clearManagedState(): Promise<void>;
  isManagedDesktopRunning(): Promise<boolean>;
  readDirectRuntimeAccount(): Promise<RuntimeAccountSnapshot | null>;
  readDirectRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null>;
  readCurrentRuntimeAccountResult(): Promise<RuntimeReadResult<RuntimeAccountSnapshot> | null>;
  readCurrentRuntimeQuotaResult(): Promise<RuntimeReadResult<RuntimeQuotaSnapshot> | null>;
  readCurrentRuntimeAccount(): Promise<RuntimeAccountSnapshot | null>;
  readCurrentRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null>;
  readManagedCurrentAccount(): Promise<RuntimeAccountSnapshot | null>;
  readManagedCurrentQuota(): Promise<RuntimeQuotaSnapshot | null>;
  applyManagedSwitch(options?: {
    force?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean>;
  watchManagedQuotaSignals(options?: {
    signal?: AbortSignal;
    debugLogger?: (line: string) => void;
    onQuotaSignal?: (signal: ManagedQuotaSignal) => Promise<void> | void;
    onActivitySignal?: (signal: ManagedWatchActivitySignal) => Promise<void> | void;
    onStatus?: (event: ManagedWatchStatusEvent) => Promise<void> | void;
  }): Promise<void>;
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

function createAbortError(): Error {
  const error = new Error("Managed Codex Desktop refresh was interrupted.");
  error.name = "AbortError";
  return error;
}

async function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return await promise;
  }

  if (signal.aborted) {
    throw createAbortError();
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
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

async function readProcessParentAndCommand(
  execFileImpl: ExecFileLike,
  pid: number,
): Promise<{ ppid: number; command: string } | null> {
  try {
    const { stdout } = await execFileImpl("ps", ["-o", "ppid=,command=", "-p", String(pid)]);
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry !== "");
    if (!line) {
      return null;
    }

    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      return null;
    }

    return {
      ppid: Number(match[1]),
      command: match[2],
    };
  } catch {
    return null;
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

function toErrorMessage(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }

  if (isRecord(value) && typeof value.message === "string") {
    return new Error(value.message);
  }

  if (typeof value === "string" && value.trim() !== "") {
    return new Error(value);
  }

  return new Error(fallback);
}

async function launchManagedDesktopProcess(options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnCallback(options.binaryPath, [...options.args], {
      cwd: options.appPath,
      detached: true,
      stdio: "ignore",
    });

    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    child.once("error", (error) => {
      settle(() => reject(error));
    });

    child.once("spawn", () => {
      child.unref();
      settle(resolve);
    });
  });
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

async function resolveLocalDevtoolsTarget(
  fetchImpl: FetchLike,
  state: ManagedCodexDesktopState,
): Promise<string> {
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
    throw new Error("Current debug port is not connected to Codex Desktop.");
  }

  return localTarget.webSocketDebuggerUrl;
}

function extractDevtoolsExceptionMessage(result: Record<string, unknown> | null): string | null {
  if (!result || !isRecord(result.exceptionDetails)) {
    return null;
  }

  const exceptionDetails = result.exceptionDetails;
  const exception = isRecord(exceptionDetails.exception) ? exceptionDetails.exception : null;
  const description =
    typeof exception?.description === "string" && exception.description.trim() !== ""
      ? exception.description.trim()
      : typeof exception?.value === "string" && exception.value.trim() !== ""
        ? exception.value.trim()
        : typeof exceptionDetails.text === "string" && exceptionDetails.text.trim() !== ""
          ? exceptionDetails.text.trim()
          : null;

  if (!description) {
    return null;
  }

  const firstLine = description.split("\n")[0]?.trim() ?? description;
  return firstLine || null;
}

function normalizeBodySnippet(body: string | null): string | null {
  if (!body) {
    return null;
  }

  return body.slice(0, 2_000);
}

function hasStructuredQuotaError(value: unknown, depth = 0): boolean {
  if (depth > 8) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasStructuredQuotaError(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.codexErrorInfo === "usageLimitExceeded") {
    return true;
  }

  const exactErrorCodeCandidates = [
    value.code,
    value.errorCode,
    value.error_code,
    value.type,
  ];
  if (exactErrorCodeCandidates.some((entry) => entry === "insufficient_quota")) {
    return true;
  }

  return Object.values(value).some((entry) => hasStructuredQuotaError(entry, depth + 1));
}

function buildManagedWatchProbeExpression(): string {
  return `(() => {
  ${buildCodexDesktopGuardExpression()}
  const prefix = ${JSON.stringify(CODEXM_WATCH_CONSOLE_PREFIX)};
  const globalState = window.__codexmWatchState ?? { installed: false };

  if (globalState.installed) {
    return { installed: true };
  }

  globalState.installed = true;
  window.__codexmWatchState = globalState;

  const emitBridge = (direction, event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (!type.startsWith("mcp-")) {
      return;
    }
    console.debug(prefix + JSON.stringify({ kind: "bridge", direction, event }));
  };
  window.addEventListener("codex-message-from-view", (event) => {
    emitBridge("from_view", event.detail);
  });
  window.addEventListener("message", (event) => {
    emitBridge("for_view", event.data);
  });

  return { installed: true };
})()`;
}

function buildManagedCurrentQuotaExpression(): string {
  return `(async () => {
  ${buildCodexDesktopGuardExpression()}
  const hostId = ${JSON.stringify(CODEX_LOCAL_HOST_ID)};
  const rpcTimeoutMs = 5000;

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

  const pendingResponses = new Map();
  let nextRequestId = 1;

  const onMessage = (event) => {
    const data = event?.data;
    if (!isRecord(data) || data.type !== "mcp-response" || !isRecord(data.message)) {
      return;
    }

    const responseId =
      typeof data.message.id === "string" || typeof data.message.id === "number"
        ? String(data.message.id)
        : null;
    if (!responseId) {
      return;
    }

    const pending = pendingResponses.get(responseId);
    if (!pending) {
      return;
    }

    pendingResponses.delete(responseId);
    window.clearTimeout(pending.timeoutHandle);

    if (isRecord(data.message.error)) {
      pending.reject(toError(data.message.error, "Codex Desktop bridge request failed."));
      return;
    }

    pending.resolve(data.message.result);
  };

  window.addEventListener("message", onMessage);

  const sendRpcRequest = async (method, params = {}) => {
    const requestId = "codexm-current-" + String(nextRequestId++);

    return await new Promise((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        pendingResponses.delete(requestId);
        reject(new Error("Timed out waiting for Codex Desktop bridge response."));
      }, rpcTimeoutMs);

      pendingResponses.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });

      void postMessage({
        type: "mcp-request",
        hostId,
        request: {
          id: requestId,
          method,
          params,
        },
      }).catch((error) => {
        pendingResponses.delete(requestId);
        window.clearTimeout(timeoutHandle);
        reject(toError(error, "Failed to send Codex Desktop bridge request."));
      });
    });
  };

  try {
    const result = await sendRpcRequest("account/rateLimits/read", {});
    return isRecord(result) ? result : null;
  } finally {
    for (const pending of pendingResponses.values()) {
      window.clearTimeout(pending.timeoutHandle);
    }
    pendingResponses.clear();
    window.removeEventListener("message", onMessage);
  }
})()`;
}

function buildManagedCurrentAccountExpression(): string {
  return `(async () => {
  ${buildCodexDesktopGuardExpression()}
  const hostId = ${JSON.stringify(CODEX_LOCAL_HOST_ID)};
  const rpcTimeoutMs = ${DEVTOOLS_REQUEST_TIMEOUT_MS};
  const pendingResponses = new Map();
  let nextRequestId = 1;

  const toError = (value, fallback) => {
    if (value instanceof Error) {
      return value;
    }
    if (value && typeof value === "object" && typeof value.message === "string") {
      return new Error(value.message);
    }
    if (typeof value === "string" && value.trim() !== "") {
      return new Error(value);
    }
    return new Error(fallback);
  };

  const postMessage = async (message) => {
    if (
      typeof window === "undefined" ||
      !window.electronBridge ||
      typeof window.electronBridge.sendMessageFromView !== "function"
    ) {
      throw new Error("Codex Desktop bridge is unavailable.");
    }

    return await window.electronBridge.sendMessageFromView(message);
  };

  const onMessage = (event) => {
    const data = event && typeof event === "object" ? event.data : null;
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.hostId !== hostId) {
      return;
    }

    if (data.type === "mcp-response" && data.message && typeof data.message.id === "string") {
      const pending = pendingResponses.get(data.message.id);
      if (!pending) {
        return;
      }

      pendingResponses.delete(data.message.id);
      window.clearTimeout(pending.timeoutHandle);

      if (data.message.error) {
        pending.reject(toError(data.message.error, "Codex Desktop bridge request failed."));
        return;
      }

      pending.resolve(data.message.result);
    }
  };

  window.addEventListener("message", onMessage);

  const sendRpcRequest = async (method, params = {}) => {
    const requestId = "codexm-current-account-" + String(nextRequestId++);

    return await new Promise((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        pendingResponses.delete(requestId);
        reject(new Error("Timed out waiting for Codex Desktop bridge response."));
      }, rpcTimeoutMs);

      pendingResponses.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });

      void postMessage({
        type: "mcp-request",
        hostId,
        request: {
          id: requestId,
          method,
          params,
        },
      }).catch((error) => {
        pendingResponses.delete(requestId);
        window.clearTimeout(timeoutHandle);
        reject(toError(error, "Failed to send Codex Desktop bridge request."));
      });
    });
  };

  try {
    const result = await sendRpcRequest("account/read", { refreshToken: false });
    return result && typeof result === "object" ? result : null;
  } finally {
    for (const pending of pendingResponses.values()) {
      window.clearTimeout(pending.timeoutHandle);
    }
    pendingResponses.clear();
    window.removeEventListener("message", onMessage);
  }
})()`;
}

function epochSecondsToIsoString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function normalizeManagedQuotaWindow(
  value: unknown,
  fallbackWindowSeconds: number,
): RuntimeQuotaSnapshot["five_hour"] {
  if (!isRecord(value) || typeof value.usedPercent !== "number") {
    return null;
  }

  const windowDurationMins =
    typeof value.windowDurationMins === "number" && Number.isFinite(value.windowDurationMins)
      ? value.windowDurationMins
      : null;

  return {
    used_percent: value.usedPercent,
    window_seconds: windowDurationMins === null ? fallbackWindowSeconds : windowDurationMins * 60,
    reset_at: epochSecondsToIsoString(value.resetsAt),
  };
}

function normalizeRuntimeQuotaSnapshot(value: unknown): RuntimeQuotaSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const rateLimits = isRecord(value.rateLimits) ? value.rateLimits : null;
  if (!rateLimits) {
    return null;
  }

  const credits = isRecord(rateLimits.credits) ? rateLimits.credits : null;
  const balanceValue = credits?.balance;
  const creditsBalance =
    typeof balanceValue === "string" && balanceValue.trim() !== ""
      ? Number(balanceValue)
      : typeof balanceValue === "number"
        ? balanceValue
        : null;

  return {
    plan_type: typeof rateLimits.planType === "string" ? rateLimits.planType : null,
    credits_balance: Number.isFinite(creditsBalance) ? creditsBalance : null,
    unlimited: credits?.unlimited === true,
    five_hour: normalizeManagedQuotaWindow(rateLimits.primary ?? rateLimits.primaryWindow, 18_000),
    one_week: normalizeManagedQuotaWindow(
      rateLimits.secondary ?? rateLimits.secondaryWindow,
      604_800,
    ),
    fetched_at: new Date().toISOString(),
  };
}

function normalizeRuntimeAccountSnapshot(value: unknown): RuntimeAccountSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const account = isRecord(value.account) ? value.account : null;
  const accountType = account?.type;
  const authMode =
    accountType === "apiKey"
      ? "apikey"
      : accountType === "chatgpt"
        ? "chatgpt"
        : null;

  return {
    auth_mode: authMode,
    email: typeof account?.email === "string" ? account.email : null,
    plan_type: typeof account?.planType === "string" ? account.planType : null,
    requires_openai_auth:
      typeof value.requiresOpenaiAuth === "boolean" ? value.requiresOpenaiAuth : null,
  };
}

interface ProbeConsolePayload {
  kind?: unknown;
  message?: unknown;
  event?: unknown;
  direction?: unknown;
}

interface BridgeProbePayload {
  kind: "bridge";
  direction: string | null;
  event: Record<string, unknown>;
}

function extractRuntimeConsoleText(payload: Record<string, unknown>): string | null {
  const args = Array.isArray(payload.args) ? payload.args : [];
  const parts = args
    .map((arg) => {
      if (!isRecord(arg)) {
        return null;
      }

      if (typeof arg.value === "string") {
        return arg.value;
      }
      if (typeof arg.unserializableValue === "string") {
        return arg.unserializableValue;
      }
      if (typeof arg.description === "string") {
        return arg.description;
      }

      return null;
    })
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");

  if (parts.length === 0) {
    return null;
  }

  return parts.join(" ");
}

function extractProbeConsolePayload(message: string | null): ProbeConsolePayload | null {
  if (!message || !message.startsWith(CODEXM_WATCH_CONSOLE_PREFIX)) {
    return null;
  }

  const rawPayload = message.slice(CODEXM_WATCH_CONSOLE_PREFIX.length);
  try {
    const parsed = JSON.parse(rawPayload) as ProbeConsolePayload;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeBridgeProbePayload(payload: ProbeConsolePayload | null): BridgeProbePayload | null {
  if (payload?.kind !== "bridge" || !isRecord(payload.event)) {
    return null;
  }

  return {
    kind: "bridge",
    direction: typeof payload.direction === "string" ? payload.direction : null,
    event: payload.event,
  };
}

function formatBridgeDebugLine(payload: BridgeProbePayload): string {
  return JSON.stringify({
    method: "Bridge.message",
    params: {
      direction: payload.direction,
      event: payload.event,
    },
  });
}

function stringifySnippet(value: unknown): string | null {
  try {
    return normalizeBodySnippet(JSON.stringify(value));
  } catch {
    return null;
  }
}

function hasExhaustedRateLimit(value: unknown, depth = 0): boolean {
  if (depth > 8) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasExhaustedRateLimit(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return false;
  }

  const usedPercent = value.usedPercent ?? value.used_percent;
  if (typeof usedPercent === "number" && usedPercent >= 100) {
    return true;
  }

  return Object.values(value).some((entry) => hasExhaustedRateLimit(entry, depth + 1));
}

function buildRpcQuotaSignal(options: {
  event: Record<string, unknown>;
  requestId: string;
  method: string | null;
  reason: "rpc_response" | "rpc_notification";
  shouldAutoSwitch: boolean;
  quota: RuntimeQuotaSnapshot | null;
}): ManagedQuotaSignal {
  return {
    requestId: options.requestId,
    url: options.method ? `mcp:${options.method}` : "mcp",
    status: null,
    reason: options.reason,
    bodySnippet: stringifySnippet(options.event),
    shouldAutoSwitch: options.shouldAutoSwitch,
    quota: options.quota,
  };
}

function extractRpcQuotaSignal(
  payload: BridgeProbePayload | null,
  rpcRequestMethods: Map<string, string>,
): ManagedQuotaSignal | null {
  if (!payload) {
    return null;
  }

  const event = payload.event;
  const eventType = typeof event.type === "string" ? event.type : null;
  if (!eventType?.startsWith("mcp-")) {
    return null;
  }

  if (eventType === "mcp-request") {
    const request = isRecord(event.request) ? event.request : null;
    const requestId =
      typeof request?.id === "string" || typeof request?.id === "number"
        ? String(request.id)
        : null;
    const method = typeof request?.method === "string" ? request.method : null;
    if (requestId && method) {
      rpcRequestMethods.set(requestId, method);
    }
    return null;
  }

  if (eventType === "mcp-notification") {
    const method = typeof event.method === "string" ? event.method : null;
    if (method === "account/rateLimits/updated") {
      return null;
    }
    if (
      method === "error" && hasStructuredQuotaError(event.params)
    ) {
      return buildRpcQuotaSignal({
        event,
        requestId: `rpc:notification:${method ?? "unknown"}`,
        method,
        reason: "rpc_notification",
        shouldAutoSwitch: true,
        quota: null,
      });
    }
    return null;
  }

  if (eventType !== "mcp-response") {
    return null;
  }

  const message = isRecord(event.message) ? event.message : null;
  const responseId =
    typeof message?.id === "string" || typeof message?.id === "number"
      ? String(message.id)
      : "unknown";
  const method = rpcRequestMethods.get(responseId) ?? null;
  if (method === "account/rateLimits/read" && isRecord(message?.result)) {
    if (responseId.startsWith("codexm-current-")) {
      return null;
    }

    return buildRpcQuotaSignal({
      event,
      requestId: `rpc:${responseId}`,
      method,
      reason: "rpc_response",
      shouldAutoSwitch: hasExhaustedRateLimit(message?.result),
      quota: normalizeRuntimeQuotaSnapshot(message?.result),
    });
  }

  if (
    hasStructuredQuotaError(message?.error)
  ) {
    return buildRpcQuotaSignal({
      event,
      requestId: `rpc:${responseId}`,
      method,
      reason: "rpc_response",
      shouldAutoSwitch: true,
      quota: null,
    });
  }

  return null;
}

function extractRpcActivitySignal(
  payload: BridgeProbePayload | null,
): ManagedWatchActivitySignal | null {
  if (!payload) {
    return null;
  }

  const event = payload.event;
  const eventType = typeof event.type === "string" ? event.type : null;
  if (eventType !== "mcp-notification") {
    return null;
  }

  const method = typeof event.method === "string" ? event.method : null;
  if (method === "account/rateLimits/updated") {
    return {
      requestId: `rpc:notification:${method}`,
      method,
      reason: "quota_dirty",
      bodySnippet: stringifySnippet(event),
    };
  }

  if (method === "turn/completed") {
    return {
      requestId: `rpc:notification:${method}`,
      method,
      reason: "turn_completed",
      bodySnippet: stringifySnippet(event),
    };
  }

  return null;
}

async function evaluateDevtoolsExpression(
  createWebSocketImpl: CreateWebSocketLike,
  webSocketDebuggerUrl: string,
  expression: string,
  timeoutMs: number,
): Promise<void> {
  const socket = createWebSocketImpl(webSocketDebuggerUrl);

  await new Promise<void>((resolve, reject) => {
    const requestId = 1;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Codex Desktop devtools response."));
    }, timeoutMs);

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
        reject(
          new Error(
            extractDevtoolsExceptionMessage(result)
              ?? "Codex Desktop rejected the app-server restart request.",
          ),
        );
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

async function evaluateDevtoolsExpressionWithResult<T>(
  createWebSocketImpl: CreateWebSocketLike,
  webSocketDebuggerUrl: string,
  expression: string,
  timeoutMs: number,
): Promise<T> {
  const socket = createWebSocketImpl(webSocketDebuggerUrl);

  return await new Promise<T>((resolve, reject) => {
    const requestId = 1;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Codex Desktop devtools response."));
    }, timeoutMs);

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
            returnByValue: true,
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
      if (!result || !isRecord(result.result)) {
        cleanup();
        reject(new Error("Codex Desktop devtools request returned an invalid result."));
        return;
      }

      if (isRecord(result.exceptionDetails)) {
        cleanup();
        reject(
          new Error(
            extractDevtoolsExceptionMessage(result) ?? "Codex Desktop rejected the devtools request.",
          ),
        );
        return;
      }

      cleanup();
      resolve(result.result.value as T);
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
  ${buildCodexDesktopGuardExpression()}
  const hostId = ${JSON.stringify(CODEX_LOCAL_HOST_ID)};
  const force = ${JSON.stringify(force)};
  const timeoutMs = ${JSON.stringify(timeoutMs)};
  const fallbackPollIntervalMs = 2000;
  const rpcTimeoutMs = 5000;

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

  const restart = async () => {
    await postMessage({
      type: "codex-app-server-restart",
      hostId,
    });
  };

  const pendingResponses = new Map();
  let nextRequestId = 1;

  const onMessage = (event) => {
    const data = event?.data;
    if (!isRecord(data) || data.type !== "mcp-response" || !isRecord(data.message)) {
      return;
    }

    const responseId =
      typeof data.message.id === "string" || typeof data.message.id === "number"
        ? String(data.message.id)
        : null;
    if (!responseId) {
      return;
    }

    const pending = pendingResponses.get(responseId);
    if (!pending) {
      return;
    }

    pendingResponses.delete(responseId);
    window.clearTimeout(pending.timeoutHandle);

    if (isRecord(data.message.error)) {
      pending.reject(toError(data.message.error, "Codex Desktop bridge request failed."));
      return;
    }

    pending.resolve(data.message.result);
  };

  window.addEventListener("message", onMessage);

  const sendRpcRequest = async (method, params = {}) => {
    const requestId = "codexm-switch-" + String(nextRequestId++);

    return await new Promise((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        pendingResponses.delete(requestId);
        reject(new Error("Timed out waiting for Codex Desktop bridge response."));
      }, rpcTimeoutMs);

      pendingResponses.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });

      void postMessage({
        type: "mcp-request",
        hostId,
        request: {
          id: requestId,
          method,
          params,
        },
      }).catch((error) => {
        pendingResponses.delete(requestId);
        window.clearTimeout(timeoutHandle);
        reject(toError(error, "Failed to send Codex Desktop bridge request."));
      });
    });
  };

  const listLoadedThreadIds = async () => {
    const threadIds = [];
    let cursor = null;

    while (true) {
      const result = await sendRpcRequest(
        "thread/loaded/list",
        cursor ? { cursor } : {},
      );

      const data = Array.isArray(result?.data) ? result.data : [];
      for (const threadId of data) {
        if (typeof threadId === "string" && threadId) {
          threadIds.push(threadId);
        }
      }

      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor) {
        return threadIds;
      }
    }
  };

  const collectActiveThreadIds = async () => {
    const loadedThreadIds = await listLoadedThreadIds();
    const activeThreadIds = [];

    for (const threadId of loadedThreadIds) {
      try {
        const result = await sendRpcRequest("thread/read", { threadId });
        const thread = isRecord(result?.thread) ? result.thread : null;
        const status = isRecord(thread?.status) ? thread.status : null;

        if (status?.type === "active") {
          activeThreadIds.push(threadId);
        }
      } catch (error) {
        const message = toError(error, "Failed to read thread state.").message;
        if (!message.includes("notLoaded")) {
          throw error;
        }
      }
    }

    return activeThreadIds;
  };

  if (force) {
    try {
      await restart();
      return { mode: "force" };
    } finally {
      window.removeEventListener("message", onMessage);
    }
  }

  try {
    let activeThreadIds = await collectActiveThreadIds();
    if (activeThreadIds.length === 0) {
      await restart();
      return { mode: "immediate" };
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      let fallbackHandle = null;
      let checking = false;

      const cleanup = () => {
        window.clearTimeout(timeoutHandle);
        if (fallbackHandle !== null) {
          window.clearInterval(fallbackHandle);
        }
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

      const checkThreads = async () => {
        if (settled || checking) {
          return;
        }

        checking = true;

        try {
          activeThreadIds = await collectActiveThreadIds();
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

      fallbackHandle = window.setInterval(() => {
        void checkThreads();
      }, fallbackPollIntervalMs);

      void checkThreads();
    });

    return { mode: "waited" };
  } finally {
    for (const pending of pendingResponses.values()) {
      window.clearTimeout(pending.timeoutHandle);
    }
    pendingResponses.clear();
    window.removeEventListener("message", onMessage);
  }
})()`;
}

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

  async function readDesktopRuntimeAccount(): Promise<RuntimeAccountSnapshot | null> {
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
      buildManagedCurrentAccountExpression(),
      DEVTOOLS_REQUEST_TIMEOUT_MS,
    );

    return normalizeRuntimeAccountSnapshot(rawResult);
  }

  async function readDesktopRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null> {
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
      buildManagedCurrentQuotaExpression(),
      DEVTOOLS_REQUEST_TIMEOUT_MS,
    );

    return normalizeRuntimeQuotaSnapshot(rawResult);
  }

  async function readDirectRuntimeAccount(): Promise<RuntimeAccountSnapshot | null> {
    const directClient = await createDirectClientImpl();

    try {
      const rawResult = await directClient.request("account/read", {
        refreshToken: false,
      });
      return normalizeRuntimeAccountSnapshot(rawResult);
    } finally {
      await directClient.close();
    }
  }

  async function readDirectRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null> {
    const directClient = await createDirectClientImpl();

    try {
      const rawResult = await directClient.request("account/rateLimits/read", {});
      return normalizeRuntimeQuotaSnapshot(rawResult);
    } finally {
      await directClient.close();
    }
  }

  async function readCurrentRuntimeAccountResult(): Promise<RuntimeReadResult<RuntimeAccountSnapshot> | null> {
    let desktopError: Error | null = null;

    try {
      const desktopAccount = await readDesktopRuntimeAccount();
      if (desktopAccount) {
        return {
          snapshot: desktopAccount,
          source: "desktop",
        };
      }
    } catch (error) {
      desktopError = toErrorMessage(error, "Failed to read the current Desktop runtime account.");
    }

    try {
      const directAccount = await readDirectRuntimeAccount();
      if (!directAccount) {
        return null;
      }

      return {
        snapshot: directAccount,
        source: "direct",
      };
    } catch (error) {
      const directError = toErrorMessage(error, "Failed to read the direct runtime account.");
      if (!desktopError) {
        throw directError;
      }

      throw new Error(
        `${desktopError.message} Fallback direct runtime account read failed: ${directError.message}`,
      );
    }
  }

  async function readCurrentRuntimeQuotaResult(): Promise<RuntimeReadResult<RuntimeQuotaSnapshot> | null> {
    let desktopError: Error | null = null;

    try {
      const desktopQuota = await readDesktopRuntimeQuota();
      if (desktopQuota) {
        return {
          snapshot: desktopQuota,
          source: "desktop",
        };
      }
    } catch (error) {
      desktopError = toErrorMessage(error, "Failed to read the current Desktop runtime quota.");
    }

    try {
      const directQuota = await readDirectRuntimeQuota();
      if (!directQuota) {
        return null;
      }

      return {
        snapshot: directQuota,
        source: "direct",
      };
    } catch (error) {
      const directError = toErrorMessage(error, "Failed to read the direct runtime quota.");
      if (!desktopError) {
        throw directError;
      }

      throw new Error(
        `${desktopError.message} Fallback direct runtime quota read failed: ${directError.message}`,
      );
    }
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
