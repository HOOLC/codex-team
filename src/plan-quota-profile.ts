export type PlanQuotaTier = "plus" | "prolite" | "pro" | "team" | "unknown";

export interface PlanQuotaProfile {
  fiveHourCapacityInPlusUnits: number;
  oneWeekCapacityInPlusUnits: number;
}

const PLUS_WEEKLY_FIVE_HOUR_WINDOWS = 8;

const PLAN_QUOTA_PROFILES: Record<PlanQuotaTier, PlanQuotaProfile> = {
  plus: {
    fiveHourCapacityInPlusUnits: 1.28,
    oneWeekCapacityInPlusUnits: 1,
  },
  prolite: {
    fiveHourCapacityInPlusUnits: 5,
    oneWeekCapacityInPlusUnits: 4.165,
  },
  pro: {
    fiveHourCapacityInPlusUnits: 10,
    oneWeekCapacityInPlusUnits: 8.33,
  },
  team: {
    fiveHourCapacityInPlusUnits: 1.28,
    oneWeekCapacityInPlusUnits: 1,
  },
  unknown: {
    fiveHourCapacityInPlusUnits: 1,
    oneWeekCapacityInPlusUnits: 1,
  },
};

function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

export function resolvePlanQuotaTier(planType: string | null): PlanQuotaTier {
  switch (planType?.trim().toLowerCase()) {
    case "plus":
      return "plus";
    case "prolite":
      return "prolite";
    case "pro":
      return "pro";
    case "team":
      return "team";
    default:
      return "unknown";
  }
}

export function getPlanQuotaProfile(planType: string | null): PlanQuotaProfile {
  return PLAN_QUOTA_PROFILES[resolvePlanQuotaTier(planType)];
}

export function convertFiveHourPercentToPlusWeeklyUnits(
  fiveHourPercent: number | null,
  planType: string | null,
): number | null {
  if (fiveHourPercent === null) {
    return null;
  }

  return roundToTwo(
    (fiveHourPercent * getPlanQuotaProfile(planType).fiveHourCapacityInPlusUnits) /
      PLUS_WEEKLY_FIVE_HOUR_WINDOWS,
  );
}

export function convertOneWeekPercentToPlusWeeklyUnits(
  oneWeekPercent: number | null,
  planType: string | null,
): number | null {
  if (oneWeekPercent === null) {
    return null;
  }

  return roundToTwo(oneWeekPercent * getPlanQuotaProfile(planType).oneWeekCapacityInPlusUnits);
}

export function normalizeDisplayedScore(
  rawScore: number | null,
  planType: string | null,
  options: { clamp?: boolean } = {},
): number | null {
  if (rawScore === null) {
    return null;
  }

  const normalized =
    (rawScore * PLUS_WEEKLY_FIVE_HOUR_WINDOWS) /
    getPlanQuotaProfile(planType).fiveHourCapacityInPlusUnits;

  return roundToTwo(options.clamp === false ? normalized : Math.min(100, normalized));
}

export function resolveFiveHourWindowsPerWeek(planType: string | null): number {
  const profile = getPlanQuotaProfile(planType);
  return roundToTwo(
    (PLUS_WEEKLY_FIVE_HOUR_WINDOWS * profile.oneWeekCapacityInPlusUnits) /
      profile.fiveHourCapacityInPlusUnits,
  );
}
