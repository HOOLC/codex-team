import type { AccountQuotaSummary } from "../account-store/index.js";
import type { WatchHistoryEtaContext } from "../watch/history.js";

export interface CurrentListStatusLike {
  exists: boolean;
  matched_accounts: string[];
}

export interface CliQuotaSummary extends Omit<AccountQuotaSummary, "status"> {
  available: string | null;
  refresh_status: AccountQuotaSummary["status"];
}

export interface AutoSwitchCandidate {
  name: string;
  account_id: string;
  identity: string;
  plan_type: string | null;
  available: string | null;
  refresh_status: "ok";
  current_score: number;
  score_1h: number;
  projected_5h_1h: number | null;
  projected_5h_in_1w_units_1h: number | null;
  projected_1w_1h: number | null;
  projected_1w_in_plus_units_1h: number | null;
  remain_5h: number | null;
  remain_5h_in_1w_units: number | null;
  remain_1w: number | null;
  remain_1w_in_plus_units: number | null;
  five_hour_to_one_week_ratio: number;
  five_hour_used: number | null;
  one_week_used: number | null;
  five_hour_reset_at: string | null;
  one_week_reset_at: string | null;
}

export interface QuotaEtaSummary {
  status: WatchHistoryEtaContext["status"];
  hours: number | null;
  bottleneck: WatchHistoryEtaContext["bottleneck"];
  eta_5h_eq_1w_hours: number | null;
  eta_1w_hours: number | null;
  rate_1w_units_per_hour: number | null;
  remaining_5h_eq_1w: number | null;
  remaining_1w: number | null;
}

export type QuotaWindowKey = "five_hour" | "one_week";
