import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  convertFiveHourPercentToPlusWeeklyUnits,
  convertOneWeekPercentToPlusWeeklyUnits,
} from "./plan-quota-profile.js";

const WATCH_HISTORY_FILE_NAME = "watch-quota-history.jsonl";
const WATCH_HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WATCH_HISTORY_KEEPALIVE_MS = 60 * 1000;
const WATCH_HISTORY_WINDOW_MS = 60 * 60 * 1000;

export interface WatchHistoryWindowSnapshot {
  used_percent: number;
  window_seconds?: number | null;
  reset_at: string | null;
}

export interface WatchHistoryRecord {
  recorded_at: string;
  account_name: string;
  account_id: string | null;
  identity: string | null;
  plan_type: string | null;
  available: string | null;
  five_hour: WatchHistoryWindowSnapshot | null;
  one_week: WatchHistoryWindowSnapshot | null;
  source: "watch";
}

export interface WatchHistoryTargetSnapshot {
  plan_type: string | null;
  available: string | null;
  five_hour: WatchHistoryWindowSnapshot | null;
  one_week: WatchHistoryWindowSnapshot | null;
}

export type WatchHistoryEtaStatus =
  | "ok"
  | "idle"
  | "insufficient_history"
  | "unavailable";

export interface WatchHistoryEtaContext {
  status: WatchHistoryEtaStatus;
  rate_1w_units_per_hour: number | null;
  rateIn1wUnitsPerHour: number | null;
  remaining_5h: number | null;
  remaining5h: number | null;
  remaining_1w: number | null;
  remaining1w: number | null;
  remaining_5h_eq_1w: number | null;
  remaining5hEq1w: number | null;
  bottleneck_remaining: number | null;
  bottleneckRemaining: number | null;
  bottleneck_window: "5h_eq_1w" | "1w" | null;
  bottleneck: "five_hour" | "one_week" | null;
  etaHours: number | null;
}

export interface WatchHistoryStore {
  path: string;
  read(now?: Date): Promise<WatchHistoryRecord[]>;
  append(record: WatchHistoryRecord, now?: Date): Promise<boolean>;
}

export type WatchQuotaHistoryRecord = WatchHistoryRecord;
export type WatchEtaContext = WatchHistoryEtaContext;

function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

export function convertFiveHourPercentToWeeklyEquivalent(
  fiveHourPercent: number | null,
  planType: string | null,
): number | null {
  return convertFiveHourPercentToPlusWeeklyUnits(fiveHourPercent, planType);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function parseWindow(raw: unknown): WatchHistoryWindowSnapshot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.used_percent !== "number" ||
    !Number.isFinite(candidate.used_percent) ||
    (candidate.window_seconds !== undefined &&
      candidate.window_seconds !== null &&
      (typeof candidate.window_seconds !== "number" ||
        !Number.isFinite(candidate.window_seconds)))
  ) {
    return null;
  }

  if (
    candidate.reset_at !== null &&
    typeof candidate.reset_at !== "string"
  ) {
    return null;
  }

  if (typeof candidate.reset_at === "string" && !isValidDate(candidate.reset_at)) {
    return null;
  }

  return {
    used_percent: candidate.used_percent,
    ...(typeof candidate.window_seconds === "number"
      ? { window_seconds: candidate.window_seconds }
      : {}),
    reset_at: candidate.reset_at ?? null,
  };
}

function parseWatchHistoryRecord(raw: unknown): WatchHistoryRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.recorded_at !== "string" ||
    typeof candidate.account_name !== "string" ||
    !("plan_type" in candidate) ||
    !("available" in candidate) ||
    candidate.source !== "watch"
  ) {
    return null;
  }

  if (!isValidDate(candidate.recorded_at)) {
    return null;
  }

  return {
    recorded_at: candidate.recorded_at,
    account_name: candidate.account_name,
    account_id:
      candidate.account_id === null || typeof candidate.account_id === "string"
        ? candidate.account_id
        : null,
    identity:
      candidate.identity === null || typeof candidate.identity === "string"
        ? candidate.identity
        : null,
    plan_type:
      candidate.plan_type === null || typeof candidate.plan_type === "string"
        ? candidate.plan_type
        : null,
    available:
      candidate.available === null || typeof candidate.available === "string"
        ? candidate.available
        : null,
    five_hour: parseWindow(candidate.five_hour),
    one_week: parseWindow(candidate.one_week),
    source: "watch",
  };
}

function parseWatchHistoryLine(line: string): WatchHistoryRecord | null {
  if (line.trim() === "") {
    return null;
  }

  try {
    return parseWatchHistoryRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function isRecent(recordedAt: string, now: Date): boolean {
  const recordedAtMs = Date.parse(recordedAt);
  return now.getTime() - recordedAtMs <= WATCH_HISTORY_MAX_AGE_MS;
}

function isInsideRateWindow(recordedAt: string, now: Date): boolean {
  const recordedAtMs = Date.parse(recordedAt);
  return now.getTime() - recordedAtMs <= WATCH_HISTORY_WINDOW_MS;
}

function formatRecord(record: WatchHistoryRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function normalizeWindowInput(raw: unknown): WatchHistoryWindowSnapshot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const usedPercent =
    typeof candidate.used_percent === "number"
      ? candidate.used_percent
      : typeof candidate.usedPercent === "number"
        ? candidate.usedPercent
        : null;

  if (usedPercent === null || !Number.isFinite(usedPercent)) {
    return null;
  }

  const resetAt =
    typeof candidate.reset_at === "string"
      ? candidate.reset_at
      : typeof candidate.resetAt === "string"
        ? candidate.resetAt
        : null;

  if (resetAt !== null && !isValidDate(resetAt)) {
    return null;
  }

  const windowSeconds =
    typeof candidate.window_seconds === "number"
      ? candidate.window_seconds
      : typeof candidate.windowSeconds === "number"
        ? candidate.windowSeconds
        : undefined;

  return {
    used_percent: usedPercent,
    ...(typeof windowSeconds === "number" ? { window_seconds: windowSeconds } : {}),
    reset_at: resetAt,
  };
}

function normalizeRecordInput(raw: unknown): WatchHistoryRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error("Watch history record must be an object.");
  }

  const candidate = raw as Record<string, unknown>;
  const recordedAt =
    typeof candidate.recorded_at === "string"
      ? candidate.recorded_at
      : typeof candidate.recordedAt === "string"
        ? candidate.recordedAt
        : null;

  if (recordedAt === null || !isValidDate(recordedAt)) {
    throw new Error("Watch history record requires a valid recorded_at/recordedAt value.");
  }

  const accountName =
    typeof candidate.account_name === "string"
      ? candidate.account_name
      : typeof candidate.accountName === "string"
        ? candidate.accountName
        : null;
  if (accountName === null) {
    throw new Error("Watch history record requires account_name/accountName.");
  }

  const accountId =
    candidate.account_id === null || typeof candidate.account_id === "string"
      ? candidate.account_id
      : candidate.accountId === null || typeof candidate.accountId === "string"
        ? candidate.accountId
        : null;

  const identity =
    candidate.identity === null || typeof candidate.identity === "string"
      ? candidate.identity
      : typeof candidate.user_id === "string"
        ? candidate.user_id
        : typeof candidate.userId === "string"
          ? candidate.userId
          : null;

  const planType =
    candidate.plan_type === null || typeof candidate.plan_type === "string"
      ? candidate.plan_type
      : typeof candidate.planType === "string"
        ? candidate.planType
        : null;

  const available =
    candidate.available === null || typeof candidate.available === "string"
      ? candidate.available
      : null;

  const fiveHour = normalizeWindowInput(candidate.five_hour ?? candidate.fiveHour);
  const oneWeek = normalizeWindowInput(candidate.one_week ?? candidate.oneWeek);

  return {
    recorded_at: recordedAt,
    account_name: accountName,
    account_id: accountId,
    identity,
    plan_type: planType,
    available,
    five_hour: fiveHour,
    one_week: oneWeek,
    source: "watch",
  };
}

function normalizeTargetSnapshot(raw: unknown): WatchHistoryTargetSnapshot {
  if (!raw || typeof raw !== "object") {
    throw new Error("Watch ETA target snapshot must be an object.");
  }

  const candidate = raw as Record<string, unknown>;
  const planType =
    typeof candidate.plan_type === "string" || candidate.plan_type === null
      ? candidate.plan_type
      : typeof candidate.planType === "string" || candidate.planType === null
        ? candidate.planType
        : null;

  const available =
    typeof candidate.available === "string" || candidate.available === null
      ? candidate.available
      : null;

  return {
    plan_type: planType,
    available,
    five_hour: normalizeWindowInput(candidate.five_hour ?? candidate.fiveHour),
    one_week: normalizeWindowInput(candidate.one_week ?? candidate.oneWeek),
  };
}

function windowsMatch(left: WatchHistoryWindowSnapshot | null, right: WatchHistoryWindowSnapshot | null): boolean {
  if (left === null || right === null) {
    return false;
  }

  return left.reset_at !== null && left.reset_at === right.reset_at;
}

function deltaForWindow(
  left: WatchHistoryWindowSnapshot | null,
  right: WatchHistoryWindowSnapshot | null,
): number | null {
  if (left === null || right === null) {
    return null;
  }

  if (!windowsMatch(left, right)) {
    return null;
  }

  return Math.max(0, right.used_percent - left.used_percent);
}

function scoreDeltaForPair(
  left: WatchHistoryRecord,
  right: WatchHistoryRecord,
  planType: string | null,
): number | null {
  const fiveHourDelta = deltaForWindow(left.five_hour, right.five_hour);
  const oneWeekDelta = deltaForWindow(left.one_week, right.one_week);

  if (fiveHourDelta === null && oneWeekDelta === null) {
    return null;
  }

  const fiveHourEquivalent =
    fiveHourDelta === null
      ? null
      : convertFiveHourPercentToWeeklyEquivalent(fiveHourDelta, planType);
  const oneWeekEquivalent = convertOneWeekPercentToPlusWeeklyUnits(oneWeekDelta, planType);

  const validDeltas = [fiveHourEquivalent, oneWeekEquivalent].filter(
    (value): value is number => typeof value === "number",
  );

  return validDeltas.length === 0 ? null : Math.max(...validDeltas);
}

function computePairRate(
  left: WatchHistoryRecord,
  right: WatchHistoryRecord,
): number | null {
  if (Date.parse(right.recorded_at) <= Date.parse(left.recorded_at)) {
    return null;
  }

  const delta = scoreDeltaForPair(left, right, right.plan_type ?? left.plan_type);
  if (delta === null) {
    return null;
  }

  const elapsedHours = (Date.parse(right.recorded_at) - Date.parse(left.recorded_at)) / 3_600_000;
  if (elapsedHours <= 0) {
    return null;
  }

  return roundToTwo(delta / elapsedHours);
}

function computeRemainingPercent(window: WatchHistoryWindowSnapshot | null): number | null {
  if (!window) {
    return null;
  }

  return roundToTwo(clampPercent(100 - window.used_percent));
}

function computeRemainingContext(target: WatchHistoryTargetSnapshot, planType: string | null) {
  const remaining5h = computeRemainingPercent(target.five_hour);
  const remaining1w = computeRemainingPercent(target.one_week);

  const remaining5hEq1w =
    remaining5h === null
      ? null
      : convertFiveHourPercentToWeeklyEquivalent(remaining5h, planType ?? target.plan_type);
  const remaining1wEq =
    remaining1w === null
      ? null
      : convertOneWeekPercentToPlusWeeklyUnits(remaining1w, planType ?? target.plan_type);

  const hasAnyRemaining =
    typeof remaining5hEq1w === "number" || typeof remaining1wEq === "number";

  if (!hasAnyRemaining) {
    return {
      remaining_5h: null,
      remaining_1w: null,
      remaining_5h_eq_1w: null,
      bottleneck_remaining: null,
      bottleneck_window: null,
    };
  }

  if (remaining5hEq1w === null) {
    return {
      remaining_5h: remaining5h,
      remaining_1w: remaining1wEq,
      remaining_5h_eq_1w: null,
      bottleneck_remaining: remaining1wEq,
      bottleneck_window: "1w" as const,
    };
  }

  if (remaining1wEq === null) {
    return {
      remaining_5h: remaining5h,
      remaining_1w: remaining1wEq,
      remaining_5h_eq_1w: remaining5hEq1w,
      bottleneck_remaining: remaining5hEq1w,
      bottleneck_window: "5h_eq_1w" as const,
    };
  }

  if (remaining5hEq1w <= remaining1wEq) {
    return {
      remaining_5h: remaining5h,
      remaining_1w: remaining1wEq,
      remaining_5h_eq_1w: remaining5hEq1w,
      bottleneck_remaining: remaining5hEq1w,
      bottleneck_window: "5h_eq_1w" as const,
    };
  }

  return {
    remaining_5h: remaining5h,
    remaining_1w: remaining1wEq,
    remaining_5h_eq_1w: remaining5hEq1w,
    bottleneck_remaining: remaining1wEq,
    bottleneck_window: "1w" as const,
  };
}

function computeEtaFromRate(
  rate_1w_units_per_hour: number,
  bottleneck_remaining: number | null,
): number | null {
  if (bottleneck_remaining === null || rate_1w_units_per_hour <= 0) {
    return null;
  }

  return roundToTwo(bottleneck_remaining / rate_1w_units_per_hour);
}

function buildEtaResult(
  status: WatchHistoryEtaStatus,
  rate_1w_units_per_hour: number | null,
  targetContext: ReturnType<typeof computeRemainingContext> | null,
): WatchHistoryEtaContext {
  if (!targetContext) {
    return {
      status,
      rate_1w_units_per_hour,
      rateIn1wUnitsPerHour: rate_1w_units_per_hour,
      remaining_5h: null,
      remaining5h: null,
      remaining_1w: null,
      remaining1w: null,
      remaining_5h_eq_1w: null,
      remaining5hEq1w: null,
      bottleneck_remaining: null,
      bottleneckRemaining: null,
      bottleneck_window: null,
      bottleneck: null,
      etaHours: null,
    };
  }

  return {
    status,
    rate_1w_units_per_hour,
    rateIn1wUnitsPerHour: rate_1w_units_per_hour,
    ...targetContext,
    remaining5h: targetContext.remaining_5h,
    remaining1w: targetContext.remaining_1w,
    remaining5hEq1w: targetContext.remaining_5h_eq_1w,
    bottleneckRemaining: targetContext.bottleneck_remaining,
    bottleneck:
      targetContext.bottleneck_window === null
        ? null
        : targetContext.bottleneck_window === "5h_eq_1w"
          ? "five_hour"
          : "one_week",
    etaHours:
      status === "ok"
        ? computeEtaFromRate(rate_1w_units_per_hour ?? 0, targetContext.bottleneck_remaining)
        : null,
  };
}

function readHistoryFile(path: string, now: Date): Promise<WatchHistoryRecord[]> {
  return readFile(path, "utf8")
    .then((raw) =>
      raw
        .split("\n")
        .map(parseWatchHistoryLine)
        .filter((record): record is WatchHistoryRecord => record !== null)
        .filter((record) => isRecent(record.recorded_at, now)),
    )
    .catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return [];
      }

      throw error;
    });
}

function hasMeaningfulDifference(left: WatchHistoryRecord, right: WatchHistoryRecord): boolean {
  return (
    left.account_name !== right.account_name ||
    left.account_id !== right.account_id ||
    left.identity !== right.identity ||
    left.plan_type !== right.plan_type ||
    left.available !== right.available ||
    left.five_hour?.used_percent !== right.five_hour?.used_percent ||
    left.five_hour?.window_seconds !== right.five_hour?.window_seconds ||
    left.five_hour?.reset_at !== right.five_hour?.reset_at ||
    left.one_week?.used_percent !== right.one_week?.used_percent ||
    left.one_week?.window_seconds !== right.one_week?.window_seconds ||
    left.one_week?.reset_at !== right.one_week?.reset_at
  );
}

async function ensureWatchHistoryDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

export function createWatchHistoryStore(codexTeamDir: string): WatchHistoryStore {
  const path = join(codexTeamDir, WATCH_HISTORY_FILE_NAME);

  return {
    path,
    async read(now = new Date()): Promise<WatchHistoryRecord[]> {
      return readHistoryFile(path, now);
    },
    async append(record: WatchHistoryRecord, now = new Date()): Promise<boolean> {
      await ensureWatchHistoryDirectory(path);

      const existingRecords = await readHistoryFile(path, now);
      const lastRecord = existingRecords.at(-1);
      if (lastRecord) {
        const elapsedMs = now.getTime() - Date.parse(lastRecord.recorded_at);
        if (elapsedMs < WATCH_HISTORY_KEEPALIVE_MS && !hasMeaningfulDifference(lastRecord, record)) {
          return false;
        }
      }

      await appendFile(path, formatRecord(record), {
        encoding: "utf8",
        mode: 0o600,
      });

      return true;
    },
  };
}

export async function appendWatchQuotaHistory(
  store: WatchHistoryStore,
  record: unknown,
  now = new Date(),
): Promise<boolean> {
  return store.append(normalizeRecordInput(record), now);
}

function computeRateFromHistory(records: WatchHistoryRecord[]): number | null {
  if (records.length < 2) {
    return null;
  }

  let totalDelta = 0;
  let totalHours = 0;
  let sawValidPair = false;

  for (let index = 1; index < records.length; index += 1) {
    const left = records[index - 1];
    const right = records[index];
    if (!left || !right) {
      continue;
    }

    const ageMs = Date.parse(right.recorded_at) - Date.parse(left.recorded_at);
    if (ageMs <= 0 || ageMs > WATCH_HISTORY_WINDOW_MS) {
      continue;
    }

    const delta = scoreDeltaForPair(left, right, right.plan_type ?? left.plan_type);
    if (delta === null) {
      continue;
    }

    const elapsedHours = ageMs / 3_600_000;
    if (elapsedHours <= 0) {
      continue;
    }

    sawValidPair = true;
    totalDelta += delta;
    totalHours += elapsedHours;
  }

  if (!sawValidPair || totalHours <= 0) {
    return null;
  }

  return roundToTwo(totalDelta / totalHours);
}

export function computeWatchHistoryEta(
  history: WatchHistoryRecord[],
  target: WatchHistoryTargetSnapshot,
  now = new Date(),
): WatchHistoryEtaContext {
  if (
    target.available === "unavailable" ||
    (target.five_hour === null && target.one_week === null)
  ) {
    return buildEtaResult("unavailable", null, null);
  }

  const recentHistory = history
    .filter((record) => isRecent(record.recorded_at, now))
    .sort((left, right) => Date.parse(left.recorded_at) - Date.parse(right.recorded_at));

  const targetContext = computeRemainingContext(target, target.plan_type);
  const rate_1w_units_per_hour = computeRateFromHistory(recentHistory);

  if (rate_1w_units_per_hour === null) {
    return buildEtaResult(
      recentHistory.length < 2 ? "insufficient_history" : "insufficient_history",
      null,
      targetContext,
    );
  }

  if (rate_1w_units_per_hour <= 0) {
    return buildEtaResult("idle", 0, targetContext);
  }

  return buildEtaResult("ok", rate_1w_units_per_hour, targetContext);
}

export async function computeWatchEtaContext(
  source: WatchHistoryStore | WatchHistoryRecord[],
  target: unknown,
  now: string | Date = new Date(),
): Promise<WatchEtaContext> {
  const resolvedNow = typeof now === "string" ? new Date(now) : now;
  const targetSnapshot = normalizeTargetSnapshot(target);

  if (Array.isArray(source)) {
    return computeWatchHistoryEta(source, targetSnapshot, resolvedNow);
  }

  const history = await source.read(resolvedNow);
  return computeWatchHistoryEta(history, targetSnapshot, resolvedNow);
}
