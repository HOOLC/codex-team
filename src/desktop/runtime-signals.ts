import type {
  ManagedQuotaSignal,
  ManagedWatchActivitySignal,
  RuntimeQuotaSnapshot,
} from "./types.js";
import {
  CODEXM_WATCH_CONSOLE_PREFIX,
  isRecord,
} from "./shared.js";
import {
  normalizeRuntimeQuotaSnapshot,
  stringifySnippet,
} from "./runtime-normalizers.js";
import {
  hasExhaustedRateLimitSignal,
  hasQuotaExhaustionSignal,
} from "../quota-exhaustion-signals.js";

export interface ProbeConsolePayload {
  kind?: unknown;
  message?: unknown;
  event?: unknown;
  direction?: unknown;
}

export interface BridgeProbePayload {
  kind: "bridge";
  direction: string | null;
  event: Record<string, unknown>;
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
      method === "error" && hasQuotaExhaustionSignal(event.params)
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
      shouldAutoSwitch: hasExhaustedRateLimitSignal(message?.result),
      quota: normalizeRuntimeQuotaSnapshot(message?.result),
    });
  }

  if (
    hasQuotaExhaustionSignal(message?.error)
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
