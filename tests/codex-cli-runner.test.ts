import { describe, expect, test } from "@rstest/core";
import type { spawn } from "node:child_process";
import type { watch } from "node:fs";
import type { readFile } from "node:fs/promises";

import { runCodexWithAutoRestart } from "../src/codex-cli-runner.js";

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

describe("codex-cli-runner", () => {
  test("spawns codex with the provided args and returns the natural exit code", async () => {
    const spawned: ReturnType<typeof createMockChildProcess>[] = [];
    const spawnCalls: Array<{ file: string; args: string[] }> = [];

    const promise = runCodexWithAutoRestart({
      codexArgs: ["--model", "o3"],
      codexBinary: "/usr/bin/codex",
      disableAuthWatch: true,
      attachProcessSignalHandlers: false,
      cliManager: createMockCliManager() as never,
      readFileImpl: (async () => "token-1") as unknown as typeof readFile,
      spawnImpl: ((file: string, argsOrOptions?: readonly string[] | object, _options?: object) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        spawnCalls.push({ file, args: [...(args ?? [])] });
        const child = createMockChildProcess(1001);
        spawned.push(child);
        return child as never;
      }) as unknown as typeof spawn,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
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
  });

  test("restarts codex when the watched auth file changes", async () => {
    const spawned: ReturnType<typeof createMockChildProcess>[] = [];
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let watchCallback: (() => void) | undefined;
    let readCount = 0;

    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      debounceMs: 10,
      killTimeoutMs: 20,
      attachProcessSignalHandlers: false,
      cliManager: createMockCliManager() as never,
      spawnImpl: ((file: string, argsOrOptions?: readonly string[] | object, _options?: object) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        spawnCalls.push({ file, args: [...(args ?? [])] });
        const child = createMockChildProcess(2000 + spawned.length);
        spawned.push(child);
        return child as never;
      }) as unknown as typeof spawn,
      watchImpl: ((_path: import("node:fs").PathLike, optionsOrListener?: unknown, maybeListener?: unknown) => {
        watchCallback = typeof optionsOrListener === "function"
          ? optionsOrListener as () => void
          : maybeListener as (() => void) | undefined;
        return {
          close() {
            return;
          },
          on() {
            return this;
          },
        } as never;
      }) as unknown as typeof watch,
      readFileImpl: (async () => {
        readCount += 1;
        return `token-${readCount}`;
      }) as unknown as typeof readFile,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawned).toHaveLength(1);

    if (!watchCallback) {
      throw new Error("watch callback not registered");
    }
    watchCallback();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(spawned[0]!.killCalls).toEqual(["SIGTERM"]);

    spawned[0]!.emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toHaveLength(2);
    expect(spawnCalls).toHaveLength(2);

    spawned[1]!.emitExit(0);
    await expect(promise).resolves.toEqual({
      exitCode: 0,
      restartCount: 1,
    });
  });

  test("stops the runner when aborted", async () => {
    const controller = new AbortController();
    const child = createMockChildProcess(3001);

    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      disableAuthWatch: true,
      attachProcessSignalHandlers: false,
      signal: controller.signal,
      cliManager: createMockCliManager() as never,
      readFileImpl: (async () => "token-1") as unknown as typeof readFile,
      spawnImpl: (() => child as never) as unknown as typeof spawn,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(promise).resolves.toEqual({
      exitCode: 0,
      restartCount: 0,
    });
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });
});
