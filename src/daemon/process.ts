import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  appendEventLog,
  buildEventPayload,
  resolveDaemonLogPath,
  resolveLogsDir,
  rotatePlainLog,
  shortenErrorMessage,
} from "../logging.js";
import {
  defaultDaemonState,
  isProcessRunning,
  readDaemonState,
  writeDaemonState,
  type DaemonProcessState,
  type DaemonStatus,
} from "./state.js";
export type { DaemonProcessState, DaemonStatus } from "./state.js";

const execFile = promisify(execFileCallback);

type ExecFileLike = (
  file: string,
  args?: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;
type SpawnLike = typeof spawnCallback;

export interface StaleDaemonPortConflict {
  host: string;
  port: number;
  pid: number;
  command: string;
  kind: "daemon" | "proxy";
}

export class StaleDaemonProcessError extends Error {
  readonly conflict: StaleDaemonPortConflict;

  constructor(conflict: StaleDaemonPortConflict) {
    super(
      `Detected stale codexm ${conflict.kind} process on ${conflict.host}:${conflict.port} (pid ${conflict.pid}): ${shortenErrorMessage(conflict.command)}. Stop it and retry, or run "kill ${conflict.pid}".`,
    );
    this.name = "StaleDaemonProcessError";
    this.conflict = conflict;
  }
}

function detectStaleCodexmServeKind(command: string): "daemon" | "proxy" | null {
  const normalized = command.toLowerCase();
  const looksLikeCodexmCli =
    normalized.includes("codexm")
    || normalized.includes("cli.js")
    || normalized.includes("cli.cjs");

  if (!looksLikeCodexmCli) {
    return null;
  }

  if (normalized.includes(" proxy serve")) {
    return "proxy";
  }

  if (normalized.includes(" daemon serve")) {
    return "daemon";
  }

  return null;
}

export interface DaemonProcessManager {
  ensureConfig(config: Omit<DaemonProcessState, "pid" | "started_at" | "log_path" | "base_url" | "openai_base_url"> & {
    base_url?: string;
    openai_base_url?: string;
  }): Promise<{ action: "started" | "restarted" | "reused"; state: DaemonProcessState }>;
  getStatus(): Promise<DaemonStatus>;
  stop(): Promise<{
    running: boolean;
    state: DaemonProcessState | null;
    stopped: boolean;
  }>;
}

async function readProcessCommand(
  execFileImpl: ExecFileLike,
  pid: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl("ps", ["-o", "command=", "-p", String(pid)]);
    const line = stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find((entry) => entry !== "");
    return line ?? null;
  } catch {
    return null;
  }
}

async function isProcessAlive(execFileImpl: ExecFileLike, pid: number): Promise<boolean> {
  if (pid <= 0) {
    return false;
  }

  try {
    const { stdout } = await execFileImpl("ps", ["-o", "pid=", "-p", String(pid)]);
    return stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .some((entry) => entry === String(pid));
  } catch {
    return false;
  }
}

export async function findStaleDaemonPortConflict(options: {
  host: string;
  port: number;
  execFileImpl?: ExecFileLike;
}): Promise<StaleDaemonPortConflict | null> {
  const execFileImpl = options.execFileImpl ?? execFile;

  try {
    const { stdout } = await execFileImpl("lsof", [
      "-nP",
      "-Fp",
      `-iTCP:${options.port}`,
      "-sTCP:LISTEN",
    ]);
    const pid = stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith("p"))
      ?.slice(1);
    if (!pid) {
      return null;
    }

    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) {
      return null;
    }

    const command = await readProcessCommand(execFileImpl, numericPid);
    if (!command) {
      return null;
    }

    const kind = detectStaleCodexmServeKind(command);
    if (!kind) {
      return null;
    }

    return {
      host: options.host,
      port: options.port,
      pid: numericPid,
      command,
      kind,
    };
  } catch {
    return null;
  }
}

export async function cleanupStaleDaemonPortConflict(
  conflict: StaleDaemonPortConflict,
  execFileImpl: ExecFileLike = execFile,
): Promise<void> {
  if (!await isProcessAlive(execFileImpl, conflict.pid)) {
    return;
  }

  await execFileImpl("kill", ["-TERM", String(conflict.pid)]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!await isProcessAlive(execFileImpl, conflict.pid)) {
      return;
    }
    await delay(100);
  }

  await execFileImpl("kill", ["-KILL", String(conflict.pid)]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!await isProcessAlive(execFileImpl, conflict.pid)) {
      return;
    }
    await delay(100);
  }

  throw new Error(
    `Timed out waiting for stale codexm ${conflict.kind} process ${conflict.pid} to stop.`,
  );
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLastLogLine(path: string): Promise<string | null> {
  try {
    const contents = await readFile(path, "utf8");
    const lastLine = contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1);
    return lastLine ? shortenErrorMessage(lastLine) : null;
  } catch {
    return null;
  }
}

function configsMatch(left: DaemonProcessState, right: DaemonProcessState): boolean {
  return (
    left.stayalive === right.stayalive &&
    left.watch === right.watch &&
    left.auto_switch === right.auto_switch &&
    left.proxy === right.proxy &&
    left.host === right.host &&
    left.port === right.port &&
    left.base_url === right.base_url &&
    left.openai_base_url === right.openai_base_url &&
    left.debug === right.debug
  );
}

function buildServeArgs(state: DaemonProcessState): string[] {
  const features = [
    ...(state.stayalive ? ["stayalive"] : []),
    ...(state.watch ? ["watch"] : []),
    ...(state.auto_switch ? ["auto-switch"] : []),
    ...(state.proxy ? ["proxy"] : []),
  ];
  return [
    "daemon",
    "serve",
    ...features,
    "--host",
    state.host,
    "--port",
    String(state.port),
    ...(state.debug ? ["--debug"] : []),
  ];
}

export function createDaemonProcessManager(
  codexTeamDir: string,
  options: {
    execFileImpl?: ExecFileLike;
    spawnImpl?: SpawnLike;
  } = {},
): DaemonProcessManager {
  const logsDir = resolveLogsDir(codexTeamDir);
  const logPath = resolveDaemonLogPath(codexTeamDir);
  const execFileImpl = options.execFileImpl ?? execFile;
  const spawnImpl = options.spawnImpl ?? spawnCallback;

  async function getStatus(): Promise<DaemonStatus> {
    const state = await readDaemonState(codexTeamDir);
    if (!state || !isProcessRunning(state.pid)) {
      return {
        running: false,
        state,
      };
    }

    return {
      running: true,
      state,
    };
  }

  async function startDetached(nextState: DaemonProcessState): Promise<DaemonProcessState> {
    const cliEntryPath = process.argv[1];
    if (typeof cliEntryPath !== "string" || cliEntryPath.trim() === "") {
      throw new Error("Failed to resolve the codexm CLI entrypoint for the daemon.");
    }

    if (nextState.proxy) {
      const conflict = await findStaleDaemonPortConflict({
        host: nextState.host,
        port: nextState.port,
        execFileImpl,
      });
      if (conflict) {
        throw new StaleDaemonProcessError(conflict);
      }
    }

    await ensureDirectory(logsDir);
    await rotatePlainLog(logPath);
    const outputFd = openSync(logPath, "a");

    try {
      const child = spawnImpl(process.execPath, [cliEntryPath, ...buildServeArgs(nextState)], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", outputFd, outputFd],
        env: process.env,
      });
      child.unref();

      if (!child.pid) {
        throw new Error("Failed to start daemon process.");
      }

      const state: DaemonProcessState = {
        ...nextState,
        pid: child.pid,
        started_at: new Date().toISOString(),
        log_path: logPath,
      };
      await delay(200);
      if (!isProcessRunning(child.pid)) {
        await writeDaemonState(codexTeamDir, {
          ...nextState,
          pid: 0,
          started_at: "",
          log_path: logPath,
        });
        const lastLogLine = await readLastLogLine(logPath);
        throw new Error(
          lastLogLine
            ? `Daemon failed to start: ${lastLogLine}`
            : "Daemon failed to start: process exited before becoming ready.",
        );
      }
      await writeDaemonState(codexTeamDir, state);
      await appendEventLog(codexTeamDir, buildEventPayload({
        component: "daemon",
        event: "daemon.start",
        trigger: "cli",
        fields: {
          stayalive: state.stayalive,
          watch: state.watch,
          auto_switch: state.auto_switch,
          proxy: state.proxy,
          host: state.host,
          port: state.port,
          log_path: state.log_path,
        },
      }));
      return state;
    } finally {
      closeSync(outputFd);
    }
  }

  async function stop(): Promise<{
    running: boolean;
    state: DaemonProcessState | null;
    stopped: boolean;
  }> {
    const status = await getStatus();
    if (!status.running || !status.state) {
      return {
        running: false,
        state: status.state,
        stopped: false,
      };
    }

    process.kill(status.state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isProcessRunning(status.state.pid)) {
        await writeDaemonState(codexTeamDir, {
          ...status.state,
          pid: 0,
          started_at: "",
        });
        await appendEventLog(codexTeamDir, buildEventPayload({
          component: "daemon",
          event: "daemon.stop",
          trigger: "cli",
          fields: { pid: status.state.pid },
        }));
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
        await writeDaemonState(codexTeamDir, {
          ...status.state,
          pid: 0,
          started_at: "",
        });
        await appendEventLog(codexTeamDir, buildEventPayload({
          component: "daemon",
          event: "daemon.stop",
          trigger: "cli",
          fields: { pid: status.state.pid, forced: true },
        }));
        return {
          running: false,
          state: status.state,
          stopped: true,
        };
      }
      await delay(100);
    }

    throw new Error(`Timed out waiting for daemon ${status.state.pid} to stop.`);
  }

  async function ensureConfig(
    config: Omit<DaemonProcessState, "pid" | "started_at" | "log_path" | "base_url" | "openai_base_url"> & {
      base_url?: string;
      openai_base_url?: string;
    },
  ): Promise<{ action: "started" | "restarted" | "reused"; state: DaemonProcessState }> {
    const currentState = (await getStatus()).state ?? defaultDaemonState(codexTeamDir);
    const nextState: DaemonProcessState = {
      ...currentState,
      ...config,
      log_path: logPath,
      pid: 0,
      started_at: "",
    };

    if (!nextState.stayalive && !nextState.watch && !nextState.proxy) {
      await stop();
      const stoppedState = {
        ...nextState,
        pid: 0,
        started_at: "",
      };
      await writeDaemonState(codexTeamDir, stoppedState);
      return {
        action: "reused",
        state: stoppedState,
      };
    }

    const status = await getStatus();
    if (status.running && status.state && configsMatch(status.state, nextState)) {
      return {
        action: "reused",
        state: status.state,
      };
    }

    if (status.running && status.state) {
      try {
        await appendEventLog(codexTeamDir, buildEventPayload({
          component: "daemon",
          event: "daemon.config_changed",
          trigger: "cli",
          fields: {
            from: {
              stayalive: status.state.stayalive,
              watch: status.state.watch,
              auto_switch: status.state.auto_switch,
              proxy: status.state.proxy,
              host: status.state.host,
              port: status.state.port,
              debug: status.state.debug,
            },
            to: {
              stayalive: nextState.stayalive,
              watch: nextState.watch,
              auto_switch: nextState.auto_switch,
              proxy: nextState.proxy,
              host: nextState.host,
              port: nextState.port,
              debug: nextState.debug,
            },
          },
        }));
      } catch {
        // Best-effort event logging.
      }
      await stop();
      return {
        action: "restarted",
        state: await startDetached(nextState),
      };
    }

    try {
      return {
        action: "started",
        state: await startDetached(nextState),
      };
    } catch (error) {
      await appendEventLog(codexTeamDir, buildEventPayload({
        component: "daemon",
        event: "daemon.crash",
        trigger: "cli",
        level: "error",
        errorMessageShort: shortenErrorMessage((error as Error).message),
      }));
      throw error;
    }
  }

  return {
    ensureConfig,
    getStatus,
    stop,
  };
}
