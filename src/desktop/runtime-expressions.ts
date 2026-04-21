import {
  buildCodexDesktopGuardExpression,
  CODEX_LOCAL_HOST_ID,
  CODEXM_WATCH_CONSOLE_PREFIX,
  DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS,
  DEVTOOLS_REQUEST_TIMEOUT_MS,
} from "./shared.js";

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
  const quotaRefreshTimeoutMs = 10000;

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

  const sleep = async (ms) => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  };

  const waitForQuotaRefreshReadiness = async () => {
    const deadline = Date.now() + quotaRefreshTimeoutMs;

    while (Date.now() < deadline) {
      try {
        await sendRpcRequest("account/read", { refreshToken: false });
        return true;
      } catch {
        await sleep(250);
      }
    }

    return false;
  };

  const restart = async () => {
    await postMessage({
      type: "codex-app-server-restart",
      hostId,
    });

    if (!await waitForQuotaRefreshReadiness()) {
      return;
    }

    try {
      await postMessage({
        type: "query-cache-invalidate",
        queryKey: ["rate-limit-status"],
      });
    } catch {}
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
