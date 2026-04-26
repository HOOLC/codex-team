import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function formatTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return dayjs.utc(value).tz(dayjs.tz.guess()).format("YYYY-MM-DD HH:mm");
}

export function formatClock(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return dayjs.utc(value).tz(dayjs.tz.guess()).format("HH:mm");
}

export function formatMonthDayTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  return `${formatTwoDigits(date.getMonth() + 1)}-${formatTwoDigits(date.getDate())} ${formatTwoDigits(date.getHours())}:${formatTwoDigits(date.getMinutes())}`;
}

export function formatResetAt(value: string | null | undefined, now = new Date()): string {
  if (!value) {
    return "-";
  }

  const resetAfterSeconds = Math.round((Date.parse(value) - now.getTime()) / 1_000);
  if (!Number.isFinite(resetAfterSeconds) || resetAfterSeconds <= 0) {
    return "-";
  }

  return dayjs.utc(value).tz(dayjs.tz.guess()).format("MM-DD HH:mm");
}

export function formatRelativeOffsetCompact(offsetMs: number): string {
  const absMs = Math.abs(offsetMs);
  if (absMs < 60_000) {
    return "now";
  }

  const minutes = absMs / 60_000;
  if (minutes < 60) {
    return `${Math.max(1, Math.round(minutes))}m`;
  }

  const hours = absMs / 3_600_000;
  if (hours < 24) {
    const value = hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
    return `${value.replace(/\.0$/u, "")}h`;
  }

  const days = absMs / 86_400_000;
  const value = days < 10 ? days.toFixed(1) : String(Math.round(days));
  return `${value.replace(/\.0$/u, "")}d`;
}

export function formatRelativeOffsetLabel(
  value: string | null | undefined,
  now: Date,
): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const compact = formatRelativeOffsetCompact(timestamp - now.getTime());
  if (compact === "now") {
    return "now";
  }

  return timestamp >= now.getTime() ? `in ${compact}` : `${compact} ago`;
}

export function formatDateTimeWithRelative(
  value: string | null | undefined,
  now: Date,
): string {
  const absolute = formatDateTime(value);
  if (absolute === "-") {
    return absolute;
  }

  const relative = formatRelativeOffsetLabel(value, now);
  return relative ? `${absolute} (${relative})` : absolute;
}
