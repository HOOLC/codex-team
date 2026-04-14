import type { AccountQuotaSummary } from "../account-store/index.js";
import { computeAvailability } from "./quota-core.js";
import { toAutoSwitchCandidate } from "./quota-ranking.js";

function isWindowUnavailable(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): boolean {
  return typeof window?.used_percent === "number" && window.used_percent >= 100;
}

function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

function formatPoolValue(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return String(roundToTwo(value / 100));
}

export function buildListSummary(accounts: AccountQuotaSummary[]): {
  summaryLine: string;
  poolLine: string;
} {
  const planCounts = new Map<string, number>();
  let usableCount = 0;
  let oneWeekBlockedCount = 0;
  let fiveHourBlockedCount = 0;
  let poolFiveHour = 0;
  let poolOneWeek = 0;
  let hasPoolFiveHour = false;
  let hasPoolOneWeek = false;

  for (const account of accounts) {
    const plan = account.plan_type ?? "unknown";
    planCounts.set(plan, (planCounts.get(plan) ?? 0) + 1);

    const availability = computeAvailability(account);
    if (availability === "available") {
      usableCount += 1;
    }

    const oneWeekBlocked = isWindowUnavailable(account.one_week);
    const fiveHourBlocked = isWindowUnavailable(account.five_hour);
    if (oneWeekBlocked) {
      oneWeekBlockedCount += 1;
    } else if (fiveHourBlocked) {
      fiveHourBlockedCount += 1;
    }

    const candidate = toAutoSwitchCandidate(account);
    if (!candidate || availability !== "available") {
      continue;
    }

    if (candidate.remain_5h_in_1w_units !== null) {
      poolFiveHour += candidate.remain_5h_in_1w_units;
      hasPoolFiveHour = true;
    }
    if (candidate.remain_1w_in_plus_units !== null) {
      poolOneWeek += candidate.remain_1w_in_plus_units;
      hasPoolOneWeek = true;
    }
  }

  const plansSegment = [...planCounts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([plan, count]) => `${plan} x${count}`)
    .join(", ");

  const blockedSegment = `blocked: 1W ${oneWeekBlockedCount}, 5H ${fiveHourBlockedCount}`;

  const summaryLine = `Accounts: ${usableCount}/${accounts.length} usable | ${blockedSegment}${
    plansSegment ? ` | ${plansSegment}` : ""
  }`;

  const fiveHourPool = hasPoolFiveHour ? roundToTwo(poolFiveHour) : null;
  const oneWeekPool = hasPoolOneWeek ? roundToTwo(poolOneWeek) : null;
  const bottleneckPool =
    fiveHourPool !== null && oneWeekPool !== null
      ? roundToTwo(Math.min(fiveHourPool, oneWeekPool))
      : fiveHourPool ?? oneWeekPool;

  const poolLine =
    `Available: bottleneck ${formatPoolValue(bottleneckPool)} | ` +
    `5H->1W ${formatPoolValue(fiveHourPool)} | ` +
    `1W ${formatPoolValue(oneWeekPool)} (plus 1W)`;

  return {
    summaryLine,
    poolLine,
  };
}
