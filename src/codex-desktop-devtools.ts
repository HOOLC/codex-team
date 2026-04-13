import type { ManagedCodexDesktopState } from "./codex-desktop-types.js";
import {
  CODEX_LOCAL_HOST_ID,
  isNonEmptyString,
  isRecord,
} from "./codex-desktop-shared.js";

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<FetchLikeResponse>;

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type CreateWebSocketLike = (url: string) => WebSocketLike;

export function createDefaultWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function isDevtoolsTarget(value: unknown): value is {
  type?: unknown;
  url?: unknown;
  webSocketDebuggerUrl?: unknown;
} {
  return isRecord(value);
}

export async function resolveLocalDevtoolsTarget(
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

export function extractDevtoolsExceptionMessage(result: Record<string, unknown> | null): string | null {
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

export async function evaluateDevtoolsExpression(
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

export async function evaluateDevtoolsExpressionWithResult<T>(
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
