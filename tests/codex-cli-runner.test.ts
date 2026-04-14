import { describe, expect, test } from "@rstest/core";
import type { spawn } from "node:child_process";
import type { watch } from "node:fs";
import { mkdtemp, mkdir, readFile as readFileFs, rm, writeFile, type readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCodexWithAutoRestart } from "../src/codex-cli-runner.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectPromisePending<T>(promise: Promise<T>, timeoutMs = 25): Promise<void> {
  const result = await Promise.race([
    promise.then(() => "resolved" as const),
    delay(timeoutMs).then(() => "pending" as const),
  ]);

  expect(result).toBe("pending");
}

function createMockChildProcess(pid = 12345) {
  const handlers = new Map<string, Function[]>();

  return {
    pid,
    exitCode: null as number | null,
    killCalls: [] as string[],
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return this;
    },
    once(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return this;
    },
    kill(signal: string) {
      this.killCalls.push(signal);
      return true;
    },
    emitExit(code: number) {
      this.exitCode = code;
      for (const handler of handlers.get("exit") ?? []) {
        handler(code);
      }
    },
  };
}

function createMockCliManager() {
  return {
    registerProcess: async () => undefined,
  };
}

function createMockWatch() {
  const callbacks: Array<(eventType?: string, filename?: string | Buffer) => void> = [];

  const watchImpl = ((_path: import("node:fs").PathLike, optionsOrListener?: unknown, maybeListener?: unknown) => {
    const callback = (typeof optionsOrListener === "function"
      ? optionsOrListener
      : maybeListener) as ((eventType?: string, filename?: string | Buffer) => void) | undefined;
    if (callback) {
      callbacks.push(callback);
    }
    return {
      close() {
        return;
      },
      on() {
        return this;
      },
    } as never;
  }) as unknown as typeof watch;

  return {
    watchImpl,
    trigger(filename = "auth.json") {
      for (const callback of callbacks) {
        callback("rename", filename);
      }
    },
  };
}

function createWritableCapture(): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  let output = "";
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    } as NodeJS.WriteStream,
    read() {
      return output;
    },
  };
}

async function createTempSessionsDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codexm-runner-sessions-"));
}

async function writeSessionMetaFile(
  sessionsDir: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const dayDir = join(sessionsDir, "2026", "04", "14");
  await mkdir(dayDir, { recursive: true });
  await writeFile(
    join(dayDir, `rollout-2026-04-14T00-00-00-${sessionId}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-04-14T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd,
      },
    })}\n`,
    "utf8",
  );
}

describe("codex-cli-runner", () => {
  test("spawns codex with the provided args and returns the natural exit code", async () => {
    const spawned: ReturnType<typeof createMockChildProcess>[] = [];
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const sessionsDirPath = await createTempSessionsDir();

    try {
      const promise = runCodexWithAutoRestart({
        codexArgs: ["--model", "o3"],
        codexBinary: "/usr/bin/codex",
        disableAuthWatch: true,
        attachProcessSignalHandlers: false,
        cliManager: createMockCliManager() as never,
        sessionsDirPath,
        readFileImpl: (async () => "token-1") as unknown as typeof readFile,
        spawnImpl: ((file: string, argsOrOptions?: readonly string[] | object, _options?: object) => {
          const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
          spawnCalls.push({ file, args: [...(args ?? [])] });
          const child = createMockChildProcess(1001);
          spawned.push(child);
          return child as never;
        }) as unknown as typeof spawn,
      });

      await delay(0);
      expect(spawnCalls).toEqual([
        {
          file: "/usr/bin/codex",
          args: ["--model", "o3"],
        },
      ]);

      spawned[0]!.emitExit(42);
      await expect(promise).resolves.toEqual({
        exitCode: 42,
        restartCount: 0,
      });
    } finally {
      await rm(sessionsDirPath, { recursive: true, force: true });
    }
  });

  test("restarts codex when the watched auth file changes and resumes the last session", async () => {
    const spawned: ReturnType<typeof createMockChildProcess>[] = [];
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let readCount = 0;
    const sessionsDirPath = await createTempSessionsDir();
    const watcher = createMockWatch();

    try {
      const promise = runCodexWithAutoRestart({
        codexArgs: [],
        debounceMs: 10,
        killTimeoutMs: 20,
        attachProcessSignalHandlers: false,
        cliManager: createMockCliManager() as never,
        sessionsDirPath,
        watchImpl: watcher.watchImpl,
        spawnImpl: ((file: string, argsOrOptions?: readonly string[] | object, _options?: object) => {
          const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
          spawnCalls.push({ file, args: [...(args ?? [])] });
          const child = createMockChildProcess(2000 + spawned.length);
          spawned.push(child);
          return child as never;
        }) as unknown as typeof spawn,
        readFileImpl: (async () => {
          readCount += 1;
          return `token-${readCount}`;
        }) as unknown as typeof readFile,
      });

      await delay(0);
      expect(spawned).toHaveLength(1);

      watcher.trigger();
      await delay(15);
      expect(spawned[0]!.killCalls).toEqual(["SIGTERM"]);

      spawned[0]!.emitExit(0);
      await delay(10);
      expect(spawned).toHaveLength(2);
      expect(spawnCalls).toEqual([
        { file: "codex", args: [] },
        { file: "codex", args: ["resume", "--last"] },
      ]);
      await expectPromisePending(promise);

      spawned[1]!.emitExit(0);
      await expect(promise).resolves.toEqual({
        exitCode: 0,
        restartCount: 1,
      });
    } finally {
      await rm(sessionsDirPath, { recursive: true, force: true });
    }
  });

  test("tracks the exact session id and reuses it across multiple auth switches", async () => {
    const spawned: ReturnType<typeof createMockChildProcess>[] = [];
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let readCount = 0;
    const sessionsDirPath = await createTempSessionsDir();
    const watcher = createMockWatch();
    const cwd = "/tmp/project";

    try {
      const promise = runCodexWithAutoRestart({
        codexArgs: ["--model", "o3"],
        cwd,
        debounceMs: 10,
        killTimeoutMs: 20,
        attachProcessSignalHandlers: false,
        cliManager: createMockCliManager() as never,
        sessionsDirPath,
        sessionDiscoveryTimeoutMs: 200,
        sessionDiscoveryPollIntervalMs: 10,
        watchImpl: watcher.watchImpl,
        spawnImpl: ((file: string, argsOrOptions?: readonly string[] | object, _options?: object) => {
          const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
          spawnCalls.push({ file, args: [...(args ?? [])] });
          const child = createMockChildProcess(5000 + spawned.length);
          spawned.push(child);
          return child as never;
        }) as unknown as typeof spawn,
        readFileImpl: (async (path: Parameters<typeof readFileFs>[0], encoding?: Parameters<typeof readFileFs>[1]) => {
          if (String(path).endsWith(".jsonl")) {
            return await readFileFs(path, encoding ?? "utf8");
          }
          readCount += 1;
          return `token-${readCount}`;
        }) as unknown as typeof readFile,
      });

      await writeSessionMetaFile(
        sessionsDirPath,
        "session-123",
        cwd,
      );
      await delay(30);

      watcher.trigger();
      await delay(15);
      spawned[0]!.emitExit(0);
      await delay(10);

      watcher.trigger();
      await delay(15);
      spawned[1]!.emitExit(0);
      await delay(10);

      expect(spawnCalls).toEqual([
        { file: "codex", args: ["--model", "o3"] },
        { file: "codex", args: ["--model", "o3", "resume", "session-123"] },
        { file: "codex", args: ["--model", "o3", "resume", "session-123"] },
      ]);

      spawned[2]!.emitExit(0);
      await expect(promise).resolves.toEqual({
        exitCode: 0,
        restartCount: 2,
      });
    } finally {
      await rm(sessionsDirPath, { recursive: true, force: true });
    }
  });

  test("ignores a late exit from the replaced process after the new process has started", async () => {
    const spawned: ReturnType<typeof createMockChildProcess>[] = [];
    let readCount = 0;
    const sessionsDirPath = await createTempSessionsDir();
    const watcher = createMockWatch();

    try {
      const promise = runCodexWithAutoRestart({
        codexArgs: [],
        debounceMs: 10,
        killTimeoutMs: 20,
        attachProcessSignalHandlers: false,
        cliManager: createMockCliManager() as never,
        sessionsDirPath,
        spawnImpl: ((file: string, argsOrOptions?: readonly string[] | object, _options?: object) => {
          const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
          const child = createMockChildProcess(4000 + spawned.length);
          spawned.push(child);
          return child as never;
        }) as unknown as typeof spawn,
        watchImpl: watcher.watchImpl,
        readFileImpl: (async () => {
          readCount += 1;
          return `token-${readCount}`;
        }) as unknown as typeof readFile,
      });

      await delay(0);
      expect(spawned).toHaveLength(1);

      watcher.trigger();
      await delay(70);

      expect(spawned[0]!.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
      expect(spawned).toHaveLength(2);
      expect(spawned[1]!.killCalls).toEqual([]);

      spawned[0]!.emitExit(0);
      await expectPromisePending(promise);
      expect(spawned[1]!.killCalls).toEqual([]);

      spawned[1]!.emitExit(0);
      await expect(promise).resolves.toEqual({
        exitCode: 0,
        restartCount: 1,
      });
    } finally {
      await rm(sessionsDirPath, { recursive: true, force: true });
    }
  });

  test("stops the runner when aborted", async () => {
    const controller = new AbortController();
    const child = createMockChildProcess(3001);
    const sessionsDirPath = await createTempSessionsDir();

    try {
      const promise = runCodexWithAutoRestart({
        codexArgs: [],
        disableAuthWatch: true,
        attachProcessSignalHandlers: false,
        signal: controller.signal,
        cliManager: createMockCliManager() as never,
        sessionsDirPath,
        readFileImpl: (async () => "token-1") as unknown as typeof readFile,
        spawnImpl: (() => child as never) as unknown as typeof spawn,
      });

      await delay(0);
      controller.abort();
      await expect(promise).resolves.toEqual({
        exitCode: 0,
        restartCount: 0,
      });
      expect(child.killCalls).toEqual(["SIGTERM"]);
    } finally {
      await rm(sessionsDirPath, { recursive: true, force: true });
    }
  });

  test("prints a resume hint when the interactive codex session ends naturally", async () => {
    const child = createMockChildProcess(6001);
    const sessionsDirPath = await createTempSessionsDir();
    const stderr = createWritableCapture();

    try {
      const promise = runCodexWithAutoRestart({
        codexArgs: [],
        disableAuthWatch: true,
        attachProcessSignalHandlers: false,
        sessionsDirPath,
        sessionDiscoveryTimeoutMs: 200,
        sessionDiscoveryPollIntervalMs: 10,
        cliManager: createMockCliManager() as never,
        stderr: stderr.stream,
        readFileImpl: (async (path: Parameters<typeof readFileFs>[0], encoding?: Parameters<typeof readFileFs>[1]) => {
          if (String(path).endsWith(".jsonl")) {
            return await readFileFs(path, encoding ?? "utf8");
          }
          return "token-1";
        }) as unknown as typeof readFile,
        spawnImpl: (() => child as never) as unknown as typeof spawn,
      });

      await writeSessionMetaFile(sessionsDirPath, "session-hint", process.cwd());
      await delay(30);
      child.emitExit(0);
      await expect(promise).resolves.toEqual({
        exitCode: 0,
        restartCount: 0,
      });
      expect(stderr.read()).toContain('Resume with: codex resume session-hint');
    } finally {
      await rm(sessionsDirPath, { recursive: true, force: true });
    }
  });
});
