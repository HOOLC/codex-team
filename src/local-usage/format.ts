import type {
  LocalUsageSummary,
  LocalUsageDailyEntry,
  LocalUsageTotals,
} from "./types.js";

export type LocalUsageWindowName = "today" | "7d" | "30d" | "all-time";

export const LOCAL_USAGE_WINDOWS: LocalUsageWindowName[] = ["today", "7d", "30d", "all-time"];

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(absolute >= 10_000_000_000 ? 0 : 1)}b`;
  }
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}m`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}k`;
  }
  return String(value);
}

function formatCompactUsd(value: number): string {
  if (value === 0) {
    return "$0";
  }
  if (Math.abs(value) >= 1_000) {
    return `$${formatCompactNumber(Number(value.toFixed(1)))}`;
  }
  if (Math.abs(value) >= 1) {
    return `$${value.toFixed(value >= 10 ? 1 : 2)}`;
  }
  if (Math.abs(value) >= 0.01) {
    return `$${value.toFixed(3)}`;
  }
  if (Math.abs(value) >= 0.001) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toPrecision(2)}`;
}

export function formatLocalUsageWindowLine(
  label: string,
  totals: LocalUsageTotals,
): string {
  const line = [
    `Usage ${label}:`,
    `in ${formatCompactNumber(totals.input_tokens)}/${formatCompactUsd(totals.estimated_input_cost_usd)}`,
    `out ${formatCompactNumber(totals.output_tokens)}/${formatCompactUsd(totals.estimated_output_cost_usd)}`,
    `total ${formatCompactNumber(totals.total_tokens)}/${formatCompactUsd(totals.estimated_total_cost_usd)}`,
  ];

  if (totals.unpriced_tokens > 0) {
    line.push(`unpriced ${formatCompactNumber(totals.unpriced_tokens)}`);
  }

  return line.join(" | ");
}

export function formatLocalUsageDailyLine(entry: LocalUsageDailyEntry): string {
  let line = `${entry.date}: total ${formatCompactNumber(entry.total_tokens)}/${formatCompactUsd(entry.estimated_total_cost_usd)}`;
  if (entry.unpriced_tokens > 0) {
    line += ` | unpriced ${formatCompactNumber(entry.unpriced_tokens)}`;
  }
  return line;
}

function formatTuiWindowCompact(label: string, totals: LocalUsageTotals): string {
  return `${label} ${formatCompactNumber(totals.total_tokens)}/${formatCompactUsd(totals.estimated_total_cost_usd)}`;
}

function formatTuiWindowDetailed(label: string, totals: LocalUsageTotals): string {
  return `${label} in ${formatCompactNumber(totals.input_tokens)}/${formatCompactUsd(totals.estimated_input_cost_usd)} out ${formatCompactNumber(totals.output_tokens)}/${formatCompactUsd(totals.estimated_output_cost_usd)}`;
}

export function formatTuiUsageSummaryLine(summary: LocalUsageSummary, width: number): string {
  const compact = `Usage: ${formatTuiWindowCompact("today", summary.windows.today)} | ${formatTuiWindowCompact("7d", summary.windows["7d"])}`;
  if (width < 104) {
    return compact;
  }

  return `Usage: ${formatTuiWindowDetailed("today", summary.windows.today)} | ${formatTuiWindowDetailed("7d", summary.windows["7d"])}`;
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

function shiftDate(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function selectTrendWindow(width: number, height: number): 30 | 14 | 7 | null {
  if (height < 22) {
    return null;
  }
  if (width >= 112) {
    return 30;
  }
  if (width >= 88) {
    return 14;
  }
  if (width >= 72) {
    return 7;
  }
  return null;
}

function aggregateBins(values: number[], count: number): number[] {
  if (count >= values.length) {
    return values;
  }

  const bins: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * values.length / count);
    const end = Math.floor((index + 1) * values.length / count);
    const slice = values.slice(start, Math.max(start + 1, end));
    bins.push(slice.reduce((sum, value) => sum + value, 0));
  }
  return bins;
}

export function formatTuiUsageTrendLine(summary: LocalUsageSummary, width: number, height: number): string | null {
  const windowDays = selectTrendWindow(width, height);
  if (!windowDays) {
    return null;
  }

  const prefix = `Trend ${windowDays}d: `;
  const availableColumns = Math.max(0, width - prefix.length);
  if (availableColumns < 4) {
    return null;
  }

  const byDate = new Map(summary.daily.map((entry) => [entry.date, entry.total_tokens] as const));
  const now = new Date(summary.generated_at);
  const values: number[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const dateKey = localDateKey(shiftDate(now, -offset), summary.timezone);
    values.push(byDate.get(dateKey) ?? 0);
  }

  const bins = aggregateBins(values, Math.min(values.length, availableColumns));
  const maxValue = Math.max(...bins, 0);
  const glyphs = "▁▂▃▄▅▆▇█";
  const sparkline = maxValue === 0
    ? "·".repeat(bins.length)
    : bins
      .map((value) => glyphs[Math.max(0, Math.min(glyphs.length - 1, Math.round((value / maxValue) * (glyphs.length - 1))))] ?? "·")
      .join("");

  return `${prefix}${sparkline}`;
}
