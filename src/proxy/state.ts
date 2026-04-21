import { readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { DEFAULT_PROXY_HOST, proxyBackendBaseUrl, proxyOpenAIBaseUrl, resolveProxyPort } from "./constants.js";

export interface ProxyProcessState {
  pid: number;
  host: string;
  port: number;
  started_at: string;
  log_path: string;
  base_url: string;
  openai_base_url: string;
  debug: boolean;
  enabled?: boolean;
  enabled_at?: string;
  direct_auth_backup_path?: string | null;
  direct_config_backup_path?: string | null;
  direct_auth_existed?: boolean;
  direct_config_existed?: boolean;
}

export interface ProxyStatus {
  running: boolean;
  state: ProxyProcessState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveProxyStatePath(codexTeamDir: string): string {
  return join(codexTeamDir, "proxy-state.json");
}

export function resolveProxyDataDir(codexTeamDir: string): string {
  return join(codexTeamDir, "proxy");
}

export function defaultProxyProcessState(codexTeamDir: string): ProxyProcessState {
  const host = DEFAULT_PROXY_HOST;
  const port = resolveProxyPort();
  return {
    pid: 0,
    host,
    port,
    started_at: "",
    log_path: join(codexTeamDir, "logs", "proxy.log"),
    base_url: proxyBackendBaseUrl(host, port),
    openai_base_url: proxyOpenAIBaseUrl(host, port),
    debug: false,
  };
}

export function parseProxyProcessState(raw: string): ProxyProcessState | null {
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
    typeof parsed.host !== "string" ||
    parsed.host.trim() === "" ||
    typeof parsed.port !== "number" ||
    !Number.isInteger(parsed.port) ||
    parsed.port <= 0 ||
    typeof parsed.started_at !== "string" ||
    typeof parsed.log_path !== "string" ||
    parsed.log_path.trim() === "" ||
    typeof parsed.base_url !== "string" ||
    parsed.base_url.trim() === "" ||
    typeof parsed.openai_base_url !== "string" ||
    parsed.openai_base_url.trim() === "" ||
    typeof parsed.debug !== "boolean"
  ) {
    return null;
  }

  return {
    pid: parsed.pid,
    host: parsed.host,
    port: parsed.port,
    started_at: parsed.started_at,
    log_path: parsed.log_path,
    base_url: parsed.base_url,
    openai_base_url: parsed.openai_base_url,
    debug: parsed.debug,
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
    enabled_at: typeof parsed.enabled_at === "string" ? parsed.enabled_at : undefined,
    direct_auth_backup_path:
      typeof parsed.direct_auth_backup_path === "string"
        ? parsed.direct_auth_backup_path
        : parsed.direct_auth_backup_path === null
          ? null
          : undefined,
    direct_config_backup_path:
      typeof parsed.direct_config_backup_path === "string"
        ? parsed.direct_config_backup_path
        : parsed.direct_config_backup_path === null
          ? null
          : undefined,
    direct_auth_existed:
      typeof parsed.direct_auth_existed === "boolean" ? parsed.direct_auth_existed : undefined,
    direct_config_existed:
      typeof parsed.direct_config_existed === "boolean" ? parsed.direct_config_existed : undefined,
  };
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

export async function readProxyState(codexTeamDir: string): Promise<ProxyProcessState | null> {
  try {
    return parseProxyProcessState(await readFile(resolveProxyStatePath(codexTeamDir), "utf8"));
  } catch {
    return null;
  }
}

export async function writeProxyState(codexTeamDir: string, state: ProxyProcessState): Promise<void> {
  await atomicWriteFile(resolveProxyStatePath(codexTeamDir), `${JSON.stringify(state, null, 2)}\n`);
}

export async function removeProxyState(codexTeamDir: string): Promise<void> {
  await rm(resolveProxyStatePath(codexTeamDir), { force: true });
}

export function isProcessRunning(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return nodeError.code === "EPERM";
  }
}
