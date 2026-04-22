import { spawn as spawnCallback } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { resolveDaemonLogPath, resolveLogsDir } from "../logging.js";
import { isProcessRunning } from "./state.js";

interface DetachedAuthRefreshState {
  pid: number;
  started_at: string;
}

function resolveStatePath(codexTeamDir: string): string {
  return join(codexTeamDir, "auth-refresh-worker.json");
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, { mode: 0o600 });
  await rename(tempPath, path);
}

async function readState(codexTeamDir: string): Promise<DetachedAuthRefreshState | null> {
  try {
    const parsed = JSON.parse(await readFile(resolveStatePath(codexTeamDir), "utf8")) as Partial<DetachedAuthRefreshState>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.started_at !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      started_at: parsed.started_at,
    };
  } catch {
    return null;
  }
}

export async function triggerDetachedAuthRefresh(options: {
  codexTeamDir: string;
  debug: boolean;
}): Promise<void> {
  try {
    const existing = await readState(options.codexTeamDir);
    if (existing && isProcessRunning(existing.pid)) {
      return;
    }

    const cliEntryPath = process.argv[1];
    if (typeof cliEntryPath !== "string" || cliEntryPath.trim() === "") {
      return;
    }

    const logsDir = resolveLogsDir(options.codexTeamDir);
    const logPath = resolveDaemonLogPath(options.codexTeamDir);
    await ensureDirectory(logsDir);
    const outputFd = openSync(logPath, "a");

    try {
      const child = spawnCallback(process.execPath, [
        cliEntryPath,
        "daemon",
        "refresh-auth-once",
        ...(options.debug ? ["--debug"] : []),
      ], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", outputFd, outputFd],
        env: process.env,
      });
      child.unref();
      if (!child.pid) {
        return;
      }

      await atomicWriteFile(resolveStatePath(options.codexTeamDir), `${JSON.stringify({
        pid: child.pid,
        started_at: new Date().toISOString(),
      }, null, 2)}\n`);
    } finally {
      closeSync(outputFd);
    }
  } catch {
    // Keep detached auth-refresh triggering best-effort.
    return;
  }
}
