export interface LocalUsageTotals {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_input_cost_usd: number;
  estimated_output_cost_usd: number;
  estimated_total_cost_usd: number;
  priced_tokens: number;
  unpriced_tokens: number;
}

export interface LocalUsageDailyEntry extends LocalUsageTotals {
  date: string;
}

export interface LocalUsageSummary {
  generated_at: string;
  timezone: string;
  windows: {
    today: LocalUsageTotals;
    "7d": LocalUsageTotals;
    "30d": LocalUsageTotals;
    "all-time": LocalUsageTotals;
  };
  daily: LocalUsageDailyEntry[];
}

export interface LocalUsageTokenSample {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface LocalUsageEvent {
  timestamp: string;
  model: string;
  usage: LocalUsageTokenSample;
}
