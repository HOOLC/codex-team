import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { ManagedCodexDesktopState } from "./types.js";
import { isNonEmptyString, isRecord } from "./shared.js";

export function parseManagedState(raw: string): ManagedCodexDesktopState | null {
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

  const pid = parsed.pid;
  const appPath = parsed.app_path;
  const remoteDebuggingPort = parsed.remote_debugging_port;
  const managedByCodexm = parsed.managed_by_codexm;
  const startedAt = parsed.started_at;
  const desktopApiBaseUrl = parsed.desktop_api_base_url;

  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !isNonEmptyString(appPath) ||
    typeof remoteDebuggingPort !== "number" ||
    !Number.isInteger(remoteDebuggingPort) ||
    remoteDebuggingPort <= 0 ||
    managedByCodexm !== true ||
    !isNonEmptyString(startedAt) ||
    !(
      desktopApiBaseUrl === undefined ||
      desktopApiBaseUrl === null ||
      isNonEmptyString(desktopApiBaseUrl)
    )
  ) {
    return null;
  }

  const state: ManagedCodexDesktopState = {
    pid,
    app_path: appPath,
    remote_debugging_port: remoteDebuggingPort,
    managed_by_codexm: true,
    started_at: startedAt,
  };
  if (desktopApiBaseUrl !== undefined) {
    state.desktop_api_base_url = desktopApiBaseUrl;
  }
  return state;
}

export async function ensureStateDirectory(statePath: string): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
}
