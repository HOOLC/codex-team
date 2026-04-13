import type {
  ManagedQuotaSignal,
  ManagedWatchActivitySignal,
  RuntimeAccountSnapshot,
  RuntimeQuotaSnapshot,
} from "./types.js";
import {
  buildCodexDesktopGuardExpression,
  CODEXM_WATCH_CONSOLE_PREFIX,
  CODEX_LOCAL_HOST_ID,
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
  DEVTOOLS_REQUEST_TIMEOUT_MS,
  normalizeBodySnippet,
  isRecord,
} from "./shared.js";

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

export function buildManagedWatchProbeExpression(): string {
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

export function buildManagedCurrentQuotaExpression(): string {
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

export function buildManagedCurrentAccountExpression(): string {
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

export function normalizeRuntimeQuotaSnapshot(value: unknown): RuntimeQuotaSnapshot | null {
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

export function normalizeRuntimeAccountSnapshot(value: unknown): RuntimeAccountSnapshot | null {
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

export function extractRuntimeConsoleText(payload: Record<string, unknown>): string | null {
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

export function extractProbeConsolePayload(message: string | null): ProbeConsolePayload | null {
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

export function normalizeBridgeProbePayload(payload: ProbeConsolePayload | null): BridgeProbePayload | null {
  if (payload?.kind !== "bridge" || !isRecord(payload.event)) {
    return null;
  }

  return {
    kind: "bridge",
    direction: typeof payload.direction === "string" ? payload.direction : null,
    event: payload.event,
  };
}

export function formatBridgeDebugLine(payload: BridgeProbePayload): string {
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

export function extractRpcQuotaSignal(
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

export function extractRpcActivitySignal(
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

export function buildManagedSwitchExpression(options?: {
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
