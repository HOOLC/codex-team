import { spawn as spawnCallback } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface WatchProcessState {
  pid: number;
  started_at: string;
  log_path: string;
  auto_switch: boolean;
  debug: boolean;
}

export interface WatchProcessManager {
  startDetached(options: {
    autoSwitch: boolean;
    debug: boolean;
  }): Promise<WatchProcessState>;
  getStatus(): Promise<{
    running: boolean;
    state: WatchProcessState | null;
  }>;
  stop(): Promise<{
    running: boolean;
    state: WatchProcessState | null;
    stopped: boolean;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWatchProcessState(raw: string): WatchProcessState | null {
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
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.started_at !== "string" ||
    parsed.started_at.trim() === "" ||
    typeof parsed.log_path !== "string" ||
    parsed.log_path.trim() === "" ||
    typeof parsed.auto_switch !== "boolean" ||
    typeof parsed.debug !== "boolean"
  ) {
    return null;
  }

  return {
    pid: parsed.pid,
    started_at: parsed.started_at,
    log_path: parsed.log_path,
    auto_switch: parsed.auto_switch,
    debug: parsed.debug,
  };
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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return nodeError.code === "EPERM";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWatchProcessManager(codexTeamDir: string): WatchProcessManager {
  const statePath = join(codexTeamDir, "watch-state.json");
  const logsDir = join(codexTeamDir, "logs");
  const logPath = join(logsDir, "watch.log");

  async function readState(): Promise<WatchProcessState | null> {
    try {
      return parseWatchProcessState(await readFile(statePath, "utf8"));
    } catch {
      return null;
    }
  }

  async function writeState(state: WatchProcessState): Promise<void> {
    await ensureDirectory(codexTeamDir);
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async function clearState(): Promise<void> {
    await ensureDirectory(codexTeamDir);
    await writeFile(statePath, "", { mode: 0o600 });
  }

  async function getStatus(): Promise<{ running: boolean; state: WatchProcessState | null }> {
    const state = await readState();
    if (!state) {
      return {
        running: false,
        state: null,
      };
    }

    if (!isProcessRunning(state.pid)) {
      await clearState();
      return {
        running: false,
        state: null,
      };
    }

    return {
      running: true,
      state,
    };
  }

  async function startDetached(options: {
    autoSwitch: boolean;
    debug: boolean;
  }): Promise<WatchProcessState> {
    const status = await getStatus();
    if (status.running) {
      throw new Error(`Background watch is already running (pid ${status.state?.pid}).`);
    }

    const cliEntryPath = process.argv[1];
    if (typeof cliEntryPath !== "string" || cliEntryPath.trim() === "") {
      throw new Error("Failed to resolve the codexm CLI entrypoint for detached watch.");
    }

    await ensureDirectory(logsDir);
    const outputFd = openSync(logPath, "a");

    try {
      const args = [
        cliEntryPath,
        "watch",
        ...(options.autoSwitch ? ["--auto-switch"] : []),
        ...(options.debug ? ["--debug"] : []),
      ];

      const child = spawnCallback(process.execPath, args, {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", outputFd, outputFd],
        env: process.env,
      });

      child.unref();

      const state: WatchProcessState = {
        pid: child.pid ?? 0,
        started_at: new Date().toISOString(),
        log_path: logPath,
        auto_switch: options.autoSwitch,
        debug: options.debug,
      };

      if (!state.pid) {
        throw new Error("Failed to start detached watch process.");
      }

      await writeState(state);
      return state;
    } finally {
      closeSync(outputFd);
    }
  }

  async function stop(): Promise<{
    running: boolean;
    state: WatchProcessState | null;
    stopped: boolean;
  }> {
    const status = await getStatus();
    if (!status.running || !status.state) {
      return {
        running: false,
        state: null,
        stopped: false,
      };
    }

    process.kill(status.state.pid, "SIGTERM");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isProcessRunning(status.state.pid)) {
        await clearState();
        return {
          running: false,
          state: status.state,
          stopped: true,
        };
      }

      await delay(100);
    }

    process.kill(status.state.pid, "SIGKILL");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isProcessRunning(status.state.pid)) {
        await clearState();
        return {
          running: false,
          state: status.state,
          stopped: true,
        };
      }

      await delay(100);
    }

    throw new Error(`Timed out waiting for background watch process ${status.state.pid} to stop.`);
  }

  return {
    startDetached,
    getStatus,
    stop,
  };
}
