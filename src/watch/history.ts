import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  convertFiveHourPercentToPlusWeeklyUnits,
  convertOneWeekPercentToPlusWeeklyUnits,
  resolveFiveHourToOneWeekRawRatio,
} from "../plan-quota-profile.js";
import {
  PROXY_ACCOUNT_ID,
  PROXY_ACCOUNT_NAME,
  PROXY_IDENTITY,
  PROXY_PLAN_TYPE,
} from "../proxy/constants.js";
import {
  normalizeRecordInput,
  normalizeTargetSnapshot,
  parseWatchHistoryLine,
} from "./history-codec.js";
import { clampPercent, roundToTwo } from "./history-math.js";
import type {
  WatchEtaContext,
  WatchHistoryEtaContext,
  WatchHistoryEtaStatus,
  WatchHistoryObservedRatioDiagnostic,
  WatchHistoryRecord,
  WatchHistoryScopeKind,
  WatchHistoryStore,
  WatchHistoryTargetSnapshot,
  WatchHistoryWindowSnapshot,
} from "./history-types.js";
export type {
  WatchEtaContext,
  WatchHistoryEtaContext,
  WatchHistoryEtaStatus,
  WatchHistoryObservedRatioDiagnostic,
  WatchHistoryRecord,
  WatchHistoryScopeKind,
  WatchHistoryStore,
  WatchHistoryTargetSnapshot,
  WatchHistoryWindowSnapshot,
  WatchQuotaHistoryRecord,
} from "./history-types.js";

const WATCH_HISTORY_FILE_NAME = "watch-quota-history.jsonl";
const WATCH_HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WATCH_HISTORY_KEEPALIVE_MS = 60 * 1000;
const WATCH_HISTORY_WINDOW_MS = 60 * 60 * 1000;
const WATCH_HISTORY_RESET_AT_TOLERANCE_MS = 60 * 1000;
const WATCH_HISTORY_RATIO_DIAGNOSTIC_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCH_HISTORY_RATIO_WARNING_RELATIVE_DELTA = 0.2;
const WATCH_HISTORY_RATIO_WARNING_MIN_SAMPLES = 3;

export function convertFiveHourPercentToWeeklyEquivalent(
  fiveHourPercent: number | null,
  planType: string | null,
): number | null {
  return convertFiveHourPercentToPlusWeeklyUnits(fiveHourPercent, planType);
}

function isRecent(recordedAt: string, now: Date): boolean {
  const recordedAtMs = Date.parse(recordedAt);
  return now.getTime() - recordedAtMs <= WATCH_HISTORY_MAX_AGE_MS;
}

function isInsideRateWindow(recordedAt: string, now: Date): boolean {
  const recordedAtMs = Date.parse(recordedAt);
  return now.getTime() - recordedAtMs <= WATCH_HISTORY_WINDOW_MS;
}

function isInsideObservedRatioWindow(recordedAt: string, now: Date): boolean {
  const recordedAtMs = Date.parse(recordedAt);
  return now.getTime() - recordedAtMs <= WATCH_HISTORY_RATIO_DIAGNOSTIC_WINDOW_MS;
}

function formatRecord(record: WatchHistoryRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function filterWatchHistoryByScope(
  history: WatchHistoryRecord[],
  scope: {
    kind: WatchHistoryScopeKind;
    id?: string | null;
  },
): WatchHistoryRecord[] {
  return history.filter((record) => {
    if (record.scope_kind !== scope.kind) {
      return false;
    }

    if (scope.kind === "isolated") {
      return record.scope_id === (scope.id ?? null);
    }

    return true;
  });
}

function deltaForContinuousWindow(
  left: WatchHistoryWindowSnapshot | null,
  right: WatchHistoryWindowSnapshot | null,
): number | null {
  if (left === null || right === null) {
    return null;
  }

  return Math.max(0, right.used_percent - left.used_percent);
}

function scoreDeltaForSegment(
  left: WatchHistoryRecord,
  right: WatchHistoryRecord,
  planType: string | null,
): number | null {
  const fiveHourDelta = deltaForContinuousWindow(left.five_hour, right.five_hour);
  const oneWeekDelta = deltaForContinuousWindow(left.one_week, right.one_week);

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

function isSameWatchHistoryAccount(
  left: WatchHistoryRecord,
  right: WatchHistoryRecord,
): boolean {
  if (left.identity !== null && right.identity !== null) {
    return left.identity === right.identity;
  }

  if (left.account_id !== null && right.account_id !== null) {
    return left.account_id === right.account_id;
  }

  return left.account_name === right.account_name;
}

function isNonDecreasingWindow(
  left: WatchHistoryWindowSnapshot | null,
  right: WatchHistoryWindowSnapshot | null,
): boolean {
  if (left === null || right === null) {
    return true;
  }

  return right.used_percent >= left.used_percent;
}

function hasCompatibleResetAt(
  left: WatchHistoryWindowSnapshot | null,
  right: WatchHistoryWindowSnapshot | null,
): boolean {
  const leftResetAt = left?.reset_at ?? null;
  const rightResetAt = right?.reset_at ?? null;

  if (leftResetAt === null || rightResetAt === null) {
    return true;
  }

  return (
    Math.abs(Date.parse(rightResetAt) - Date.parse(leftResetAt)) <=
    WATCH_HISTORY_RESET_AT_TOLERANCE_MS
  );
}

function isContinuousWindow(
  left: WatchHistoryWindowSnapshot | null,
  right: WatchHistoryWindowSnapshot | null,
): boolean {
  return isNonDecreasingWindow(left, right) && hasCompatibleResetAt(left, right);
}

function isSameRateSegment(
  left: WatchHistoryRecord,
  right: WatchHistoryRecord,
): boolean {
  if (Date.parse(right.recorded_at) <= Date.parse(left.recorded_at)) {
    return false;
  }

  if (!isSameWatchHistoryAccount(left, right)) {
    return false;
  }

  if (left.plan_type !== right.plan_type) {
    return false;
  }

  return (
    isContinuousWindow(left.five_hour, right.five_hour) &&
    isContinuousWindow(left.one_week, right.one_week)
  );
}

function computeSegmentDelta(
  start: WatchHistoryRecord,
  end: WatchHistoryRecord,
): number | null {
  return scoreDeltaForSegment(start, end, end.plan_type ?? start.plan_type);
}

interface WatchHistorySegment {
  start: WatchHistoryRecord;
  end: WatchHistoryRecord;
  elapsedHours: number;
}

interface WatchHistorySegmentMetrics extends WatchHistorySegment {
  delta_5h_raw: number | null;
  delta_1w_raw: number | null;
  delta_5h_eq_1w: number | null;
  delta_1w_eq: number | null;
  segment_delta_1w_units: number | null;
}

function collectContinuousSegments(records: WatchHistoryRecord[]): WatchHistorySegment[] {
  if (records.length < 2) {
    return [];
  }

  const segments: WatchHistorySegment[] = [];
  let segmentStart = records[0] ?? null;
  let segmentEnd = segmentStart;

  const appendSegment = (start: WatchHistoryRecord | null, end: WatchHistoryRecord | null) => {
    if (!start || !end || start === end) {
      return;
    }

    const elapsedHours = (Date.parse(end.recorded_at) - Date.parse(start.recorded_at)) / 3_600_000;
    if (elapsedHours <= 0) {
      return;
    }

    segments.push({ start, end, elapsedHours });
  };

  for (let index = 1; index < records.length; index += 1) {
    const right = records[index];
    const left = segmentEnd;
    if (!left || !right) {
      continue;
    }

    const ageMs = Date.parse(right.recorded_at) - Date.parse(left.recorded_at);
    if (
      ageMs > 0 &&
      ageMs <= WATCH_HISTORY_WINDOW_MS &&
      isSameRateSegment(left, right)
    ) {
      segmentEnd = right;
      continue;
    }

    appendSegment(segmentStart, segmentEnd);
    segmentStart = right;
    segmentEnd = right;
  }

  appendSegment(segmentStart, segmentEnd);
  return segments;
}

function toSegmentMetrics(segment: WatchHistorySegment): WatchHistorySegmentMetrics {
  const planType = segment.end.plan_type ?? segment.start.plan_type;
  const delta5hRaw = deltaForContinuousWindow(segment.start.five_hour, segment.end.five_hour);
  const delta1wRaw = deltaForContinuousWindow(segment.start.one_week, segment.end.one_week);
  const delta5hEq1w =
    delta5hRaw === null ? null : convertFiveHourPercentToWeeklyEquivalent(delta5hRaw, planType);
  const delta1wEq =
    delta1wRaw === null ? null : convertOneWeekPercentToPlusWeeklyUnits(delta1wRaw, planType);
  const validDeltas = [delta5hEq1w, delta1wEq].filter(
    (value): value is number => typeof value === "number",
  );

  return {
    ...segment,
    delta_5h_raw: delta5hRaw,
    delta_1w_raw: delta1wRaw,
    delta_5h_eq_1w: delta5hEq1w,
    delta_1w_eq: delta1wEq,
    segment_delta_1w_units: validDeltas.length === 0 ? null : Math.max(...validDeltas),
  };
}

function buildObservedRatioDiagnostic(
  dimension: "plan",
  key: string,
  metrics: WatchHistorySegmentMetrics[],
): WatchHistoryObservedRatioDiagnostic {
  const ratios = metrics.map((segment) => (segment.delta_5h_raw ?? 0) / (segment.delta_1w_raw ?? 1));
  const observedMean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  const variance =
    ratios.reduce((sum, value) => sum + (value - observedMean) ** 2, 0) / ratios.length;
  const total5h = metrics.reduce((sum, segment) => sum + (segment.delta_5h_raw ?? 0), 0);
  const total1w = metrics.reduce((sum, segment) => sum + (segment.delta_1w_raw ?? 0), 0);
  const expected = Number.isFinite(resolveFiveHourToOneWeekRawRatio(key))
    ? resolveFiveHourToOneWeekRawRatio(key)
    : null;
  const weighted = total1w > 0 ? total5h / total1w : observedMean;
  const relativeDelta = expected && expected > 0 ? (weighted - expected) / expected : null;

  return {
    dimension,
    key,
    sample_count: metrics.length,
    observed_mean_raw_ratio: roundToTwo(observedMean),
    observed_weighted_raw_ratio: roundToTwo(weighted),
    variance: roundToTwo(variance),
    expected_raw_ratio: expected === null ? null : roundToTwo(expected),
    relative_delta: relativeDelta === null ? null : roundToTwo(relativeDelta),
    warning:
      relativeDelta !== null &&
      metrics.length >= WATCH_HISTORY_RATIO_WARNING_MIN_SAMPLES &&
      Math.abs(relativeDelta) >= WATCH_HISTORY_RATIO_WARNING_RELATIVE_DELTA,
  };
}

function isSyntheticProObservedRatioRecord(record: WatchHistoryRecord): boolean {
  if (record.plan_type !== PROXY_PLAN_TYPE) {
    return false;
  }

  return (
    record.account_name === PROXY_ACCOUNT_NAME
    || record.account_id === PROXY_ACCOUNT_ID
    || record.identity === PROXY_IDENTITY
  );
}

export function computeWatchObservedRatioDiagnostics(
  history: WatchHistoryRecord[],
  now = new Date(),
): WatchHistoryObservedRatioDiagnostic[] {
  const recentHistory = history
    .filter((record) => isInsideObservedRatioWindow(record.recorded_at, now))
    .filter((record) => !isSyntheticProObservedRatioRecord(record))
    .sort((left, right) => Date.parse(left.recorded_at) - Date.parse(right.recorded_at));

  const metrics = collectContinuousSegments(recentHistory)
    .map(toSegmentMetrics)
    .filter(
      (segment) =>
        typeof segment.delta_5h_raw === "number" &&
        typeof segment.delta_1w_raw === "number" &&
        segment.delta_1w_raw > 0,
    );

  const groups = new Map<string, WatchHistorySegmentMetrics[]>();
  const pushGroup = (dimension: "plan", key: string, segment: WatchHistorySegmentMetrics) => {
    const groupKey = `${dimension}:${key}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.push(segment);
      return;
    }
    groups.set(groupKey, [segment]);
  };

  for (const segment of metrics) {
    if (segment.end.plan_type) {
      pushGroup("plan", segment.end.plan_type, segment);
    }
  }

  return [...groups.entries()]
    .map(([groupKey, groupMetrics]) => {
      const [dimension, key] = groupKey.split(":", 2) as ["plan", string];
      return buildObservedRatioDiagnostic(dimension, key, groupMetrics);
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function computeRemainingPercent(window: WatchHistoryWindowSnapshot | null): number | null {
  if (!window) {
    return null;
  }

  return roundToTwo(clampPercent(100 - window.used_percent));
}

function computeRemainingContext(target: WatchHistoryTargetSnapshot, planType: string | null) {
  const remaining5h =
    typeof target.remaining_5h === "number"
      ? roundToTwo(clampPercent(target.remaining_5h))
      : computeRemainingPercent(target.five_hour);
  const remaining1wPercent = computeRemainingPercent(target.one_week);

  const remaining5hEq1w =
    typeof target.remaining_5h_eq_1w === "number"
      ? roundToTwo(Math.max(0, target.remaining_5h_eq_1w))
      : remaining5h === null
        ? null
        : convertFiveHourPercentToWeeklyEquivalent(remaining5h, planType ?? target.plan_type);
  const remaining1wEq =
    typeof target.remaining_1w === "number"
      ? roundToTwo(Math.max(0, target.remaining_1w))
      : remaining1wPercent === null
        ? null
        : convertOneWeekPercentToPlusWeeklyUnits(remaining1wPercent, planType ?? target.plan_type);

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
    left.scope_kind !== right.scope_kind ||
    left.scope_id !== right.scope_id ||
    left.account_name !== right.account_name ||
    (left.upstream_account_name ?? null) !== (right.upstream_account_name ?? null) ||
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

  const segments = collectContinuousSegments(records).map(toSegmentMetrics);
  const validSegments = segments.filter(
    (segment) => typeof segment.segment_delta_1w_units === "number" && segment.elapsedHours > 0,
  );

  if (validSegments.length === 0) {
    return null;
  }

  const totalDelta = validSegments.reduce(
    (sum, segment) => sum + (segment.segment_delta_1w_units ?? 0),
    0,
  );
  const totalHours = validSegments.reduce((sum, segment) => sum + segment.elapsedHours, 0);

  return totalHours <= 0 ? null : roundToTwo(totalDelta / totalHours);
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
