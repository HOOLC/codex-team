import { readFile } from "node:fs/promises";

import {
  atomicWriteFile,
  defaultPaths,
} from "../account-store/storage.js";
import type { LocalUsageEvent } from "./types.js";

export const LOCAL_USAGE_FILE_CACHE_VERSION = 1;

export interface LocalUsageFileFingerprint {
  size: number;
  mtime_ms: number;
}

export interface LocalUsageFileCacheEntry {
  fingerprint: LocalUsageFileFingerprint;
  events: LocalUsageEvent[];
}

interface LocalUsageFileCacheDocument {
  version: number;
  files: Record<string, LocalUsageFileCacheEntry>;
}

export function getLocalUsageFileCachePath(homeDir?: string): string {
  return `${defaultPaths(homeDir).codexTeamDir}/local-usage-file-cache.json`;
}

export async function readLocalUsageFileCache(
  homeDir?: string,
): Promise<Record<string, LocalUsageFileCacheEntry>> {
  try {
    const raw = await readFile(getLocalUsageFileCachePath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as LocalUsageFileCacheDocument;
    if (parsed.version !== LOCAL_USAGE_FILE_CACHE_VERSION || typeof parsed.files !== "object") {
      return {};
    }
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

export async function writeLocalUsageFileCache(
  files: Record<string, LocalUsageFileCacheEntry>,
  homeDir?: string,
): Promise<void> {
  await atomicWriteFile(
    getLocalUsageFileCachePath(homeDir),
    `${JSON.stringify(
      {
        version: LOCAL_USAGE_FILE_CACHE_VERSION,
        files,
      },
      null,
      2,
    )}\n`,
  );
}
