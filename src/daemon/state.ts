import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  DEFAULT_PROXY_HOST,
  proxyBackendBaseUrl,
  proxyOpenAIBaseUrl,
  resolveProxyPort,
} from "../proxy/constants.js";
import { resolveDaemonLogPath } from "../logging.js";

export interface DaemonProcessState {
  pid: number;
  started_at: string;
  log_path: string;
  stayalive: boolean;
  watch: boolean;
  auto_switch: boolean;
  proxy: boolean;
  host: string;
  port: number;
  base_url: string;
  openai_base_url: string;
  debug: boolean;
}

export interface DaemonStatus {
  running: boolean;
  state: DaemonProcessState | null;
}

export function buildDaemonConfig(options: {
  codexTeamDir: string;
  currentState?: DaemonProcessState | null;
  portOverride?: string;
  debug?: boolean;
  overrides?: Partial<Pick<DaemonProcessState, "stayalive" | "watch" | "auto_switch" | "proxy" | "host">>;
}): Omit<DaemonProcessState, "pid" | "started_at" | "log_path"> {
  const currentState = options.currentState ?? defaultDaemonState(options.codexTeamDir);
  const host = options.overrides?.host ?? currentState.host;
  const port = resolveProxyPort({
    env: process.env,
    cliValue: options.portOverride,
    fallback: currentState.port,
  });
  const watch = options.overrides?.watch ?? currentState.watch;
  const requestedAutoSwitch = options.overrides?.auto_switch ?? currentState.auto_switch;

  return {
    stayalive: options.overrides?.stayalive ?? currentState.stayalive,
    watch,
    auto_switch: watch ? requestedAutoSwitch : false,
    proxy: options.overrides?.proxy ?? currentState.proxy,
    host,
    port,
    base_url: proxyBackendBaseUrl(host, port),
    openai_base_url: proxyOpenAIBaseUrl(host, port),
    debug: currentState.debug || options.debug === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function resolveDaemonStatePath(codexTeamDir: string): string {
  return join(codexTeamDir, "daemon-state.json");
}

export function defaultDaemonState(codexTeamDir: string): DaemonProcessState {
  const port = resolveProxyPort();
  return {
    pid: 0,
    started_at: "",
    log_path: resolveDaemonLogPath(codexTeamDir),
    stayalive: false,
    watch: false,
    auto_switch: false,
    proxy: false,
    host: DEFAULT_PROXY_HOST,
    port,
    base_url: proxyBackendBaseUrl(DEFAULT_PROXY_HOST, port),
    openai_base_url: proxyOpenAIBaseUrl(DEFAULT_PROXY_HOST, port),
    debug: false,
  };
}

export function parseDaemonState(raw: string): DaemonProcessState | null {
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
    !ensureInteger(parsed.pid) ||
    typeof parsed.started_at !== "string" ||
    typeof parsed.log_path !== "string" ||
    typeof parsed.stayalive !== "boolean" ||
    typeof parsed.watch !== "boolean" ||
    typeof parsed.auto_switch !== "boolean" ||
    typeof parsed.proxy !== "boolean" ||
    typeof parsed.host !== "string" ||
    !ensureInteger(parsed.port) ||
    typeof parsed.base_url !== "string" ||
    typeof parsed.openai_base_url !== "string" ||
    typeof parsed.debug !== "boolean"
  ) {
    return null;
  }

  return {
    pid: parsed.pid,
    started_at: parsed.started_at,
    log_path: parsed.log_path,
    stayalive: parsed.stayalive,
    watch: parsed.watch,
    auto_switch: parsed.auto_switch,
    proxy: parsed.proxy,
    host: parsed.host,
    port: parsed.port,
    base_url: parsed.base_url,
    openai_base_url: parsed.openai_base_url,
    debug: parsed.debug,
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

export async function readDaemonState(codexTeamDir: string): Promise<DaemonProcessState | null> {
  try {
    return parseDaemonState(await readFile(resolveDaemonStatePath(codexTeamDir), "utf8"));
  } catch {
    return null;
  }
}

export async function writeDaemonState(codexTeamDir: string, state: DaemonProcessState): Promise<void> {
  await atomicWriteFile(resolveDaemonStatePath(codexTeamDir), `${JSON.stringify(state, null, 2)}\n`);
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
