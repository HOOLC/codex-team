import type { AccountQuotaSummary } from "../account-store/index.js";
import {
  convertFiveHourPercentToPlusWeeklyUnits,
  convertOneWeekPercentToPlusWeeklyUnits,
  resolveFiveHourToOneWeekRawRatio,
} from "../plan-quota-profile.js";
import { computeAvailability } from "./quota-core.js";
import type { AutoSwitchCandidate, QuotaWindowKey } from "./quota-types.js";

const AUTO_SWITCH_PROJECTION_HORIZON_SECONDS = 3_600;
const AUTO_SWITCH_CURRENT_SCORE_TIEBREAK_DELTA = 5;

function computeRemainingPercent(usedPercent: number | undefined): number | null {
  if (typeof usedPercent !== "number") {
    return null;
  }

  return Math.max(0, 100 - usedPercent);
}

function roundScore(value: number): number {
  return Number(value.toFixed(2));
}

function computeProjectedRemainingPercent(
  fetchedAt: string | null,
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): number | null {
  if (!window || typeof window.used_percent !== "number") {
    return null;
  }

  const remaining = computeRemainingPercent(window.used_percent);
  if (remaining === null) {
    return null;
  }

  if (!fetchedAt || !window.reset_at) {
    return remaining;
  }

  const fetchedAtMs = Date.parse(fetchedAt);
  const resetAtMs = Date.parse(window.reset_at);
  if (Number.isNaN(fetchedAtMs) || Number.isNaN(resetAtMs)) {
    return remaining;
  }

  const horizonSeconds = AUTO_SWITCH_PROJECTION_HORIZON_SECONDS;
  const timeUntilResetSeconds = Math.max(0, (resetAtMs - fetchedAtMs) / 1000);
  if (timeUntilResetSeconds >= horizonSeconds) {
    return remaining;
  }

  const beforeResetSeconds = Math.min(horizonSeconds, timeUntilResetSeconds);
  const afterResetSeconds = horizonSeconds - beforeResetSeconds;
  return roundScore((remaining * beforeResetSeconds + 100 * afterResetSeconds) / horizonSeconds);
}

function compareNullableNumberDescending(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return right - left;
}

function compareNullableDateAscending(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left.localeCompare(right);
}

function resolveBottleneckScore(left: number | null, right: number | null): number | null {
  if (left !== null && right !== null) {
    return Math.min(left, right);
  }

  return left ?? right;
}

function resolveBottleneckWindows(
  fiveHourScore: number | null,
  oneWeekScore: number | null,
): QuotaWindowKey[] {
  if (fiveHourScore !== null && oneWeekScore !== null) {
    if (fiveHourScore < oneWeekScore) {
      return ["five_hour"];
    }
    if (oneWeekScore < fiveHourScore) {
      return ["one_week"];
    }
    return ["five_hour", "one_week"];
  }

  if (fiveHourScore !== null) {
    return ["five_hour"];
  }

  if (oneWeekScore !== null) {
    return ["one_week"];
  }

  return [];
}

function getCandidateResetAt(candidate: AutoSwitchCandidate, window: QuotaWindowKey): string | null {
  return window === "five_hour" ? candidate.five_hour_reset_at : candidate.one_week_reset_at;
}

function getEarliestResetAt(
  candidate: AutoSwitchCandidate,
  windows: QuotaWindowKey[],
): string | null {
  return windows
    .map((window) => getCandidateResetAt(candidate, window))
    .filter((resetAt): resetAt is string => resetAt !== null)
    .sort((left, right) => left.localeCompare(right))[0] ?? null;
}

function getLatestResetAt(
  candidate: AutoSwitchCandidate,
  windows: QuotaWindowKey[],
): string | null {
  return windows
    .map((window) => getCandidateResetAt(candidate, window))
    .filter((resetAt): resetAt is string => resetAt !== null)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;
}

function resolveExhaustedWindows(candidate: AutoSwitchCandidate): QuotaWindowKey[] {
  const windows: QuotaWindowKey[] = [];

  if (candidate.remain_5h === 0) {
    windows.push("five_hour");
  }

  if (candidate.remain_1w === 0) {
    windows.push("one_week");
  }

  return windows;
}

function getRecoveryResetAt(candidate: AutoSwitchCandidate): string | null {
  return getLatestResetAt(candidate, resolveExhaustedWindows(candidate));
}

function getCurrentNextResetAt(candidate: AutoSwitchCandidate): string | null {
  const recoveryResetAt = getRecoveryResetAt(candidate);
  if (recoveryResetAt !== null) {
    return recoveryResetAt;
  }

  return getEarliestResetAt(
    candidate,
    resolveBottleneckWindows(candidate.remain_5h_in_1w_units, candidate.remain_1w_in_plus_units),
  );
}

export function selectCurrentNextResetWindow(
  account: AccountQuotaSummary,
  candidate: AutoSwitchCandidate,
): AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"] {
  const nextResetAt = getCurrentNextResetAt(candidate);
  if (!nextResetAt) {
    return null;
  }

  const candidateWindows = [account.five_hour, account.one_week].filter(
    (window): window is NonNullable<AccountQuotaSummary["five_hour"]> =>
      window !== null && window.reset_at === nextResetAt,
  );

  return candidateWindows[0] ?? null;
}

function compareCandidateResets(
  left: AutoSwitchCandidate,
  right: AutoSwitchCandidate,
  options: {
    fiveHourScore: (candidate: AutoSwitchCandidate) => number | null;
    oneWeekScore: (candidate: AutoSwitchCandidate) => number | null;
  },
): number {
  const leftRecoveryResetAt = getRecoveryResetAt(left);
  const rightRecoveryResetAt = getRecoveryResetAt(right);
  const recoveryResetOrder = compareNullableDateAscending(leftRecoveryResetAt, rightRecoveryResetAt);
  if (leftRecoveryResetAt !== null || rightRecoveryResetAt !== null) {
    if (recoveryResetOrder !== 0) {
      return recoveryResetOrder;
    }
  }

  const leftBottleneckWindows = resolveBottleneckWindows(
    options.fiveHourScore(left),
    options.oneWeekScore(left),
  );
  const rightBottleneckWindows = resolveBottleneckWindows(
    options.fiveHourScore(right),
    options.oneWeekScore(right),
  );

  const primaryResetOrder = compareNullableDateAscending(
    getEarliestResetAt(left, leftBottleneckWindows),
    getEarliestResetAt(right, rightBottleneckWindows),
  );
  if (primaryResetOrder !== 0) {
    return primaryResetOrder;
  }

  const leftSecondaryWindows = (["five_hour", "one_week"] as QuotaWindowKey[]).filter(
    (window) => !leftBottleneckWindows.includes(window),
  );
  const rightSecondaryWindows = (["five_hour", "one_week"] as QuotaWindowKey[]).filter(
    (window) => !rightBottleneckWindows.includes(window),
  );

  return compareNullableDateAscending(
    getEarliestResetAt(left, leftSecondaryWindows),
    getEarliestResetAt(right, rightSecondaryWindows),
  );
}

export function toAutoSwitchCandidate(account: AccountQuotaSummary): AutoSwitchCandidate | null {
  if (account.status !== "ok") {
    return null;
  }

  const fiveHourToOneWeekRatio = resolveFiveHourToOneWeekRawRatio(account.plan_type);
  const remain5h = computeRemainingPercent(account.five_hour?.used_percent);
  const remain1w = computeRemainingPercent(account.one_week?.used_percent);
  if (remain5h === null && remain1w === null) {
    return null;
  }

  const remain5hEq1w = convertFiveHourPercentToPlusWeeklyUnits(remain5h, account.plan_type);
  const remain1wEq = convertOneWeekPercentToPlusWeeklyUnits(remain1w, account.plan_type);
  const projected5hScore = computeProjectedRemainingPercent(account.fetched_at, account.five_hour);
  const projected5hEq1wScore = convertFiveHourPercentToPlusWeeklyUnits(
    projected5hScore,
    account.plan_type,
  );
  const projected1wScore = computeProjectedRemainingPercent(account.fetched_at, account.one_week);
  const projected1wEqScore = convertOneWeekPercentToPlusWeeklyUnits(
    projected1wScore,
    account.plan_type,
  );
  const currentScore = resolveBottleneckScore(remain5hEq1w, remain1wEq);
  const effectiveScore = resolveBottleneckScore(projected5hEq1wScore, projected1wEqScore);

  if (currentScore === null || effectiveScore === null) {
    return null;
  }

  return {
    name: account.name,
    account_id: account.account_id,
    identity: account.identity,
    plan_type: account.plan_type,
    available: computeAvailability(account),
    refresh_status: "ok",
    current_score: currentScore,
    score_1h: effectiveScore,
    projected_5h_1h: projected5hScore,
    projected_5h_in_1w_units_1h: projected5hEq1wScore,
    projected_1w_1h: projected1wScore,
    projected_1w_in_plus_units_1h: projected1wEqScore,
    remain_5h: remain5h,
    remain_5h_in_1w_units: remain5hEq1w,
    remain_1w: remain1w,
    remain_1w_in_plus_units: remain1wEq,
    five_hour_to_one_week_ratio: fiveHourToOneWeekRatio,
    five_hour_used: account.five_hour?.used_percent ?? null,
    one_week_used: account.one_week?.used_percent ?? null,
    five_hour_reset_at: account.five_hour?.reset_at ?? null,
    one_week_reset_at: account.one_week?.reset_at ?? null,
  };
}

export function rankAutoSwitchCandidates(accounts: AccountQuotaSummary[]): AutoSwitchCandidate[] {
  return accounts
    .map(toAutoSwitchCandidate)
    .filter((candidate): candidate is AutoSwitchCandidate => candidate !== null)
    .sort((left, right) => {
      const currentScoreGap = Math.abs(right.current_score - left.current_score);
      if (currentScoreGap > AUTO_SWITCH_CURRENT_SCORE_TIEBREAK_DELTA) {
        return right.current_score - left.current_score;
      }
      if (right.score_1h !== left.score_1h) {
        return right.score_1h - left.score_1h;
      }
      if (right.current_score !== left.current_score) {
        return right.current_score - left.current_score;
      }
      const projected5hOrder = compareNullableNumberDescending(
        left.projected_5h_in_1w_units_1h,
        right.projected_5h_in_1w_units_1h,
      );
      if (projected5hOrder !== 0) {
        return projected5hOrder;
      }
      const projected1wOrder = compareNullableNumberDescending(
        left.projected_1w_in_plus_units_1h,
        right.projected_1w_in_plus_units_1h,
      );
      if (projected1wOrder !== 0) {
        return projected1wOrder;
      }
      const remain5hOrder = compareNullableNumberDescending(
        left.remain_5h_in_1w_units,
        right.remain_5h_in_1w_units,
      );
      if (remain5hOrder !== 0) {
        return remain5hOrder;
      }
      const remain1wOrder = compareNullableNumberDescending(
        left.remain_1w_in_plus_units,
        right.remain_1w_in_plus_units,
      );
      if (remain1wOrder !== 0) {
        return remain1wOrder;
      }

      const resetOrder = compareCandidateResets(left, right, {
        fiveHourScore: (candidate) => candidate.projected_5h_in_1w_units_1h,
        oneWeekScore: (candidate) => candidate.projected_1w_in_plus_units_1h,
      });
      if (resetOrder !== 0) {
        return resetOrder;
      }

      return left.name.localeCompare(right.name);
    });
}

export function rankListCandidates(accounts: AccountQuotaSummary[]): AutoSwitchCandidate[] {
  return accounts
    .map(toAutoSwitchCandidate)
    .filter((candidate): candidate is AutoSwitchCandidate => candidate !== null)
    .sort((left, right) => {
      if (right.current_score !== left.current_score) {
        return right.current_score - left.current_score;
      }

      if (left.current_score === 0 && right.current_score === 0) {
        const resetOrder = compareCandidateResets(left, right, {
          fiveHourScore: (candidate) => candidate.remain_5h_in_1w_units,
          oneWeekScore: (candidate) => candidate.remain_1w_in_plus_units,
        });
        if (resetOrder !== 0) {
          return resetOrder;
        }

        if (right.score_1h !== left.score_1h) {
          return right.score_1h - left.score_1h;
        }
      }

      const remain5hOrder = compareNullableNumberDescending(
        left.remain_5h_in_1w_units,
        right.remain_5h_in_1w_units,
      );
      if (remain5hOrder !== 0) {
        return remain5hOrder;
      }

      const remain1wOrder = compareNullableNumberDescending(
        left.remain_1w_in_plus_units,
        right.remain_1w_in_plus_units,
      );
      if (remain1wOrder !== 0) {
        return remain1wOrder;
      }

      const resetOrder = compareCandidateResets(left, right, {
        fiveHourScore: (candidate) => candidate.remain_5h_in_1w_units,
        oneWeekScore: (candidate) => candidate.remain_1w_in_plus_units,
      });
      if (resetOrder !== 0) {
        return resetOrder;
      }

      return left.name.localeCompare(right.name);
    });
}
