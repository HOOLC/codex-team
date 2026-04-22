import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type {
  ManagedCurrentAccountSnapshot,
  CodexDesktopLauncher,
  ManagedCurrentQuotaSnapshot,
  ManagedCodexDesktopState,
  RuntimeAccountSnapshot,
  RuntimeQuotaSnapshot,
  RuntimeReadResult,
  RunningCodexDesktop,
} from "../src/desktop/launcher.js";
import type { DaemonProcessManager, DaemonProcessState } from "../src/daemon/process.js";
import type { WatchProcessManager, WatchProcessState } from "../src/watch/process.js";

export function captureWritable(): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => output,
  };
}

export function createDesktopLauncherStub(overrides: Partial<{
  findInstalledApp: () => Promise<string | null>;
  listRunningApps: () => Promise<RunningCodexDesktop[]>;
  quitRunningApps: (options?: { force?: boolean }) => Promise<void>;
  launch: (appPath: string, options?: { apiBaseUrl?: string | null }) => Promise<void>;
  activateApp: (appPath: string) => Promise<void>;
  writeManagedState: (state: ManagedCodexDesktopState) => Promise<void>;
  readManagedState: () => Promise<ManagedCodexDesktopState | null>;
  clearManagedState: () => Promise<void>;
  isManagedDesktopRunning: () => Promise<boolean>;
  readDirectRuntimeAccount: () => Promise<RuntimeAccountSnapshot | null>;
  readDirectRuntimeQuota: () => Promise<RuntimeQuotaSnapshot | null>;
  readCurrentRuntimeAccountResult: () => Promise<RuntimeReadResult<RuntimeAccountSnapshot> | null>;
  readCurrentRuntimeQuotaResult: () => Promise<RuntimeReadResult<RuntimeQuotaSnapshot> | null>;
  readCurrentRuntimeAccount: () => Promise<RuntimeAccountSnapshot | null>;
  readCurrentRuntimeQuota: () => Promise<RuntimeQuotaSnapshot | null>;
  readManagedCurrentAccount: () => Promise<ManagedCurrentAccountSnapshot | null>;
  readManagedCurrentQuota: () => Promise<ManagedCurrentQuotaSnapshot | null>;
  refreshManagedAccountSurface: () => Promise<boolean>;
  isRunningInsideDesktopShell: () => Promise<boolean>;
  applyManagedSwitch: (options?: {
    force?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  watchManagedQuotaSignals: (options?: {
    signal?: AbortSignal;
    debugLogger?: (line: string) => void;
    onStatus?: (event: {
      type: "disconnected" | "reconnected";
      attempt: number;
      error: string | null;
    }) => Promise<void> | void;
    onQuotaSignal?: (signal: {
      requestId: string;
      url: string;
      status: number | null;
      reason: string;
      bodySnippet: string | null;
      shouldAutoSwitch: boolean;
      quota?: {
        plan_type: string | null;
        credits_balance: number | null;
        unlimited: boolean;
        five_hour: {
          used_percent: number;
          window_seconds: number;
          reset_at: string | null;
        } | null;
        one_week: {
          used_percent: number;
          window_seconds: number;
          reset_at: string | null;
        } | null;
        fetched_at: string;
      } | null;
    }) => Promise<void> | void;
    onActivitySignal?: (signal: {
      requestId: string;
      method: string;
      reason: "quota_dirty" | "turn_completed";
      bodySnippet: string | null;
    }) => Promise<void> | void;
  }) => Promise<void>;
}> = {}): CodexDesktopLauncher {
  return {
    findInstalledApp: overrides.findInstalledApp ?? (async () => "/Applications/Codex.app"),
    listRunningApps: overrides.listRunningApps ?? (async () => []),
    quitRunningApps: overrides.quitRunningApps ?? (async () => undefined),
    launch:
      overrides.launch ??
      (async () => undefined),
    activateApp:
      overrides.activateApp ??
      (async () => undefined),
    writeManagedState: overrides.writeManagedState ?? (async () => undefined),
    readManagedState: overrides.readManagedState ?? (async () => null),
    clearManagedState: overrides.clearManagedState ?? (async () => undefined),
    isManagedDesktopRunning: overrides.isManagedDesktopRunning ?? (async () => false),
    readDirectRuntimeAccount:
      overrides.readDirectRuntimeAccount
      ?? overrides.readCurrentRuntimeAccount
      ?? overrides.readManagedCurrentAccount
      ?? (async () => null),
    readDirectRuntimeQuota:
      overrides.readDirectRuntimeQuota
      ?? overrides.readCurrentRuntimeQuota
      ?? overrides.readManagedCurrentQuota
      ?? (async () => null),
    readCurrentRuntimeAccountResult:
      overrides.readCurrentRuntimeAccountResult
      ?? (async () => {
        const snapshot =
          (await (overrides.readCurrentRuntimeAccount ?? overrides.readManagedCurrentAccount)?.())
          ?? null;
        return snapshot
          ? {
              snapshot,
              source: "desktop",
            }
          : null;
      }),
    readCurrentRuntimeQuotaResult:
      overrides.readCurrentRuntimeQuotaResult
      ?? (async () => {
        const snapshot =
          (await (overrides.readCurrentRuntimeQuota ?? overrides.readManagedCurrentQuota)?.())
          ?? null;
        return snapshot
          ? {
              snapshot,
              source: "desktop",
            }
          : null;
      }),
    readCurrentRuntimeAccount:
      overrides.readCurrentRuntimeAccount
      ?? overrides.readManagedCurrentAccount
      ?? (async () => null),
    readCurrentRuntimeQuota:
      overrides.readCurrentRuntimeQuota
      ?? overrides.readManagedCurrentQuota
      ?? (async () => null),
    readManagedCurrentAccount: overrides.readManagedCurrentAccount ?? (async () => null),
    readManagedCurrentQuota: overrides.readManagedCurrentQuota ?? (async () => null),
    refreshManagedAccountSurface:
      overrides.refreshManagedAccountSurface ?? (async () => false),
    isRunningInsideDesktopShell: overrides.isRunningInsideDesktopShell ?? (async () => false),
    applyManagedSwitch: overrides.applyManagedSwitch ?? (async () => false),
    watchManagedQuotaSignals: overrides.watchManagedQuotaSignals ?? (async () => undefined),
  };
}

export function createInteractiveStdin(): NodeJS.ReadStream & {
  emitInput: (value: string) => void;
  emitKeypress: (value: string, key?: Record<string, unknown>) => void;
  pauseCalls: number;
  resumeCalls: number;
  rawModeCalls: boolean[];
  isRaw: boolean;
  setRawMode: (raw: boolean) => NodeJS.ReadStream;
} {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    emitInput: (value: string) => void;
    emitKeypress: (value: string, key?: Record<string, unknown>) => void;
    pauseCalls: number;
    resumeCalls: number;
    rawModeCalls: boolean[];
    isRaw: boolean;
    setRawMode: (raw: boolean) => NodeJS.ReadStream;
  };

  stream.isTTY = true;
  stream.pauseCalls = 0;
  stream.resumeCalls = 0;
  stream.rawModeCalls = [];
  stream.isRaw = false;
  const originalPause = stream.pause.bind(stream);
  const originalResume = stream.resume.bind(stream);

  stream.pause = (() => {
    stream.pauseCalls += 1;
    return originalPause();
  }) as typeof stream.pause;
  stream.resume = (() => {
    stream.resumeCalls += 1;
    return originalResume();
  }) as typeof stream.resume;

  stream.setRawMode = ((raw: boolean) => {
    stream.rawModeCalls.push(raw);
    stream.isRaw = raw;
    return stream;
  }) as typeof stream.setRawMode;

  stream.emitInput = (value: string) => {
    stream.write(value);
  };
  stream.emitKeypress = (value: string, key?: Record<string, unknown>) => {
    stream.emit("keypress", value, key);
  };

  return stream;
}

export function createInteractiveStdout(
  columns = 120,
  rows = 32,
): NodeJS.WriteStream & {
  read: () => string;
  emitResize: (nextColumns: number, nextRows: number) => void;
} {
  const stream = new EventEmitter() as NodeJS.WriteStream & {
    read: () => string;
    emitResize: (nextColumns: number, nextRows: number) => void;
  };
  let output = "";

  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  stream.write = ((chunk: string | Uint8Array) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  }) as typeof stream.write;
  stream.read = (() => output) as typeof stream.read;
  stream.emitResize = (nextColumns: number, nextRows: number) => {
    stream.columns = nextColumns;
    stream.rows = nextRows;
    stream.emit("resize");
  };

  return stream;
}

export function createWatchProcessManagerStub(overrides: Partial<{
  startDetached: (options: { autoSwitch: boolean; debug: boolean }) => Promise<WatchProcessState>;
  getStatus: () => Promise<{ running: boolean; state: WatchProcessState | null }>;
  stop: () => Promise<{ running: boolean; state: WatchProcessState | null; stopped: boolean }>;
}> = {}): WatchProcessManager {
  return {
    startDetached:
      overrides.startDetached ??
      (async () => ({
        pid: 43210,
        started_at: "2026-04-08T13:58:00.000Z",
        log_path: "/tmp/watch.log",
        auto_switch: false,
        debug: false,
      })),
    getStatus:
      overrides.getStatus ??
      (async () => ({
        running: false,
        state: null,
      })),
    stop:
      overrides.stop ??
      (async () => ({
        running: false,
        state: null,
        stopped: false,
      })),
  };
}

export function createDaemonProcessManagerStub(overrides: Partial<{
  getStatus: () => Promise<{ running: boolean; state: DaemonProcessState | null }>;
  ensureConfig: (config: Omit<DaemonProcessState, "pid" | "started_at" | "log_path" | "base_url" | "openai_base_url"> & {
    base_url?: string;
    openai_base_url?: string;
  }) => Promise<{ action: "started" | "restarted" | "reused"; state: DaemonProcessState }>;
  stop: () => Promise<{ running: boolean; state: DaemonProcessState | null; stopped: boolean }>;
}> = {}): DaemonProcessManager {
  const defaultState: DaemonProcessState = {
    pid: 54321,
    started_at: "2026-04-18T00:00:00.000Z",
    log_path: "/tmp/daemon.log",
    stayalive: true,
    watch: false,
    auto_switch: false,
    proxy: false,
    host: "127.0.0.1",
    port: 14555,
    base_url: "http://127.0.0.1:14555/backend-api",
    openai_base_url: "http://127.0.0.1:14555/v1",
    debug: false,
  };

  return {
    getStatus:
      overrides.getStatus ??
      (async () => ({
        running: false,
        state: null,
      })),
    ensureConfig:
      overrides.ensureConfig ??
      (async () => ({
        action: "started",
        state: defaultState,
      })),
    stop:
      overrides.stop ??
      (async () => ({
        running: false,
        state: null,
        stopped: false,
      })),
  };
}
