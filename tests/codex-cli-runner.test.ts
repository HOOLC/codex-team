/**
 * Tests for codex-cli-runner.ts — the `codexm run` auto-restart wrapper.
 */

import { describe, it, expect, rstest as rs, beforeEach, afterEach } from "@rstest/core";

// ── Mocks ──

function createMockChildProcess(pid = 12345) {
  const handlers = new Map<string, Function[]>();
  return {
    pid,
    exitCode: null as number | null,
    kill: rs.fn(),
    on: rs.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    once: rs.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    unref: rs.fn(),
    _handlers: handlers,
    _simulateExit(code: number) {
      this.exitCode = code;
      for (const h of handlers.get("exit") ?? []) h(code);
    },
  };
}

const mockStderr = { write: rs.fn() } as unknown as NodeJS.WriteStream;

const mockCliManager = {
  registerProcess: rs.fn().mockResolvedValue(undefined),
  getProcesses: rs.fn().mockReturnValue([]),
  pruneStaleProcesses: rs.fn().mockResolvedValue([]),
  pruneDeadProcesses: rs.fn().mockResolvedValue(undefined),
  restartCliProcess: rs.fn().mockResolvedValue(undefined),
  getTrackedProcesses: rs.fn().mockResolvedValue([]),
  findRunningCliProcesses: rs.fn().mockResolvedValue([]),
  readDirectQuota: rs.fn().mockResolvedValue(null),
  readDirectAccount: rs.fn().mockResolvedValue(null),
  watchCliQuotaSignals: rs.fn().mockResolvedValue(undefined),
};

let spawnMock: ReturnType<typeof rs.fn>;
let watchMock: ReturnType<typeof rs.fn>;
let readFileMock: ReturnType<typeof rs.fn>;
let watchCallback: ((...args: any[]) => void) | null = null;
let nextPid = 12345;

rs.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

rs.mock("node:fs", () => ({
  watch: (...args: any[]) => watchMock(...args),
}));

rs.mock("node:fs/promises", () => ({
  readFile: (...args: any[]) => readFileMock(...args),
  stat: rs.fn().mockResolvedValue({ mtimeMs: Date.now() }),
}));

rs.mock("../src/codex-cli-watcher.js", () => ({
  createCliProcessManager: () => mockCliManager,
}));

// Import after mocks
const { runCodexWithAutoRestart } = await import("../src/codex-cli-runner.js");

describe("codex-cli-runner", () => {
  let mockProcesses: ReturnType<typeof createMockChildProcess>[];

  beforeEach(() => {
    rs.useFakeTimers();
    rs.clearAllMocks();
    mockProcesses = [];
    nextPid = 12345;
    watchCallback = null;

    spawnMock = rs.fn(() => {
      const p = createMockChildProcess(nextPid++);
      mockProcesses.push(p);
      return p;
    });

    watchMock = rs.fn((_path: string, _opts: any, cb: Function) => {
      watchCallback = cb as any;
      return {
        close: rs.fn(),
        on: rs.fn(),
      };
    });

    // Default: auth file reads return different hashes on each call
    let callCount = 0;
    readFileMock = rs.fn(async () => {
      callCount++;
      return JSON.stringify({ token: `token-${callCount}` });
    });
  });

  afterEach(() => {
    rs.useRealTimers();
  });

  it("spawns codex with correct args", async () => {
    const promise = runCodexWithAutoRestart({
      codexArgs: ["--model", "o3"],
      codexBinary: "/usr/bin/codex",
      disableAuthWatch: true,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    // Let the spawn happen
    await rs.advanceTimersByTimeAsync(10);

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/codex",
      ["--model", "o3"],
      expect.objectContaining({ stdio: "inherit" }),
    );

    // Exit naturally
    mockProcesses[0]._simulateExit(0);
    const result = await promise;
    expect(result.exitCode).toBe(0);
  });

  it("returns exit code when codex exits naturally", async () => {
    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      disableAuthWatch: true,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);
    mockProcesses[0]._simulateExit(42);

    const result = await promise;
    expect(result.exitCode).toBe(42);
    expect(result.restartCount).toBe(0);
  });

  it("restarts codex when auth file changes", async () => {
    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      debounceMs: 100,
      killTimeoutMs: 1000,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);
    expect(mockProcesses).toHaveLength(1);

    // Trigger auth file change
    watchCallback?.("change", "auth.json");

    // Advance past debounce
    await rs.advanceTimersByTimeAsync(200);

    // Old process should receive SIGTERM
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGTERM");

    // Simulate the old process exiting after SIGTERM
    mockProcesses[0]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(100);

    // New process should have been spawned
    expect(mockProcesses).toHaveLength(2);

    // Clean up — exit the new process
    mockProcesses[1]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.restartCount).toBe(1);
  });

  it("increments restartCount on each restart", async () => {
    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      debounceMs: 50,
      killTimeoutMs: 500,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);

    // First restart
    watchCallback?.("change", "auth.json");
    await rs.advanceTimersByTimeAsync(100);
    mockProcesses[0]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(600);

    // Second restart
    watchCallback?.("change", "auth.json");
    await rs.advanceTimersByTimeAsync(100);
    mockProcesses[1]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(600);

    // Exit naturally
    mockProcesses[2]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.restartCount).toBe(2);
  });

  it("debounces rapid auth file changes", async () => {
    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      debounceMs: 300,
      killTimeoutMs: 1000,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);

    // Fire 4 rapid watch events
    watchCallback?.("change", "auth.json");
    await rs.advanceTimersByTimeAsync(50);
    watchCallback?.("change", "auth.json");
    await rs.advanceTimersByTimeAsync(50);
    watchCallback?.("change", "auth.json");
    await rs.advanceTimersByTimeAsync(50);
    watchCallback?.("change", "auth.json");

    // Advance past debounce from last event
    await rs.advanceTimersByTimeAsync(400);

    // Should only have killed the process once
    expect(mockProcesses[0].kill).toHaveBeenCalledTimes(1);

    // Simulate exit + cleanup
    mockProcesses[0]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(200);
    mockProcesses[1]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.restartCount).toBe(1);
  });

  it("falls back to polling when fs.watch fails", async () => {
    watchMock = rs.fn(() => {
      throw new Error("fs.watch not supported");
    });
    readFileMock = rs.fn(async () => JSON.stringify({ token: "token-stable" }));

    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      debounceMs: 50,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);
    expect(mockProcesses).toHaveLength(1);

    // Polling interval is 3000ms — advance past it
    await rs.advanceTimersByTimeAsync(3500);

    // The poll should have checked the auth file
    expect(readFileMock).toHaveBeenCalled();

    // Clean up
    mockProcesses[mockProcesses.length - 1]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(500);
    await promise;
  });

  it("registers process in CLI manager", async () => {
    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      accountId: "acc-123",
      email: "test@example.com",
      disableAuthWatch: true,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);

    expect(mockCliManager.registerProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 12345,
        command: "codex",
      }),
      "acc-123",
      "test@example.com",
    );

    mockProcesses[0]._simulateExit(0);
    await promise;
  });

  it("respects AbortSignal", async () => {
    const controller = new AbortController();

    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      signal: controller.signal,
      disableAuthWatch: true,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);
    expect(mockProcesses).toHaveLength(1);

    // Abort
    controller.abort();
    await rs.advanceTimersByTimeAsync(500);

    // The child should have been killed
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGTERM");

    mockProcesses[0]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.exitCode).toBe(0);
  });

  it("sends SIGKILL after timeout if SIGTERM doesn't work", async () => {
    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      debounceMs: 50,
      killTimeoutMs: 500,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await rs.advanceTimersByTimeAsync(10);

    // Make the process ignore SIGTERM (exitCode stays null)
    mockProcesses[0].kill.mockImplementation(() => {
      // Don't actually exit — simulates a hung process
    });

    // Trigger auth change
    watchCallback?.("change", "auth.json");
    await rs.advanceTimersByTimeAsync(100); // past debounce

    // SIGTERM sent
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGTERM");

    // Advance past killTimeout
    await rs.advanceTimersByTimeAsync(600);

    // SIGKILL should have been sent
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGKILL");

    // Simulate final exit
    mockProcesses[0]._simulateExit(137);
    await rs.advanceTimersByTimeAsync(200);

    // New process spawned
    expect(mockProcesses.length).toBeGreaterThanOrEqual(2);

    // Exit the new one
    mockProcesses[mockProcesses.length - 1]._simulateExit(0);
    await rs.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.restartCount).toBeGreaterThanOrEqual(1);
  });
});
