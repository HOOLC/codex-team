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
  launch: (appPath: string) => Promise<void>;
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
    isRunningInsideDesktopShell: overrides.isRunningInsideDesktopShell ?? (async () => false),
    applyManagedSwitch: overrides.applyManagedSwitch ?? (async () => false),
    watchManagedQuotaSignals: overrides.watchManagedQuotaSignals ?? (async () => undefined),
  };
}

export function createInteractiveStdin(): NodeJS.ReadStream & {
  emitInput: (value: string) => void;
  pauseCalls: number;
  resumeCalls: number;
} {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    emitInput: (value: string) => void;
    pauseCalls: number;
    resumeCalls: number;
  };

  stream.isTTY = true;
  stream.pauseCalls = 0;
  stream.resumeCalls = 0;

  const originalPause = stream.pause.bind(stream);
  stream.pause = (() => {
    stream.pauseCalls += 1;
    return originalPause();
  }) as typeof stream.pause;

  const originalResume = stream.resume.bind(stream);
  stream.resume = (() => {
    stream.resumeCalls += 1;
    return originalResume();
  }) as typeof stream.resume;

  stream.emitInput = (value: string) => {
    stream.write(value);
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
