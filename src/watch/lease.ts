import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type WatchLeaseOwnerKind = "detached" | "tui-foreground";

export interface WatchLeaseState {
  owner_kind: WatchLeaseOwnerKind;
  pid: number;
  started_at: string;
  auto_switch: boolean;
  auto_switch_eta_hours: number | null;
  debug: boolean;
}

export interface WatchLeaseManager {
  getStatus(): Promise<{
    active: boolean;
    state: WatchLeaseState | null;
  }>;
  claimForeground(options: {
    autoSwitch: boolean;
    autoSwitchEtaHours: number | null;
    debug: boolean;
    pid?: number;
  }): Promise<{
    acquired: boolean;
    state: WatchLeaseState | null;
  }>;
  recordDetached(state: {
    pid: number;
    started_at: string;
    auto_switch: boolean;
    auto_switch_eta_hours: number | null;
    debug: boolean;
  }): Promise<void>;
  release(options: {
    ownerKind: WatchLeaseOwnerKind;
    pid: number;
  }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWatchLeaseState(raw: string): WatchLeaseState | null {
  if (raw.trim() === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (
    (parsed.owner_kind !== "detached" && parsed.owner_kind !== "tui-foreground")
    || typeof parsed.pid !== "number"
    || !Number.isInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.started_at !== "string"
    || parsed.started_at.trim() === ""
    || typeof parsed.auto_switch !== "boolean"
    || (parsed.auto_switch_eta_hours !== null
      && parsed.auto_switch_eta_hours !== undefined
      && (typeof parsed.auto_switch_eta_hours !== "number"
        || !Number.isFinite(parsed.auto_switch_eta_hours)
        || parsed.auto_switch_eta_hours <= 0))
    || typeof parsed.debug !== "boolean"
  ) {
    return null;
  }

  return {
    owner_kind: parsed.owner_kind,
    pid: parsed.pid,
    started_at: parsed.started_at,
    auto_switch: parsed.auto_switch,
    auto_switch_eta_hours:
      typeof parsed.auto_switch_eta_hours === "number"
        ? parsed.auto_switch_eta_hours
        : null,
    debug: parsed.debug,
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return nodeError.code === "EPERM";
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tempPath, content, { mode: 0o600 });
  await rename(tempPath, path);
}

export function createWatchLeaseManager(codexTeamDir: string): WatchLeaseManager {
  const statePath = join(codexTeamDir, "watch-lease.json");

  async function readState(): Promise<WatchLeaseState | null> {
    try {
      return parseWatchLeaseState(await readFile(statePath, "utf8"));
    } catch {
      return null;
    }
  }

  async function writeState(state: WatchLeaseState): Promise<void> {
    await ensureDirectory(codexTeamDir);
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async function clearState(): Promise<void> {
    await rm(statePath, { force: true });
  }

  async function tryCreateState(state: WatchLeaseState): Promise<boolean> {
    await ensureDirectory(codexTeamDir);
    try {
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  async function getStatus(): Promise<{ active: boolean; state: WatchLeaseState | null }> {
    const state = await readState();
    if (!state) {
      return {
        active: false,
        state: null,
      };
    }

    if (!isProcessRunning(state.pid)) {
      await clearState();
      return {
        active: false,
        state: null,
      };
    }

    return {
      active: true,
      state,
    };
  }

  async function claimForeground(options: {
    autoSwitch: boolean;
    autoSwitchEtaHours: number | null;
    debug: boolean;
    pid?: number;
  }): Promise<{ acquired: boolean; state: WatchLeaseState | null }> {
    const pid = options.pid ?? process.pid;
    const status = await getStatus();
    if (status.active && status.state) {
      if (status.state.owner_kind === "tui-foreground" && status.state.pid === pid) {
        return {
          acquired: true,
          state: status.state,
        };
      }

      return {
        acquired: false,
        state: status.state,
      };
    }

    const state: WatchLeaseState = {
      owner_kind: "tui-foreground",
      pid,
      started_at: new Date().toISOString(),
      auto_switch: options.autoSwitch,
      auto_switch_eta_hours: options.autoSwitchEtaHours,
      debug: options.debug,
    };
    if (await tryCreateState(state)) {
      return {
        acquired: true,
        state,
      };
    }

    const refreshedStatus = await getStatus();
    if (
      refreshedStatus.active
      && refreshedStatus.state
      && refreshedStatus.state.owner_kind === "tui-foreground"
      && refreshedStatus.state.pid === pid
    ) {
      return {
        acquired: true,
        state: refreshedStatus.state,
      };
    }

    return {
      acquired: false,
      state: refreshedStatus.state,
    };
  }

  async function recordDetached(state: {
    pid: number;
    started_at: string;
    auto_switch: boolean;
    auto_switch_eta_hours: number | null;
    debug: boolean;
  }): Promise<void> {
    await writeState({
      owner_kind: "detached",
      pid: state.pid,
      started_at: state.started_at,
      auto_switch: state.auto_switch,
      auto_switch_eta_hours: state.auto_switch_eta_hours,
      debug: state.debug,
    });
  }

  async function release(options: {
    ownerKind: WatchLeaseOwnerKind;
    pid: number;
  }): Promise<void> {
    const state = await readState();
    if (!state) {
      return;
    }

    if (state.owner_kind !== options.ownerKind || state.pid !== options.pid) {
      if (!isProcessRunning(state.pid)) {
        await clearState();
      }
      return;
    }

    await clearState();
  }

  return {
    getStatus,
    claimForeground,
    recordDetached,
    release,
  };
}
