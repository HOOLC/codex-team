import { readFile } from "node:fs/promises";

import {
  atomicWriteFile,
  defaultPaths,
} from "../account-store/storage.js";
import { LOCAL_USAGE_PRICING_VERSION } from "./pricing.js";
import type { LocalUsageSummary } from "./types.js";

const LOCAL_USAGE_SUMMARY_CACHE_VERSION = 1;

interface LocalUsageSummaryCacheDocument {
  version: number;
  pricing_version: number;
  summary: LocalUsageSummary;
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

export function getLocalUsageSummaryCachePath(homeDir?: string): string {
  return `${defaultPaths(homeDir).codexTeamDir}/local-usage-summary-cache.json`;
}

export async function readLocalUsageSummaryCache(options: {
  homeDir?: string;
  now?: Date;
  timeZone?: string;
} = {}): Promise<LocalUsageSummary | null> {
  try {
    const raw = await readFile(getLocalUsageSummaryCachePath(options.homeDir), "utf8");
    const parsed = JSON.parse(raw) as LocalUsageSummaryCacheDocument;
    if (
      parsed.version !== LOCAL_USAGE_SUMMARY_CACHE_VERSION ||
      parsed.pricing_version !== LOCAL_USAGE_PRICING_VERSION
    ) {
      return null;
    }

    const summary = parsed.summary;
    const now = options.now ?? new Date();
    const timeZone = options.timeZone ?? summary.timezone;
    if (summary.timezone !== timeZone) {
      return null;
    }

    if (localDateKey(new Date(summary.generated_at), timeZone) !== localDateKey(now, timeZone)) {
      return null;
    }

    return summary;
  } catch {
    return null;
  }
}

export async function writeLocalUsageSummaryCache(
  summary: LocalUsageSummary,
  homeDir?: string,
): Promise<void> {
  await atomicWriteFile(
    getLocalUsageSummaryCachePath(homeDir),
    `${JSON.stringify(
      {
        version: LOCAL_USAGE_SUMMARY_CACHE_VERSION,
        pricing_version: LOCAL_USAGE_PRICING_VERSION,
        summary,
      },
      null,
      2,
    )}\n`,
  );
}
