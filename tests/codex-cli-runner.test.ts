/**
 * Tests for codex-cli-runner.ts — the `codexm run` auto-restart wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──

function createMockChildProcess(pid = 12345) {
  const handlers = new Map<string, Function[]>();
  return {
    pid,
    exitCode: null as number | null,
    kill: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    once: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    unref: vi.fn(),
    _handlers: handlers,
    _simulateExit(code: number) {
      this.exitCode = code;
      for (const h of handlers.get("exit") ?? []) h(code);
    },
  };
}

const mockStderr = { write: vi.fn() } as unknown as NodeJS.WriteStream;

const mockCliManager = {
  registerProcess: vi.fn().mockResolvedValue(undefined),
  getProcesses: vi.fn().mockReturnValue([]),
  pruneStaleProcesses: vi.fn().mockResolvedValue([]),
  pruneDeadProcesses: vi.fn().mockResolvedValue(undefined),
  restartCliProcess: vi.fn().mockResolvedValue(undefined),
  getTrackedProcesses: vi.fn().mockResolvedValue([]),
  findRunningCliProcesses: vi.fn().mockResolvedValue([]),
  readDirectQuota: vi.fn().mockResolvedValue(null),
  readDirectAccount: vi.fn().mockResolvedValue(null),
  watchCliQuotaSignals: vi.fn().mockResolvedValue(undefined),
};

let spawnMock: ReturnType<typeof vi.fn>;
let watchMock: ReturnType<typeof vi.fn>;
let readFileMock: ReturnType<typeof vi.fn>;
let watchCallback: ((...args: any[]) => void) | null = null;
let nextPid = 12345;

vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

vi.mock("node:fs", () => ({
  watch: (...args: any[]) => watchMock(...args),
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: any[]) => readFileMock(...args),
  stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
}));

vi.mock("./codex-cli-watcher.js", () => ({
  createCliProcessManager: () => mockCliManager,
}));

// Import after mocks
const { runCodexWithAutoRestart } = await import("./codex-cli-runner.js");

describe("codex-cli-runner", () => {
  let mockProcesses: ReturnType<typeof createMockChildProcess>[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockProcesses = [];
    nextPid = 12345;
    watchCallback = null;

    spawnMock = vi.fn(() => {
      const p = createMockChildProcess(nextPid++);
      mockProcesses.push(p);
      return p;
    });

    watchMock = vi.fn((_path: string, _opts: any, cb: Function) => {
      watchCallback = cb as any;
      return {
        close: vi.fn(),
        on: vi.fn(),
      };
    });

    // Default: auth file reads return different hashes on each call
    let callCount = 0;
    readFileMock = vi.fn(async () => {
      callCount++;
      return JSON.stringify({ token: `token-${callCount}` });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await vi.advanceTimersByTimeAsync(10);

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

    await vi.advanceTimersByTimeAsync(10);
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

    await vi.advanceTimersByTimeAsync(10);
    expect(mockProcesses).toHaveLength(1);

    // Trigger auth file change
    watchCallback?.("change", "auth.json");

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(200);

    // Old process should receive SIGTERM
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGTERM");

    // Simulate the old process exiting after SIGTERM
    mockProcesses[0]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(100);

    // New process should have been spawned
    expect(mockProcesses).toHaveLength(2);

    // Clean up — exit the new process
    mockProcesses[1]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(500);

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

    await vi.advanceTimersByTimeAsync(10);

    // First restart
    watchCallback?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(100);
    mockProcesses[0]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(600);

    // Second restart
    watchCallback?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(100);
    mockProcesses[1]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(600);

    // Exit naturally
    mockProcesses[2]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(500);

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

    await vi.advanceTimersByTimeAsync(10);

    // Fire 4 rapid watch events
    watchCallback?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(50);
    watchCallback?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(50);
    watchCallback?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(50);
    watchCallback?.("change", "auth.json");

    // Advance past debounce from last event
    await vi.advanceTimersByTimeAsync(400);

    // Should only have killed the process once
    expect(mockProcesses[0].kill).toHaveBeenCalledTimes(1);

    // Simulate exit + cleanup
    mockProcesses[0]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(200);
    mockProcesses[1]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.restartCount).toBe(1);
  });

  it("falls back to polling when fs.watch fails", async () => {
    watchMock = vi.fn(() => {
      throw new Error("fs.watch not supported");
    });

    const promise = runCodexWithAutoRestart({
      codexArgs: [],
      debounceMs: 50,
      stderr: mockStderr,
      cliManager: mockCliManager as any,
      debugLog: () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(mockProcesses).toHaveLength(1);

    // Polling interval is 3000ms — advance past it
    await vi.advanceTimersByTimeAsync(3500);

    // The poll should have checked the auth file
    expect(readFileMock).toHaveBeenCalled();

    // Clean up
    mockProcesses[mockProcesses.length - 1]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(500);
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

    await vi.advanceTimersByTimeAsync(10);

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

    await vi.advanceTimersByTimeAsync(10);
    expect(mockProcesses).toHaveLength(1);

    // Abort
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);

    // The child should have been killed
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGTERM");

    mockProcesses[0]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(200);

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

    await vi.advanceTimersByTimeAsync(10);

    // Make the process ignore SIGTERM (exitCode stays null)
    mockProcesses[0].kill.mockImplementation(() => {
      // Don't actually exit — simulates a hung process
    });

    // Trigger auth change
    watchCallback?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(100); // past debounce

    // SIGTERM sent
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGTERM");

    // Advance past killTimeout
    await vi.advanceTimersByTimeAsync(600);

    // SIGKILL should have been sent
    expect(mockProcesses[0].kill).toHaveBeenCalledWith("SIGKILL");

    // Simulate final exit
    mockProcesses[0]._simulateExit(137);
    await vi.advanceTimersByTimeAsync(200);

    // New process spawned
    expect(mockProcesses.length).toBeGreaterThanOrEqual(2);

    // Exit the new one
    mockProcesses[mockProcesses.length - 1]._simulateExit(0);
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.restartCount).toBeGreaterThanOrEqual(1);
  });
});
