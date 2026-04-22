import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import packageJson from "../package.json";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DAEMON_LOG_ROTATIONS = 5;
const EVENT_LOG_RETENTION_DAYS = 30;
const EVENT_LOG_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const PROXY_REQUEST_LOG_RETENTION_DAYS = 7;
const PROXY_REQUEST_LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const PROXY_ERROR_LOG_RETENTION_DAYS = 7;
const PROXY_ERROR_LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const CODEXM_VERSION = packageJson.version;
const CODEXM_LOG_BUILD_META_ENV = "CODEXM_LOG_BUILD_META";
const CODEXM_GIT_SHA_ENV = "CODEXM_GIT_SHA";

const cleanupTracker = new Map<string, number>();
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
let cachedBuildMetadataKey: string | null = null;
let cachedBuildMetadata: Record<string, unknown> = {};

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function ensureLogsDir(logsDir: string): Promise<void> {
  await mkdir(logsDir, { recursive: true, mode: DIRECTORY_MODE });
}

async function appendJsonLine(path: string, payload: unknown): Promise<void> {
  await ensureLogsDir(dirname(path));
  await appendFile(path, `${JSON.stringify(payload)}\n`, { mode: FILE_MODE });
}

function shouldLogBuildMetadata(): boolean {
  const raw = process.env[CODEXM_LOG_BUILD_META_ENV];
  return raw ? /^(1|true|yes|on)$/iu.test(raw) : false;
}

function resolveGitSha(): string | null {
  const override = process.env[CODEXM_GIT_SHA_ENV]?.trim();
  if (override) {
    return override;
  }

  try {
    const repoRoot = new URL("..", import.meta.url);
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha === "" ? null : sha;
  } catch {
    return null;
  }
}

function resolveCodexmBuildMetadata(): Record<string, unknown> {
  if (!shouldLogBuildMetadata()) {
    return {};
  }

  const gitSha = resolveGitSha();
  return gitSha ? { codexm_git_sha: gitSha } : {};
}

function getCodexmBuildMetadata(): Record<string, unknown> {
  const cacheKey = `${process.env[CODEXM_LOG_BUILD_META_ENV] ?? ""}\u0000${process.env[CODEXM_GIT_SHA_ENV] ?? ""}`;
  if (cacheKey === cachedBuildMetadataKey) {
    return cachedBuildMetadata;
  }
  cachedBuildMetadataKey = cacheKey;
  cachedBuildMetadata = resolveCodexmBuildMetadata();
  return cachedBuildMetadata;
}

function withCodexmVersion(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    codexm_version: CODEXM_VERSION,
    ...getCodexmBuildMetadata(),
  };
}

async function listMatchingFiles(logsDir: string, prefix: string): Promise<string[]> {
  try {
    const entries = await readdir(logsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => join(logsDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function cleanupPrefixedLogs(options: {
  logsDir: string;
  prefix: string;
  retentionDays: number;
  maxTotalBytes: number;
}): Promise<void> {
  const now = Date.now();
  const files = await listMatchingFiles(options.logsDir, options.prefix);
  const cutoffMs = now - (options.retentionDays * 24 * 60 * 60 * 1_000);

  const fileStats = await Promise.all(
    files.map(async (path) => {
      try {
        return {
          path,
          stat: await stat(path),
        };
      } catch {
        return null;
      }
    }),
  );
  const existing = fileStats
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);

  for (const entry of existing) {
    if (entry.stat.mtimeMs < cutoffMs) {
      await rm(entry.path, { force: true });
    }
  }

  let remaining = (
    await Promise.all(
      existing.map(async (entry) => {
        try {
          return {
            path: entry.path,
            stat: await stat(entry.path),
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);

  let totalBytes = remaining.reduce((sum, entry) => sum + entry.stat.size, 0);
  while (totalBytes > options.maxTotalBytes && remaining.length > 0) {
    const oldest = remaining.shift();
    if (!oldest) {
      break;
    }
    totalBytes -= oldest.stat.size;
    await rm(oldest.path, { force: true });
  }
}

async function maybeCleanupStructuredLogs(codexTeamDir: string): Promise<void> {
  const lastCleanupAt = cleanupTracker.get(codexTeamDir) ?? 0;
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }
  cleanupTracker.set(codexTeamDir, Date.now());
  const logsDir = resolveLogsDir(codexTeamDir);
  await ensureLogsDir(logsDir);
  await cleanupPrefixedLogs({
    logsDir,
    prefix: "events-",
    retentionDays: EVENT_LOG_RETENTION_DAYS,
    maxTotalBytes: EVENT_LOG_MAX_TOTAL_BYTES,
  });
  await cleanupPrefixedLogs({
    logsDir,
    prefix: "proxy-requests-",
    retentionDays: PROXY_REQUEST_LOG_RETENTION_DAYS,
    maxTotalBytes: PROXY_REQUEST_LOG_MAX_TOTAL_BYTES,
  });
  await cleanupPrefixedLogs({
    logsDir,
    prefix: "proxy-errors-",
    retentionDays: PROXY_ERROR_LOG_RETENTION_DAYS,
    maxTotalBytes: PROXY_ERROR_LOG_MAX_TOTAL_BYTES,
  });
}

export function resolveLogsDir(codexTeamDir: string): string {
  return join(codexTeamDir, "logs");
}

export function resolveDaemonLogPath(codexTeamDir: string): string {
  return join(resolveLogsDir(codexTeamDir), "daemon.log");
}

export function resolveEventLogPath(codexTeamDir: string, date = new Date()): string {
  return join(resolveLogsDir(codexTeamDir), `events-${toDateKey(date)}.jsonl`);
}

export function resolveProxyRequestLogPath(codexTeamDir: string, date = new Date()): string {
  return join(resolveLogsDir(codexTeamDir), `proxy-requests-${toDateKey(date)}.jsonl`);
}

export function resolveProxyErrorLogPath(codexTeamDir: string, date = new Date()): string {
  return join(resolveLogsDir(codexTeamDir), `proxy-errors-${toDateKey(date)}.jsonl`);
}

export async function rotatePlainLog(logPath: string): Promise<void> {
  await ensureLogsDir(dirname(logPath));
  let currentSize = 0;
  try {
    currentSize = (await stat(logPath)).size;
  } catch {
    currentSize = 0;
  }
  if (currentSize < DAEMON_LOG_MAX_BYTES) {
    return;
  }

  const extension = extname(logPath);
  const basePath = extension === ""
    ? logPath
    : logPath.slice(0, logPath.length - extension.length);
  for (let index = DAEMON_LOG_ROTATIONS - 1; index >= 1; index -= 1) {
    const source = `${basePath}.${index}${extension}`;
    const target = `${basePath}.${index + 1}${extension}`;
    try {
      await rename(source, target);
    } catch {
      // Best-effort rotation.
    }
  }

  try {
    await rename(logPath, `${basePath}.1${extension}`);
  } catch {
    // Best-effort rotation.
  }
}

export async function appendEventLog(codexTeamDir: string, payload: Record<string, unknown>): Promise<void> {
  await maybeCleanupStructuredLogs(codexTeamDir);
  await appendJsonLine(resolveEventLogPath(codexTeamDir), withCodexmVersion(payload));
}

export async function appendProxyRequestLog(
  codexTeamDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await maybeCleanupStructuredLogs(codexTeamDir);
  await appendJsonLine(resolveProxyRequestLogPath(codexTeamDir), withCodexmVersion(payload));
}

export async function appendProxyErrorLog(
  codexTeamDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await maybeCleanupStructuredLogs(codexTeamDir);
  await appendJsonLine(resolveProxyErrorLogPath(codexTeamDir), withCodexmVersion(payload));
}

export function buildEventPayload(options: {
  component: string;
  event: string;
  trigger?: string;
  level?: "info" | "warn" | "error";
  opId?: string;
  result?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessageShort?: string;
  fields?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    level: options.level ?? "info",
    event: options.event,
    component: options.component,
    trigger: options.trigger ?? "cli",
    op_id: options.opId ?? null,
    pid: process.pid,
    codexm_version: CODEXM_VERSION,
    ...getCodexmBuildMetadata(),
    ...(typeof options.durationMs === "number" ? { duration_ms: options.durationMs } : {}),
    ...(options.result ? { result: options.result } : {}),
    ...(options.errorCode ? { error_code: options.errorCode } : {}),
    ...(options.errorMessageShort ? { error_message_short: options.errorMessageShort } : {}),
    ...(options.fields ?? {}),
  };
}

export function shortenErrorMessage(message: string, maxLength = 160): string {
  return message.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}
