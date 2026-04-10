import { spawn as spawnCallback } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const DEFAULT_DIRECT_CLIENT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_DIRECT_CLIENT_NAME = "codexm";
const DEFAULT_DIRECT_CLIENT_VERSION = "0.0.0";

interface JsonRpcErrorShape {
  message?: unknown;
}

interface JsonRpcResponseShape {
  id?: unknown;
  result?: unknown;
  error?: JsonRpcErrorShape | null;
}

interface DirectClientLaunchPlan {
  command: string;
  args: readonly string[];
  options: {
    stdio: ["pipe", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
    windowsHide?: boolean;
  };
  description: string;
}

interface DirectClientPendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CodexDirectClientProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  killed?: boolean;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "error",
    listener: (error: Error) => void,
  ): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(
    event: "error",
    listener: (error: Error) => void,
  ): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface CodexDirectClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export function createCodexDirectLaunchPlan(env: NodeJS.ProcessEnv = process.env): DirectClientLaunchPlan {
  const baseOptions = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    env: { ...env },
  };

  if (process.platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/c", "codex app-server"],
      options: {
        ...baseOptions,
        windowsHide: true,
      },
      description: "`cmd.exe /d /c codex app-server`",
    };
  }

  return {
    command: "codex",
    args: ["app-server"],
    options: baseOptions,
    description: "`codex app-server`",
  };
}

function createDirectClientCloseError(options: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrBuffer: string;
  launchDescription: string;
}): Error {
  const details = options.stderrBuffer.trim();
  const fallback = `Process exited with code ${String(options.code)}${
    options.signal ? ` (signal: ${options.signal})` : ""
  }.`;
  return new Error(`Codex launcher ${options.launchDescription} failed: ${details || fallback}`);
}

function appendOutputBuffer(buffer: string, chunk: string): string {
  return `${buffer}${chunk}`.slice(-4_096);
}

function toErrorMessage(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }

  if (
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim() !== ""
  ) {
    return new Error(value.message);
  }

  if (typeof value === "string" && value.trim() !== "") {
    return new Error(value);
  }

  return new Error(fallback);
}

function buildJsonRpcRequest(
  id: string,
  method: string,
  params: Record<string, unknown> | undefined,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params ?? {},
  });
}

function buildJsonRpcNotification(
  method: string,
  params: Record<string, unknown> | undefined,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method,
    params: params ?? {},
  });
}

function normalizeResponseId(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return null;
}

function shutdownDirectClientProcess(processLike: CodexDirectClientProcess): void {
  if (processLike.killed || processLike.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    processLike.kill();
    return;
  }

  processLike.kill("SIGTERM");
}

export async function createCodexDirectClient(options: {
  clientName?: string;
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  launchProcessImpl?: () => CodexDirectClientProcess;
} = {}): Promise<CodexDirectClient> {
  const clientName = options.clientName ?? DEFAULT_DIRECT_CLIENT_NAME;
  const clientVersion = options.clientVersion ?? DEFAULT_DIRECT_CLIENT_VERSION;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_DIRECT_CLIENT_REQUEST_TIMEOUT_MS;
  const launchPlan = createCodexDirectLaunchPlan(options.env);
  const launchProcessImpl =
    options.launchProcessImpl
    ?? (() =>
      spawnCallback(
        launchPlan.command,
        [...launchPlan.args],
        launchPlan.options,
      ) as unknown as CodexDirectClientProcess);

  const childProcess = launchProcessImpl();
  const pendingRequests = new Map<string, DirectClientPendingRequest>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let nextRequestId = 1;
  let closed = false;

  const rejectPendingRequests = (error: Error) => {
    for (const pendingRequest of pendingRequests.values()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(error);
    }
    pendingRequests.clear();
  };

  const closePromise = new Promise<void>((resolve, reject) => {
    childProcess.on("error", (error) => {
      rejectPendingRequests(error);
      reject(error);
    });

    childProcess.on("close", (code, signal) => {
      if (!closed && (code !== 0 || signal !== null)) {
        const error = createDirectClientCloseError({
          code,
          signal,
          stderrBuffer,
          launchDescription: launchPlan.description,
        });
        rejectPendingRequests(error);
        reject(error);
        return;
      }

      resolve();
    });
  });
  void closePromise.catch(() => undefined);

  childProcess.stderr.on("data", (chunk) => {
    stderrBuffer = appendOutputBuffer(stderrBuffer, chunk.toString("utf8"));
  });

  childProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      let parsed: JsonRpcResponseShape;
      try {
        parsed = JSON.parse(trimmedLine) as JsonRpcResponseShape;
      } catch {
        continue;
      }

      const responseId = normalizeResponseId(parsed.id);
      if (!responseId) {
        continue;
      }

      const pendingRequest = pendingRequests.get(responseId);
      if (!pendingRequest) {
        continue;
      }

      pendingRequests.delete(responseId);
      clearTimeout(pendingRequest.timeout);

      if (parsed.error) {
        pendingRequest.reject(
          toErrorMessage(parsed.error, `Codex direct client request ${responseId} failed.`),
        );
        continue;
      }

      pendingRequest.resolve(parsed.result ?? null);
    }
  });

  const sendRequest = async (
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> => {
    if (closed) {
      throw new Error("Codex direct client is already closed.");
    }

    const requestId = `codexm-direct-${String(nextRequestId)}`;
    nextRequestId += 1;
    const payload = buildJsonRpcRequest(requestId, method, params);

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Timed out waiting for direct Codex response to ${method}.`));
      }, requestTimeoutMs);

      pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });

      childProcess.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        reject(toErrorMessage(error, `Failed to send direct Codex request for ${method}.`));
      });
    });
  };

  await sendRequest("initialize", {
    clientInfo: {
      name: clientName,
      version: clientVersion,
    },
    capabilities: {},
  });

  childProcess.stdin.write(`${buildJsonRpcNotification("initialized", undefined)}\n`);

  return {
    async request(method, params = {}) {
      return await sendRequest(method, params);
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      rejectPendingRequests(new Error("Codex direct client closed."));
      shutdownDirectClientProcess(childProcess);
    },
  };
}
