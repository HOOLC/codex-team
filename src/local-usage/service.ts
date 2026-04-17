import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_USAGE_PRICING_BY_MODEL,
} from "./pricing.js";
import {
  readLocalUsageFileCache,
  type LocalUsageFileCacheEntry,
  writeLocalUsageFileCache,
} from "./cache.js";
import type {
  LocalUsageDailyEntry,
  LocalUsageEvent,
  LocalUsageSummary,
  LocalUsageTokenSample,
  LocalUsageTotals,
} from "./types.js";

interface LocalUsageServiceOptions {
  homeDir?: string;
  timezone?: string;
}

interface LoadLocalUsageOptions {
  now?: Date;
}

interface MutableTotals extends LocalUsageTotals {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyTotals(): MutableTotals {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    estimated_input_cost_usd: 0,
    estimated_output_cost_usd: 0,
    estimated_total_cost_usd: 0,
    priced_tokens: 0,
    unpriced_tokens: 0,
  };
}

function cloneTotals(value: LocalUsageTotals): MutableTotals {
  return { ...value };
}

function toImmutableTotals(value: MutableTotals): LocalUsageTotals {
  return { ...value };
}

function parseUsageSample(raw: unknown): LocalUsageTokenSample | null {
  if (!isRecord(raw)) {
    return null;
  }

  const inputTokens = raw.input_tokens;
  const cachedInputTokens = raw.cached_input_tokens;
  const outputTokens = raw.output_tokens;

  if (
    typeof inputTokens !== "number" ||
    typeof cachedInputTokens !== "number" ||
    typeof outputTokens !== "number"
  ) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
  };
}

function extractTimestamp(raw: unknown): string | null {
  return typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function subtractUsage(
  current: LocalUsageTokenSample,
  previous: LocalUsageTokenSample | null,
): LocalUsageTokenSample {
  if (!previous) {
    return current;
  }

  return {
    input_tokens: Math.max(0, current.input_tokens - previous.input_tokens),
    cached_input_tokens: Math.max(0, current.cached_input_tokens - previous.cached_input_tokens),
    output_tokens: Math.max(0, current.output_tokens - previous.output_tokens),
  };
}

function totalTokens(usage: LocalUsageTokenSample): number {
  return usage.input_tokens + usage.output_tokens;
}

function extractSessionMeta(line: Record<string, unknown>): { timestamp: string | null } | null {
  if (line.type === "session_meta" && isRecord(line.payload)) {
    return { timestamp: extractTimestamp(line.payload.timestamp) };
  }

  if (isRecord(line.payload) && line.payload.type === "session_meta") {
    return { timestamp: extractTimestamp(line.payload.timestamp) };
  }

  return null;
}

function extractTurnContextModel(line: Record<string, unknown>): string | null {
  if (line.type === "turn_context" && isRecord(line.payload) && typeof line.payload.model === "string") {
    return line.payload.model;
  }

  if (isRecord(line.payload) && line.payload.type === "turn_context" && typeof line.payload.model === "string") {
    return line.payload.model;
  }

  return null;
}

function extractTokenEvent(
  line: Record<string, unknown>,
): { timestamp: string | null; totalUsage: LocalUsageTokenSample; incrementalUsage: LocalUsageTokenSample | null } | null {
  const topLevelTimestamp = extractTimestamp(line.timestamp);
  const payload = isRecord(line.payload) ? line.payload : null;

  let usageContainer: Record<string, unknown> | null = null;
  let totalUsage: LocalUsageTokenSample | null = null;
  let lastUsage: LocalUsageTokenSample | null = null;

  if (payload && line.type === "event_msg" && payload.type === "token_count") {
    usageContainer = payload;
  } else if (payload && payload.type === "event_msg" && payload.kind === "token_count") {
    usageContainer = payload;
  } else if (payload && payload.type === "token_count") {
    usageContainer = payload;
  }

  if (!usageContainer) {
    return null;
  }

  totalUsage =
    parseUsageSample(usageContainer.total_token_usage) ??
    (isRecord(usageContainer.info) ? parseUsageSample(usageContainer.info.total_token_usage) : null);
  lastUsage =
    parseUsageSample(usageContainer.last_token_usage) ??
    (isRecord(usageContainer.info) ? parseUsageSample(usageContainer.info.last_token_usage) : null);

  if (!totalUsage) {
    return null;
  }

  return {
    timestamp: topLevelTimestamp,
    totalUsage,
    incrementalUsage: lastUsage,
  };
}

function datePartsForTimezone(date: Date, timeZone: string): { key: string; dayNumber: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "0");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "0");
  const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  return { key, dayNumber };
}

async function collectJsonlFiles(directoryPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function parseSessionFile(filePath: string, fileMtimeMs: number): Promise<LocalUsageEvent[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const events: LocalUsageEvent[] = [];
  let sessionTimestamp: string | null = null;
  let model: string | null = null;
  let previousTotalUsage: LocalUsageTokenSample | null = null;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (!isRecord(parsed)) {
      continue;
    }

    const sessionMeta = extractSessionMeta(parsed);
    if (sessionMeta?.timestamp) {
      sessionTimestamp = sessionMeta.timestamp;
    }

    const turnContextModel = extractTurnContextModel(parsed);
    if (turnContextModel) {
      model = turnContextModel;
    }

    const tokenEvent = extractTokenEvent(parsed);
    if (!tokenEvent || !model) {
      continue;
    }

    const incrementalUsage = tokenEvent.incrementalUsage ?? subtractUsage(tokenEvent.totalUsage, previousTotalUsage);
    previousTotalUsage = tokenEvent.totalUsage;
    if (totalTokens(incrementalUsage) === 0) {
      continue;
    }

    events.push({
      timestamp:
        tokenEvent.timestamp ??
        sessionTimestamp ??
        new Date(fileMtimeMs).toISOString(),
      model,
      usage: incrementalUsage,
    });
  }

  return events;
}

function addUsageToTotals(target: MutableTotals, event: LocalUsageEvent): void {
  const pricing = LOCAL_USAGE_PRICING_BY_MODEL[event.model];
  const usage = event.usage;
  const eventTotalTokens = totalTokens(usage);

  target.input_tokens += usage.input_tokens;
  target.cached_input_tokens += usage.cached_input_tokens;
  target.output_tokens += usage.output_tokens;
  target.total_tokens += eventTotalTokens;

  if (!pricing) {
    target.unpriced_tokens += eventTotalTokens;
    return;
  }

  const cachedInputTokens = Math.min(Math.max(0, usage.cached_input_tokens), Math.max(0, usage.input_tokens));
  const nonCachedInputTokens = Math.max(0, usage.input_tokens - cachedInputTokens);
  const inputCost =
    nonCachedInputTokens * pricing.input +
    cachedInputTokens * (pricing.cached_input ?? pricing.input);
  const outputCost = usage.output_tokens * pricing.output;

  target.estimated_input_cost_usd += inputCost;
  target.estimated_output_cost_usd += outputCost;
  target.estimated_total_cost_usd += inputCost + outputCost;
  target.priced_tokens += eventTotalTokens;
}

export class LocalUsageService {
  readonly homeDir: string;
  readonly timeZone: string;

  constructor(options: LocalUsageServiceOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.timeZone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  async load(options: LoadLocalUsageOptions = {}): Promise<LocalUsageSummary> {
    const now = options.now ?? new Date();
    const currentDayInfo = datePartsForTimezone(now, this.timeZone);
    const sessionsRoot = join(this.homeDir, ".codex", "sessions");
    const archivedRoot = join(this.homeDir, ".codex", "archived_sessions");
    const files = [
      ...await collectJsonlFiles(sessionsRoot),
      ...await collectJsonlFiles(archivedRoot),
    ].sort((left, right) => left.localeCompare(right));

    const existingCache = await readLocalUsageFileCache(this.homeDir);
    const nextCache: Record<string, LocalUsageFileCacheEntry> = {};
    const allEvents: LocalUsageEvent[] = [];

    for (const filePath of files) {
      const fileStat = await stat(filePath);
      const fingerprint = {
        size: fileStat.size,
        mtime_ms: fileStat.mtimeMs,
      };
      const cached = existingCache[filePath];
      if (
        cached &&
        cached.fingerprint.size === fingerprint.size &&
        cached.fingerprint.mtime_ms === fingerprint.mtime_ms
      ) {
        nextCache[filePath] = cached;
        allEvents.push(...cached.events);
        continue;
      }

      const events = await parseSessionFile(filePath, fileStat.mtimeMs);
      const entry: LocalUsageFileCacheEntry = {
        fingerprint,
        events,
      };
      nextCache[filePath] = entry;
      allEvents.push(...events);
    }

    await writeLocalUsageFileCache(nextCache, this.homeDir);

    const windowTotals = {
      today: emptyTotals(),
      "7d": emptyTotals(),
      "30d": emptyTotals(),
      "all-time": emptyTotals(),
    };
    const dailyByDayNumber = new Map<number, { date: string; totals: MutableTotals }>();

    for (const event of allEvents) {
      const eventDate = new Date(event.timestamp);
      if (Number.isNaN(eventDate.getTime())) {
        continue;
      }

      const dayInfo = datePartsForTimezone(eventDate, this.timeZone);
      const dayDiff = currentDayInfo.dayNumber - dayInfo.dayNumber;

      addUsageToTotals(windowTotals["all-time"], event);
      if (dayDiff >= 0 && dayDiff <= 29) {
        const dailyEntry = dailyByDayNumber.get(dayInfo.dayNumber) ?? {
          date: dayInfo.key,
          totals: emptyTotals(),
        };
        addUsageToTotals(dailyEntry.totals, event);
        dailyByDayNumber.set(dayInfo.dayNumber, dailyEntry);
        addUsageToTotals(windowTotals["30d"], event);
        if (dayDiff <= 6) {
          addUsageToTotals(windowTotals["7d"], event);
          if (dayDiff === 0) {
            addUsageToTotals(windowTotals.today, event);
          }
        }
      }
    }

    const daily: LocalUsageDailyEntry[] = [...dailyByDayNumber.entries()]
      .sort((left, right) => right[0] - left[0])
      .map(([, value]) => ({
        date: value.date,
        ...toImmutableTotals(value.totals),
      }));

    return {
      generated_at: now.toISOString(),
      timezone: this.timeZone,
      windows: {
        today: toImmutableTotals(windowTotals.today),
        "7d": toImmutableTotals(windowTotals["7d"]),
        "30d": toImmutableTotals(windowTotals["30d"]),
        "all-time": toImmutableTotals(windowTotals["all-time"]),
      },
      daily,
    };
  }
}
