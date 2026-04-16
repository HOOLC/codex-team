import { randomUUID } from "node:crypto";
import { copyFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { type AccountStore, type ManagedAccount } from "../account-store/index.js";
import {
  DIRECTORY_MODE,
  FILE_MODE,
  atomicWriteFile,
  chmodIfPossible,
  ensureDirectory,
  pathExists,
} from "../account-store/storage.js";
import { toCliQuotaSummaryFromRuntimeQuota } from "../cli/quota.js";
import { createCodexDirectClient } from "../codex-direct-client.js";
import { createCliProcessManager } from "../watch/cli-watcher.js";
import { appendWatchQuotaHistory, createWatchHistoryStore } from "../watch/history.js";

const RUN_OVERLAYS_DIR_NAME = "run-overlays";
const OVERLAY_METADATA_FILE_NAME = "overlay.json";
const OVERLAY_STALE_TTL_MS = 24 * 60 * 60 * 1000;

interface OverlayMetadata {
  accountName: string;
  createdAt: string;
  pid: number;
  runId: string;
}

export interface PreparedIsolatedCodexRun {
  account: ManagedAccount;
  authFilePath: string;
  codexHomePath: string;
  env: NodeJS.ProcessEnv;
  runId: string;
  sessionsDirPath: string;
  cleanup(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isIsolatedTopLevelEntry(name: string): boolean {
  if (name === "auth.json" || name === "config.toml" || name === "cache" || name === "tmp") {
    return true;
  }

  return (
    /^state_.*\.sqlite(?:-(?:wal|shm))?$/u.test(name) ||
    /^logs_.*\.sqlite(?:-(?:wal|shm))?$/u.test(name)
  );
}

function symlinkTypeForEntry(entry: Dirent): "file" | "dir" | "junction" {
  if (entry.isDirectory()) {
    return process.platform === "win32" ? "junction" : "dir";
  }

  return "file";
}

function forceFileAuthStore(rawConfig: string | null): string {
  const filteredLines = (rawConfig ?? "")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*cli_auth_credentials_store\s*=/u.test(line));

  while (filteredLines.length > 0 && filteredLines.at(-1) === "") {
    filteredLines.pop();
  }

  filteredLines.push('cli_auth_credentials_store = "file"');
  return `${filteredLines.join("\n")}\n`;
}

async function readDirectoryEntries(path: string): Promise<Dirent[]> {
  try {
    return (await readdir(path, { withFileTypes: true })) as Dirent[];
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function removeDirectoryIfPresent(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

async function pruneStaleRunOverlays(baseDir: string): Promise<void> {
  const accountDirs = await readDirectoryEntries(baseDir);
  const now = Date.now();

  for (const accountDir of accountDirs) {
    if (!accountDir.isDirectory()) {
      continue;
    }

    const accountPath = join(baseDir, accountDir.name);
    const overlays = await readDirectoryEntries(accountPath);

    for (const overlay of overlays) {
      if (!overlay.isDirectory()) {
        continue;
      }

      const overlayPath = join(accountPath, overlay.name);
      const metadataPath = join(overlayPath, OVERLAY_METADATA_FILE_NAME);
      let metadata: OverlayMetadata | null = null;

      try {
        metadata = JSON.parse(await readFile(metadataPath, "utf8")) as OverlayMetadata;
      } catch {
        metadata = null;
      }

      const createdAtMs =
        metadata && Number.isFinite(Date.parse(metadata.createdAt))
          ? Date.parse(metadata.createdAt)
          : Number.NaN;
      const staleByAge =
        Number.isFinite(createdAtMs) && now - createdAtMs > OVERLAY_STALE_TTL_MS;
      const staleByPid =
        metadata !== null &&
        typeof metadata.pid === "number" &&
        Number.isInteger(metadata.pid) &&
        !isProcessAlive(metadata.pid);

      if (metadata === null || staleByAge || staleByPid) {
        await removeDirectoryIfPresent(overlayPath);
      }
    }
  }
}

async function linkSharedEntries(sourceCodexHome: string, targetCodexHome: string): Promise<void> {
  const entries = await readDirectoryEntries(sourceCodexHome);

  for (const entry of entries) {
    if (isIsolatedTopLevelEntry(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceCodexHome, entry.name);
    const targetPath = join(targetCodexHome, entry.name);
    await symlink(sourcePath, targetPath, symlinkTypeForEntry(entry));
  }
}

async function writeOverlayConfig(sourceConfigPath: string, targetConfigPath: string): Promise<void> {
  const rawConfig = (await pathExists(sourceConfigPath))
    ? await readFile(sourceConfigPath, "utf8")
    : null;
  await atomicWriteFile(targetConfigPath, forceFileAuthStore(rawConfig), FILE_MODE);
}

export async function prepareIsolatedCodexRun(options: {
  accountName: string;
  baseEnv?: NodeJS.ProcessEnv;
  store: AccountStore;
}): Promise<PreparedIsolatedCodexRun> {
  const account = await options.store.getManagedAccount(options.accountName);
  if (account.auth_mode !== "chatgpt") {
    throw new Error(
      `codexm run --account only supports chatgpt snapshots right now; "${account.name}" uses ${account.auth_mode}.`,
    );
  }

  const overlaysBaseDir = join(options.store.paths.codexTeamDir, RUN_OVERLAYS_DIR_NAME);
  await ensureDirectory(overlaysBaseDir, DIRECTORY_MODE);
  await pruneStaleRunOverlays(overlaysBaseDir);

  const runId = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const overlayDir = join(overlaysBaseDir, account.name, runId);
  await ensureDirectory(overlayDir, DIRECTORY_MODE);

  await linkSharedEntries(options.store.paths.codexDir, overlayDir);

  const authFilePath = join(overlayDir, "auth.json");
  await copyFile(account.authPath, authFilePath);
  await chmodIfPossible(authFilePath, FILE_MODE);

  const configPath = join(overlayDir, "config.toml");
  await writeOverlayConfig(options.store.paths.currentConfigPath, configPath);

  const metadata: OverlayMetadata = {
    accountName: account.name,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    runId,
  };
  await atomicWriteFile(
    join(overlayDir, OVERLAY_METADATA_FILE_NAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
    FILE_MODE,
  );

  const env: NodeJS.ProcessEnv = {
    ...(options.baseEnv ?? process.env),
    CODEX_HOME: overlayDir,
  };
  delete env.CODEX_SQLITE_HOME;

  return {
    account,
    authFilePath,
    codexHomePath: overlayDir,
    env,
    runId,
    sessionsDirPath: join(overlayDir, "sessions"),
    async cleanup() {
      await removeDirectoryIfPresent(overlayDir);
    },
  };
}

export function startIsolatedQuotaHistorySampler(options: {
  account: ManagedAccount;
  codexHomeEnv: NodeJS.ProcessEnv;
  pollIntervalMs: number;
  scopeId: string;
  store: AccountStore;
  debugLog?: (message: string) => void;
}): { stop(): Promise<void> } {
  const controller = new AbortController();
  const debugLog = options.debugLog ?? (() => undefined);
  const watchHistoryStore = createWatchHistoryStore(options.store.paths.codexTeamDir);
  const cliManager = createCliProcessManager({
    createDirectClientImpl: async () =>
      await createCodexDirectClient({
        env: options.codexHomeEnv,
      }),
  });

  const watchPromise = cliManager
    .watchCliQuotaSignals({
      pollIntervalMs: options.pollIntervalMs,
      signal: controller.signal,
      onStatus: async (event) => {
        debugLog(
          `run: isolated quota sampler ${event.type} attempt=${event.attempt} error=${event.error ?? "none"}`,
        );
      },
      onQuotaSignal: async (signal) => {
        if (!signal.quota) {
          return;
        }

        const quotaSummary = toCliQuotaSummaryFromRuntimeQuota(signal.quota);
        await appendWatchQuotaHistory(watchHistoryStore, {
          recordedAt: signal.quota.fetched_at ?? new Date().toISOString(),
          scopeKind: "isolated",
          scopeId: options.scopeId,
          accountName: options.account.name,
          accountId: options.account.account_id,
          identity: options.account.identity,
          planType: signal.quota.plan_type,
          available: quotaSummary.available,
          fiveHour: signal.quota.five_hour
            ? {
                usedPercent: signal.quota.five_hour.used_percent,
                windowSeconds: signal.quota.five_hour.window_seconds,
                resetAt: signal.quota.five_hour.reset_at ?? null,
              }
            : null,
          oneWeek: signal.quota.one_week
            ? {
                usedPercent: signal.quota.one_week.used_percent,
                windowSeconds: signal.quota.one_week.window_seconds,
                resetAt: signal.quota.one_week.reset_at ?? null,
              }
            : null,
        });
      },
    })
    .catch((error) => {
      if (!controller.signal.aborted) {
        debugLog(`run: isolated quota sampler failed: ${(error as Error).message}`);
      }
    });

  return {
    async stop() {
      controller.abort();
      await watchPromise;
    },
  };
}
