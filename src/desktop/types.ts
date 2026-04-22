export interface ExecFileLike {
  (
    file: string,
    args?: readonly string[],
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface RunningCodexDesktop {
  pid: number;
  command: string;
}

export interface ManagedCodexDesktopState {
  pid: number;
  app_path: string;
  remote_debugging_port: number;
  managed_by_codexm: true;
  started_at: string;
  desktop_api_base_url?: string | null;
}

export interface ManagedQuotaSignal {
  requestId: string;
  url: string;
  status: number | null;
  reason: "rpc_response" | "rpc_notification";
  bodySnippet: string | null;
  shouldAutoSwitch: boolean;
  quota: RuntimeQuotaSnapshot | null;
}

export interface ManagedWatchActivitySignal {
  requestId: string;
  method: string;
  reason: "quota_dirty" | "turn_completed";
  bodySnippet: string | null;
}

export interface ManagedWatchStatusEvent {
  type: "disconnected" | "reconnected";
  attempt: number;
  error: string | null;
}

export interface RuntimeQuotaSnapshot {
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
}

export interface RuntimeAccountSnapshot {
  auth_mode: string | null;
  email: string | null;
  plan_type: string | null;
  requires_openai_auth: boolean | null;
}

export type RuntimeReadSource = "desktop" | "direct";

export interface RuntimeReadResult<TSnapshot> {
  snapshot: TSnapshot;
  source: RuntimeReadSource;
}

export type ManagedCurrentQuotaSnapshot = RuntimeQuotaSnapshot;
export type ManagedCurrentAccountSnapshot = RuntimeAccountSnapshot;

export interface CodexDesktopLauncher {
  findInstalledApp(): Promise<string | null>;
  listRunningApps(): Promise<RunningCodexDesktop[]>;
  isRunningInsideDesktopShell(): Promise<boolean>;
  quitRunningApps(options?: { force?: boolean }): Promise<void>;
  launch(appPath: string, options?: {
    apiBaseUrl?: string | null;
  }): Promise<void>;
  activateApp(appPath: string): Promise<void>;
  readManagedState(): Promise<ManagedCodexDesktopState | null>;
  writeManagedState(state: ManagedCodexDesktopState): Promise<void>;
  clearManagedState(): Promise<void>;
  isManagedDesktopRunning(): Promise<boolean>;
  readDirectRuntimeAccount(): Promise<RuntimeAccountSnapshot | null>;
  readDirectRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null>;
  readCurrentRuntimeAccountResult(): Promise<RuntimeReadResult<RuntimeAccountSnapshot> | null>;
  readCurrentRuntimeQuotaResult(): Promise<RuntimeReadResult<RuntimeQuotaSnapshot> | null>;
  readCurrentRuntimeAccount(): Promise<RuntimeAccountSnapshot | null>;
  readCurrentRuntimeQuota(): Promise<RuntimeQuotaSnapshot | null>;
  readManagedCurrentAccount(): Promise<RuntimeAccountSnapshot | null>;
  readManagedCurrentQuota(): Promise<RuntimeQuotaSnapshot | null>;
  refreshManagedAccountSurface(): Promise<boolean>;
  applyManagedSwitch(options?: {
    force?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean>;
  watchManagedQuotaSignals(options?: {
    signal?: AbortSignal;
    debugLogger?: (line: string) => void;
    onQuotaSignal?: (signal: ManagedQuotaSignal) => Promise<void> | void;
    onActivitySignal?: (signal: ManagedWatchActivitySignal) => Promise<void> | void;
    onStatus?: (event: ManagedWatchStatusEvent) => Promise<void> | void;
  }): Promise<void>;
}
