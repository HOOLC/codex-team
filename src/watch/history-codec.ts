import type {
  WatchHistoryRecord,
  WatchHistoryTargetSnapshot,
  WatchHistoryWindowSnapshot,
} from "./history-types.js";
import { clampPercent, isValidDate, roundToTwo } from "./history-math.js";

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
    scope_kind: candidate.scope_kind === "isolated" ? "isolated" : "global",
    scope_id: typeof candidate.scope_id === "string" ? candidate.scope_id : null,
    account_name: candidate.account_name,
    upstream_account_name:
      candidate.upstream_account_name === null || typeof candidate.upstream_account_name === "string"
        ? candidate.upstream_account_name
        : null,
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

export function parseWatchHistoryLine(line: string): WatchHistoryRecord | null {
  if (line.trim() === "") {
    return null;
  }

  try {
    return parseWatchHistoryRecord(JSON.parse(line));
  } catch {
    return null;
  }
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

export function normalizeRecordInput(raw: unknown): WatchHistoryRecord {
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

  const scopeKind =
    candidate.scope_kind === "isolated" || candidate.scopeKind === "isolated"
      ? "isolated"
      : "global";
  const scopeId =
    typeof candidate.scope_id === "string"
      ? candidate.scope_id
      : typeof candidate.scopeId === "string"
        ? candidate.scopeId
        : null;

  const accountId =
    candidate.account_id === null || typeof candidate.account_id === "string"
      ? candidate.account_id
      : candidate.accountId === null || typeof candidate.accountId === "string"
        ? candidate.accountId
        : null;
  const upstreamAccountName =
    candidate.upstream_account_name === null || typeof candidate.upstream_account_name === "string"
      ? candidate.upstream_account_name
      : candidate.upstreamAccountName === null || typeof candidate.upstreamAccountName === "string"
        ? candidate.upstreamAccountName
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
    scope_kind: scopeKind,
    scope_id: scopeId,
    account_name: accountName,
    ...(upstreamAccountName !== null ? { upstream_account_name: upstreamAccountName } : {}),
    account_id: accountId,
    identity,
    plan_type: planType,
    available,
    five_hour: fiveHour,
    one_week: oneWeek,
    source: "watch",
  };
}

export function normalizeTargetSnapshot(raw: unknown): WatchHistoryTargetSnapshot {
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
  const remaining5h =
    typeof candidate.remaining_5h === "number"
      ? candidate.remaining_5h
      : typeof candidate.remaining5h === "number"
        ? candidate.remaining5h
        : undefined;
  const remaining1w =
    typeof candidate.remaining_1w === "number"
      ? candidate.remaining_1w
      : typeof candidate.remaining1w === "number"
        ? candidate.remaining1w
        : undefined;
  const remaining5hEq1w =
    typeof candidate.remaining_5h_eq_1w === "number"
      ? candidate.remaining_5h_eq_1w
      : typeof candidate.remaining5hEq1w === "number"
        ? candidate.remaining5hEq1w
        : undefined;

  return {
    plan_type: planType,
    available,
    five_hour: normalizeWindowInput(candidate.five_hour ?? candidate.fiveHour),
    one_week: normalizeWindowInput(candidate.one_week ?? candidate.oneWeek),
    ...(typeof remaining5h === "number" && Number.isFinite(remaining5h)
      ? { remaining_5h: roundToTwo(clampPercent(remaining5h)) }
      : {}),
    ...(typeof remaining1w === "number" && Number.isFinite(remaining1w)
      ? { remaining_1w: roundToTwo(Math.max(0, remaining1w)) }
      : {}),
    ...(typeof remaining5hEq1w === "number" && Number.isFinite(remaining5hEq1w)
      ? { remaining_5h_eq_1w: roundToTwo(Math.max(0, remaining5hEq1w)) }
      : {}),
  };
}
