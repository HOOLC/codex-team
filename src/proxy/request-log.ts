import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveLogsDir } from "../logging.js";

const PROXY_REQUEST_LOG_PREFIX = "proxy-requests-";
const PROXY_REQUEST_LOG_TAIL_BYTES = 128 * 1024;
const MAX_PROXY_REQUEST_LOG_FILES = 3;

export interface ProxyLastUpstreamSelection {
  accountName: string;
  authMode: string;
  ts: string;
}

function formatTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalTimestamp(value: string): string | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  return `${formatTwoDigits(date.getMonth() + 1)}-${formatTwoDigits(date.getDate())} ${formatTwoDigits(date.getHours())}:${formatTwoDigits(date.getMinutes())}`;
}

function formatRelativeOffsetCompact(offsetMs: number): string {
  const absMs = Math.abs(offsetMs);
  if (absMs < 60_000) {
    return "now";
  }

  const minutes = absMs / 60_000;
  if (minutes < 60) {
    return `${Math.max(1, Math.round(minutes))}m`;
  }

  const hours = absMs / 3_600_000;
  if (hours < 24) {
    const value = hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
    return `${value.replace(/\.0$/u, "")}h`;
  }

  const days = absMs / 86_400_000;
  const value = days < 10 ? days.toFixed(1) : String(Math.round(days));
  return `${value.replace(/\.0$/u, "")}d`;
}

function formatRelativeTimestamp(value: string, now: Date): string | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const compact = formatRelativeOffsetCompact(timestamp - now.getTime());
  if (compact === "now") {
    return "now";
  }

  return timestamp >= now.getTime() ? `in ${compact}` : `${compact} ago`;
}

function parseProxyRequestSelectionLine(rawLine: string): ProxyLastUpstreamSelection | null {
  if (rawLine.trim() === "") {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof parsed.selected_account_name !== "string" || parsed.selected_account_name.trim() === "") {
    return null;
  }
  if (typeof parsed.ts !== "string" || parsed.ts.trim() === "") {
    return null;
  }

  return {
    accountName: parsed.selected_account_name,
    authMode:
      typeof parsed.selected_auth_mode === "string" && parsed.selected_auth_mode.trim() !== ""
        ? parsed.selected_auth_mode
        : "-",
    ts: parsed.ts,
  };
}

async function readTailLines(path: string): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
    const fileStat = await handle.stat();
    const readSize = Math.min(fileStat.size, PROXY_REQUEST_LOG_TAIL_BYTES);
    if (readSize <= 0) {
      return [];
    }

    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, fileStat.size - readSize);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");

    if (fileStat.size > readSize) {
      lines.shift();
    }

    return lines.filter((line) => line.trim() !== "");
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

async function listRecentProxyRequestLogs(codexTeamDir: string): Promise<string[]> {
  try {
    const entries = await readdir(resolveLogsDir(codexTeamDir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(PROXY_REQUEST_LOG_PREFIX))
      .map((entry) => join(resolveLogsDir(codexTeamDir), entry.name))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, MAX_PROXY_REQUEST_LOG_FILES);
  } catch {
    return [];
  }
}

export async function readLatestProxyUpstreamSelection(
  codexTeamDir: string,
): Promise<ProxyLastUpstreamSelection | null> {
  const logPaths = await listRecentProxyRequestLogs(codexTeamDir);
  for (const logPath of logPaths) {
    const lines = await readTailLines(logPath);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const selection = parseProxyRequestSelectionLine(lines[index] ?? "");
      if (selection) {
        return selection;
      }
    }
  }

  return null;
}

export function formatProxyUpstreamSelectionLabel(
  selection: ProxyLastUpstreamSelection | null | undefined,
  now = new Date(),
): string | null {
  if (!selection) {
    return null;
  }

  const absolute = formatLocalTimestamp(selection.ts);
  const relative = formatRelativeTimestamp(selection.ts, now);
  const whenLabel = [absolute, relative].filter((part): part is string => Boolean(part)).join(", ");

  return whenLabel === ""
    ? `${selection.accountName} (${selection.authMode})`
    : `${selection.accountName} (${selection.authMode}, ${whenLabel})`;
}
