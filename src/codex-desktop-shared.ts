import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CODEX_REMOTE_DEBUGGING_PORT = 39223;
export const DEFAULT_CODEX_DESKTOP_STATE_PATH = join(
  homedir(),
  ".codex-team",
  "desktop-state.json",
);
export const CODEX_BINARY_SUFFIX = "/Contents/MacOS/Codex";
export const CODEX_APP_NAME = "Codex";
export const CODEX_LOCAL_HOST_ID = "local";
export const DEFAULT_MANAGED_DESKTOP_SWITCH_TIMEOUT_MS = 120_000;
export const CODEXM_WATCH_CONSOLE_PREFIX = "__codexm_watch__";
export const DEVTOOLS_REQUEST_TIMEOUT_MS = 5_000;
export const DEVTOOLS_SWITCH_TIMEOUT_BUFFER_MS = 10_000;
export const DEFAULT_WATCH_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_WATCH_HEALTH_CHECK_INTERVAL_MS = 5_000;
export const DEFAULT_WATCH_HEALTH_CHECK_TIMEOUT_MS = 3_000;

export function buildCodexDesktopGuardExpression(): string {
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

export const CODEX_APP_SERVER_RESTART_EXPRESSION = `(async () => {${buildCodexDesktopGuardExpression()}
  await window.electronBridge.sendMessageFromView({ type: "codex-app-server-restart", hostId: "local" });
})()`;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAbortError(): Error {
  const error = new Error("Managed Codex Desktop refresh was interrupted.");
  error.name = "AbortError";
  return error;
}

export async function waitForPromiseOrAbort<T>(
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

export function normalizeBodySnippet(body: string | null): string | null {
  if (!body) {
    return null;
  }

  return body.slice(0, 2_000);
}

export function toErrorMessage(value: unknown, fallback: string): Error {
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
