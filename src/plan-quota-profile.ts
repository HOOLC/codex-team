export type PlanQuotaTier = "plus" | "prolite" | "pro" | "team" | "unknown";

export interface PlanQuotaProfile {
  fiveHourToOneWeekRawRatio: number;
  oneWeekCapacityInPlusUnits: number;
}

const DIRECT_FIVE_HOUR_TO_ONE_WEEK_RAW_RATIO = 20 / 3;
const PRO_FIVE_HOUR_TO_ONE_WEEK_RAW_RATIO = 50 / 9;

const PLAN_QUOTA_PROFILES: Record<PlanQuotaTier, PlanQuotaProfile> = {
  plus: {
    fiveHourToOneWeekRawRatio: DIRECT_FIVE_HOUR_TO_ONE_WEEK_RAW_RATIO,
    oneWeekCapacityInPlusUnits: 1,
  },
  prolite: {
    fiveHourToOneWeekRawRatio: PRO_FIVE_HOUR_TO_ONE_WEEK_RAW_RATIO,
    oneWeekCapacityInPlusUnits: 25 / 6,
  },
  pro: {
    fiveHourToOneWeekRawRatio: PRO_FIVE_HOUR_TO_ONE_WEEK_RAW_RATIO,
    oneWeekCapacityInPlusUnits: 25 / 3,
  },
  team: {
    fiveHourToOneWeekRawRatio: DIRECT_FIVE_HOUR_TO_ONE_WEEK_RAW_RATIO,
    oneWeekCapacityInPlusUnits: 1,
  },
  unknown: {
    fiveHourToOneWeekRawRatio: DIRECT_FIVE_HOUR_TO_ONE_WEEK_RAW_RATIO,
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

  const profile = getPlanQuotaProfile(planType);
  return roundToTwo(
    (fiveHourPercent / profile.fiveHourToOneWeekRawRatio) * profile.oneWeekCapacityInPlusUnits,
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

  const profile = getPlanQuotaProfile(planType);
  const normalized =
    (rawScore / profile.oneWeekCapacityInPlusUnits) * profile.fiveHourToOneWeekRawRatio;

  return roundToTwo(options.clamp === false ? normalized : Math.min(100, normalized));
}

export function resolveFiveHourToOneWeekRawRatio(planType: string | null): number {
  return roundToTwo(getPlanQuotaProfile(planType).fiveHourToOneWeekRawRatio);
}
