import type { AccountQuotaSummary, AccountStore } from "../account-store/index.js";
import type { QuotaWindowSnapshot } from "../auth-snapshot.js";
import { computeAvailability } from "../cli/quota-core.js";
import {
  convertFiveHourPercentToPlusWeeklyUnits,
  convertOneWeekPercentToPlusWeeklyUnits,
} from "../plan-quota-profile.js";
import type { WatchHistoryTargetSnapshot } from "../watch/history.js";
import {
  PROXY_ACCOUNT_ID,
  PROXY_ACCOUNT_NAME,
  PROXY_IDENTITY,
  PROXY_PLAN_TYPE,
  PROXY_USER_ID,
} from "./constants.js";
import { readProxyState } from "./state.js";

interface UsageWindowPayload {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

export interface ProxyUsagePayload {
  plan_type: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window?: UsageWindowPayload;
    secondary_window?: UsageWindowPayload;
  };
  additional_rate_limits: unknown[];
  credits: {
    has_credits: boolean;
    unlimited: boolean;
    balance: string;
  };
}

export interface ProxyWhamAccountPayload {
  id: string;
  account_user_id: string;
  structure: "personal";
  plan_type: string;
  name: string;
  profile_picture_url: null;
  rate_limit: ProxyUsagePayload["rate_limit"];
  additional_rate_limits: ProxyUsagePayload["additional_rate_limits"];
  credits: ProxyUsagePayload["credits"];
}

export interface ProxyWhamAccountsCheckPayload {
  accounts: ProxyWhamAccountPayload[];
  default_account_id: string;
  account_ordering: string[];
}

export interface ProxyAutoTopUpSettingsPayload {
  is_enabled: boolean;
  recharge_threshold: number | null;
  recharge_target: number | null;
}

export interface ProxyAccountCheckV4Payload {
  accounts: Record<string, {
    account: {
      account_user_role: "owner";
    };
    entitlement: {
      billing_currency: string;
    };
  }>;
}

export interface ProxyQuotaAggregate {
  displayProfile: {
    fiveHourCapacityInPlusUnits: number | null;
    oneWeekCapacityInPlusUnits: number | null;
    fiveHourToOneWeekRawRatio: number | null;
  };
  summary: AccountQuotaSummary;
  watchEtaTarget: WatchHistoryTargetSnapshot;
}

function roundToOne(value: number): number {
  return Number(value.toFixed(1));
}

function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function toUsagePercent(value: number): number {
  return Math.round(clampPercent(value));
}

function eligibleForProxyPool(account: AccountQuotaSummary): boolean {
  return account.auto_switch_eligible !== false
    && (
      typeof account.five_hour?.used_percent === "number"
      || typeof account.one_week?.used_percent === "number"
    );
}

interface AggregatedWindowResult {
  capacityPlusUnits: number;
  snapshot: QuotaWindowSnapshot;
  remainingPercent: number;
  remainingPlusUnits: number;
}

function toWatchWindowSnapshot(
  window: QuotaWindowSnapshot | null,
): WatchHistoryTargetSnapshot["five_hour"] {
  if (!window) {
    return null;
  }

  return {
    used_percent: window.used_percent,
    window_seconds: window.window_seconds,
    reset_at: window.reset_at ?? null,
  };
}

function buildEmptyProxyQuotaAggregate(accounts: AccountQuotaSummary[]): ProxyQuotaAggregate {
  const fetchedAt = accounts
    .map((account) => account.fetched_at)
    .filter((value): value is string => typeof value === "string" && value !== "")
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const hasEligibleAccounts = accounts.some((account) => account.auto_switch_eligible !== false);
  const summary: AccountQuotaSummary = {
    name: PROXY_ACCOUNT_NAME,
    account_id: PROXY_ACCOUNT_ID,
    user_id: PROXY_USER_ID,
    identity: PROXY_IDENTITY,
    auto_switch_eligible: true,
    plan_type: PROXY_PLAN_TYPE,
    credits_balance: null,
    status: "stale",
    fetched_at: fetchedAt,
    error_message: accounts.length === 0
      ? "proxy pool has no saved accounts yet"
      : hasEligibleAccounts
        ? "proxy pool has no quota snapshots yet"
        : "proxy pool has no eligible accounts yet",
    unlimited: true,
    five_hour: null,
    one_week: null,
  };

  return {
    displayProfile: {
      fiveHourCapacityInPlusUnits: null,
      oneWeekCapacityInPlusUnits: null,
      fiveHourToOneWeekRawRatio: null,
    },
    summary,
    watchEtaTarget: {
      plan_type: PROXY_PLAN_TYPE,
      available: computeAvailability(summary),
      five_hour: null,
      one_week: null,
    },
  };
}

function resolveWindowCapacityInPlusUnits(
  key: "five_hour" | "one_week",
  planType: string | null,
): number | null {
  return key === "five_hour"
    ? convertFiveHourPercentToPlusWeeklyUnits(100, planType)
    : convertOneWeekPercentToPlusWeeklyUnits(100, planType);
}

function resolveRemainingInPlusUnits(
  key: "five_hour" | "one_week",
  remainingPercent: number,
  planType: string | null,
): number | null {
  return key === "five_hour"
    ? convertFiveHourPercentToPlusWeeklyUnits(remainingPercent, planType)
    : convertOneWeekPercentToPlusWeeklyUnits(remainingPercent, planType);
}

function aggregateWindow(
  accounts: AccountQuotaSummary[],
  key: "five_hour" | "one_week",
): AggregatedWindowResult | null {
  const defaultWindowSeconds = key === "five_hour" ? 18_000 : 604_800;
  let totalCapacity = 0;
  let totalRemaining = 0;
  let firstWindowSeconds: number | null = null;
  let resetAt: string | undefined;

  for (const account of accounts) {
    const window = account[key];
    if (!window || typeof window.used_percent !== "number") {
      continue;
    }

    const capacity = resolveWindowCapacityInPlusUnits(key, account.plan_type);
    if (capacity === null || capacity <= 0) {
      continue;
    }

    const remainingPercent = clampPercent(100 - window.used_percent);
    const remainingPlusUnits = resolveRemainingInPlusUnits(key, remainingPercent, account.plan_type);
    if (remainingPlusUnits === null) {
      continue;
    }

    totalCapacity += capacity;
    totalRemaining += remainingPlusUnits;
    firstWindowSeconds ??= window.window_seconds;

    if (typeof window.reset_at === "string" && window.reset_at !== "") {
      if (!resetAt || Date.parse(window.reset_at) < Date.parse(resetAt)) {
        resetAt = window.reset_at;
      }
    }
  }

  if (totalCapacity <= 0) {
    return null;
  }

  const resetAfterSeconds =
    resetAt && Number.isFinite(Date.parse(resetAt))
      ? Math.max(0, Math.round((Date.parse(resetAt) - Date.now()) / 1000))
      : undefined;
  const remainingPercent = roundToOne((totalRemaining / totalCapacity) * 100);

  return {
    capacityPlusUnits: totalCapacity,
    snapshot: {
      used_percent: roundToOne(Math.max(0, 100 - remainingPercent)),
      window_seconds: firstWindowSeconds ?? defaultWindowSeconds,
      display_precision: 1,
      ...(resetAfterSeconds !== undefined ? { reset_after_seconds: resetAfterSeconds } : {}),
      ...(resetAt ? { reset_at: resetAt } : {}),
    },
    remainingPercent,
    remainingPlusUnits: roundToTwo(totalRemaining),
  };
}

export function buildProxyQuotaAggregateFromAccounts(
  accounts: AccountQuotaSummary[],
): ProxyQuotaAggregate | null {
  const eligibleAccounts = accounts.filter(eligibleForProxyPool);
  if (eligibleAccounts.length === 0) {
    return null;
  }

  const fiveHour = aggregateWindow(eligibleAccounts, "five_hour");
  const oneWeek = aggregateWindow(eligibleAccounts, "one_week");
  const fetchedAt = eligibleAccounts
    .map((account) => account.fetched_at)
    .filter((value): value is string => typeof value === "string" && value !== "")
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date().toISOString();
  const hasOk = eligibleAccounts.some((account) => account.status === "ok");
  const fiveHourCapacityInPlusUnits = fiveHour?.capacityPlusUnits ?? null;
  const oneWeekCapacityInPlusUnits = oneWeek?.capacityPlusUnits ?? null;
  const fiveHourToOneWeekRawRatio =
    fiveHourCapacityInPlusUnits && oneWeekCapacityInPlusUnits
      ? roundToTwo((100 * oneWeekCapacityInPlusUnits) / fiveHourCapacityInPlusUnits)
      : null;

  const summary: AccountQuotaSummary = {
    name: PROXY_ACCOUNT_NAME,
    account_id: PROXY_ACCOUNT_ID,
    user_id: PROXY_USER_ID,
    identity: PROXY_IDENTITY,
    auto_switch_eligible: true,
    plan_type: PROXY_PLAN_TYPE,
    credits_balance: null,
    status: hasOk ? "ok" : "stale",
    fetched_at: fetchedAt,
    error_message: hasOk ? null : "proxy pool is using stale quota snapshots",
    unlimited: true,
    five_hour: fiveHour?.snapshot ?? null,
    one_week: oneWeek?.snapshot ?? null,
  };

  return {
    displayProfile: {
      fiveHourCapacityInPlusUnits,
      oneWeekCapacityInPlusUnits,
      fiveHourToOneWeekRawRatio,
    },
    summary,
    watchEtaTarget: {
      plan_type: PROXY_PLAN_TYPE,
      available: computeAvailability(summary),
      five_hour: toWatchWindowSnapshot(fiveHour?.snapshot ?? null),
      one_week: toWatchWindowSnapshot(oneWeek?.snapshot ?? null),
      ...(fiveHour ? {
        remaining_5h: fiveHour.remainingPercent,
        remaining_5h_eq_1w: fiveHour.remainingPlusUnits,
      } : {}),
      ...(oneWeek ? { remaining_1w: oneWeek.remainingPlusUnits } : {}),
    },
  };
}

export function buildProxyQuotaSummaryFromAccounts(
  accounts: AccountQuotaSummary[],
): AccountQuotaSummary | null {
  return buildProxyQuotaAggregateFromAccounts(accounts)?.summary ?? null;
}

function toUsageWindowPayload(window: QuotaWindowSnapshot | null): UsageWindowPayload | undefined {
  if (!window) {
    return undefined;
  }

  const resetAtSeconds =
    window.reset_at && Number.isFinite(Date.parse(window.reset_at))
      ? Math.floor(Date.parse(window.reset_at) / 1000)
      : undefined;

  return {
    // Codex Desktop currently expects integer used_percent values from
    // /backend-api/wham/usage and rejects floating-point payloads.
    used_percent: toUsagePercent(window.used_percent),
    limit_window_seconds: window.window_seconds,
    ...(window.reset_after_seconds !== undefined
      ? { reset_after_seconds: window.reset_after_seconds }
      : resetAtSeconds !== undefined
        ? { reset_after_seconds: Math.max(0, resetAtSeconds - Math.floor(Date.now() / 1000)) }
        : {}),
    ...(resetAtSeconds !== undefined ? { reset_at: resetAtSeconds } : {}),
  };
}

export function buildProxyUsagePayload(summary: AccountQuotaSummary | null): ProxyUsagePayload {
  const primary = toUsageWindowPayload(summary?.five_hour ?? null);
  const secondary = toUsageWindowPayload(summary?.one_week ?? null);
  const usedPercents = [summary?.five_hour?.used_percent, summary?.one_week?.used_percent]
    .filter((value): value is number => typeof value === "number");
  const limitReached = usedPercents.length > 0 && usedPercents.some((value) => value >= 100);

  return {
    plan_type: PROXY_PLAN_TYPE,
    rate_limit: {
      allowed: !limitReached,
      limit_reached: limitReached,
      ...(primary ? { primary_window: primary } : {}),
      ...(secondary ? { secondary_window: secondary } : {}),
    },
    additional_rate_limits: [],
    credits: {
      has_credits: true,
      unlimited: true,
      balance: "0",
    },
  };
}

export function buildProxyWhamAccountsCheckPayload(
  summary: AccountQuotaSummary | null,
): ProxyWhamAccountsCheckPayload {
  const usage = buildProxyUsagePayload(summary);
  return {
    accounts: [
      {
        id: PROXY_ACCOUNT_ID,
        account_user_id: `${PROXY_USER_ID}__${PROXY_ACCOUNT_ID}`,
        structure: "personal",
        plan_type: PROXY_PLAN_TYPE,
        name: PROXY_ACCOUNT_NAME,
        profile_picture_url: null,
        rate_limit: usage.rate_limit,
        additional_rate_limits: usage.additional_rate_limits,
        credits: usage.credits,
      },
    ],
    default_account_id: PROXY_ACCOUNT_ID,
    account_ordering: [PROXY_ACCOUNT_ID],
  };
}

export function buildProxyAutoTopUpSettingsPayload(): ProxyAutoTopUpSettingsPayload {
  return {
    is_enabled: false,
    recharge_threshold: null,
    recharge_target: null,
  };
}

export function buildProxyAccountCheckV4Payload(): ProxyAccountCheckV4Payload {
  return {
    accounts: {
      [PROXY_ACCOUNT_ID]: {
        account: {
          account_user_role: "owner",
        },
        entitlement: {
          billing_currency: "USD",
        },
      },
    },
  };
}

export async function buildProxyQuotaSummary(options: {
  store: AccountStore;
  includeWhenDisabled?: boolean;
}): Promise<AccountQuotaSummary | null> {
  const state = await readProxyState(options.store.paths.codexTeamDir);
  if (!options.includeWhenDisabled && state?.enabled !== true) {
    return null;
  }

  if (typeof (options.store as AccountStore & {
    listQuotaSummaries?: AccountStore["listQuotaSummaries"];
  }).listQuotaSummaries !== "function") {
    return null;
  }

  const { accounts } = await options.store.listQuotaSummaries();
  return buildProxyQuotaSummaryFromAccounts(accounts);
}

export async function buildProxyQuotaAggregate(options: {
  store: AccountStore;
  includeWhenDisabled?: boolean;
}): Promise<ProxyQuotaAggregate | null> {
  const state = await readProxyState(options.store.paths.codexTeamDir);
  if (!options.includeWhenDisabled && state?.enabled !== true) {
    return null;
  }

  if (typeof (options.store as AccountStore & {
    listQuotaSummaries?: AccountStore["listQuotaSummaries"];
  }).listQuotaSummaries !== "function") {
    return null;
  }

  const { accounts } = await options.store.listQuotaSummaries();
  const aggregate = buildProxyQuotaAggregateFromAccounts(accounts);
  if (aggregate) {
    return aggregate;
  }

  const hasProxyPoolCandidates = accounts.some((account) =>
    account.auto_switch_eligible !== false
    && (account.user_id !== null || account.plan_type !== null || account.unlimited)
  );
  if (state?.enabled === true || hasProxyPoolCandidates) {
    return buildEmptyProxyQuotaAggregate(accounts);
  }

  return null;
}

export async function buildProxyUsagePayloadForStore(store: AccountStore): Promise<ProxyUsagePayload> {
  return buildProxyUsagePayload(
    buildProxyQuotaSummaryFromAccounts((await store.listQuotaSummaries()).accounts),
  );
}

export async function buildProxyWhamAccountsCheckPayloadForStore(
  store: AccountStore,
): Promise<ProxyWhamAccountsCheckPayload> {
  return buildProxyWhamAccountsCheckPayload(
    buildProxyQuotaSummaryFromAccounts((await store.listQuotaSummaries()).accounts),
  );
}
