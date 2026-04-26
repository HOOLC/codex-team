export interface WatchHistoryWindowSnapshot {
  used_percent: number;
  window_seconds?: number | null;
  reset_at: string | null;
}

export interface WatchHistoryRecord {
  recorded_at: string;
  scope_kind: "global" | "isolated";
  scope_id: string | null;
  account_name: string;
  upstream_account_name?: string | null;
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
  remaining_5h?: number | null;
  remaining_1w?: number | null;
  remaining_5h_eq_1w?: number | null;
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
export type WatchHistoryScopeKind = WatchHistoryRecord["scope_kind"];

export interface WatchHistoryObservedRatioDiagnostic {
  dimension: "plan";
  key: string;
  sample_count: number;
  observed_mean_raw_ratio: number;
  observed_weighted_raw_ratio: number;
  variance: number;
  expected_raw_ratio: number | null;
  relative_delta: number | null;
  warning: boolean;
}
