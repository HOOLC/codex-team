import { PassThrough } from "node:stream";

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { maskAccountId } from "../auth-snapshot.js";
import { type AccountStore, type AccountQuotaSummary } from "../account-store/index.js";
import { buildListSummary } from "../cli/quota-summary.js";
import { computeAvailability } from "../cli/quota.js";
import { rankListCandidates, selectCurrentNextResetWindow, toAutoSwitchCandidate } from "../cli/quota-ranking.js";
import { normalizeDisplayedScore } from "../plan-quota-profile.js";
import { type CodexDesktopLauncher } from "../desktop/launcher.js";
import {
  computeWatchHistoryEta,
  createWatchHistoryStore,
  type WatchHistoryEtaContext,
} from "../watch/history.js";
import {
  runAccountDashboardTui,
  type AccountDashboardSnapshot,
} from "../tui/index.js";
import { performManualSwitch } from "./switch.js";
import { getUsage } from "../cli/spec.js";

dayjs.extend(utc);
dayjs.extend(timezone);

type DebugLogger = (message: string) => void;

interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

function describeCurrentListStatus(
  status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
): string {
  if (!status.exists) {
    return "Current auth: missing";
  }

  if (status.matched_accounts.length === 0) {
    return "Current auth: unmanaged";
  }

  if (status.matched_accounts.length === 1) {
    return `Current managed account: ${status.matched_accounts[0]}`;
  }

  return `Current managed account: multiple (${status.matched_accounts.join(", ")})`;
}

function toWatchEtaTarget(account: AccountQuotaSummary) {
  return {
    plan_type: account.plan_type,
    available: computeAvailability(account),
    five_hour: account.five_hour
      ? {
          used_percent: account.five_hour.used_percent,
          window_seconds: account.five_hour.window_seconds,
          reset_at: account.five_hour.reset_at ?? null,
        }
      : null,
    one_week: account.one_week
      ? {
          used_percent: account.one_week.used_percent,
          window_seconds: account.one_week.window_seconds,
          reset_at: account.one_week.reset_at ?? null,
        }
      : null,
  };
}

function formatResetAt(
  window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"],
): string {
  if (!window?.reset_at) {
    return "-";
  }

  return dayjs.utc(window.reset_at).tz(dayjs.tz.guess()).format("MM-DD HH:mm");
}

function formatEta(eta: WatchHistoryEtaContext | undefined): string {
  if (!eta) {
    return "-";
  }
  if (eta.status === "idle") {
    return "idle";
  }
  if (eta.status !== "ok" || eta.etaHours === null) {
    return "-";
  }
  if (eta.etaHours < 1) {
    return `${Math.round(eta.etaHours * 60)}m`;
  }
  if (eta.etaHours < 24) {
    return `${eta.etaHours.toFixed(1)}h`;
  }
  return `${(eta.etaHours / 24).toFixed(1)}d`;
}

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

function formatUsage(window: AccountQuotaSummary["five_hour"] | AccountQuotaSummary["one_week"]): string {
  return typeof window?.used_percent === "number" ? `${window.used_percent}%` : "-";
}

function normalizeScore(value: number | null): number | null {
  return normalizeDisplayedScore(value, "plus", { clamp: false });
}

function orderAccounts(accounts: AccountQuotaSummary[]): AccountQuotaSummary[] {
  const rankedCandidates = rankListCandidates(accounts);
  const originalOrder = new Map(accounts.map((account, index) => [account.name, index] as const));
  const rankedOrder = new Map(rankedCandidates.map((candidate, index) => [candidate.name, index] as const));

  return [...accounts].sort((left, right) => {
    const leftRank = rankedOrder.get(left.name);
    const rightRank = rankedOrder.get(right.name);

    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }
    if (leftRank !== undefined) {
      return -1;
    }
    if (rightRank !== undefined) {
      return 1;
    }

    return (originalOrder.get(left.name) ?? 0) - (originalOrder.get(right.name) ?? 0);
  });
}

export async function buildAccountDashboardSnapshot(options: {
  store: AccountStore;
  debugLog?: DebugLogger;
}): Promise<AccountDashboardSnapshot> {
  const result = await options.store.refreshAllQuotas(undefined, {
    quotaClientMode: "list-fast",
    allowCachedQuotaFallback: true,
  });
  const current = await options.store.getCurrentStatus();
  const now = new Date();
  const watchHistoryStore = createWatchHistoryStore(options.store.paths.codexTeamDir);
  const watchHistory = await watchHistoryStore.read(now);
  const etaByName = new Map(
    result.successes.map((account) => [
      account.name,
      computeWatchHistoryEta(watchHistory, toWatchEtaTarget(account), now),
    ] as const),
  );
  const orderedAccounts = orderAccounts(result.successes);
  const currentAccounts = new Set(current.matched_accounts);
  const { summaryLine, poolLine } = buildListSummary(result.successes);

  options.debugLog?.(
    `tui: successes=${result.successes.length} failures=${result.failures.length} warnings=${result.warnings.length} current_matches=${current.matched_accounts.length} watch_history_samples=${watchHistory.length}`,
  );

  return {
    currentStatusLine: describeCurrentListStatus(current),
    summaryLine,
    poolLine,
    warnings: result.warnings,
    failures: result.failures,
    accounts: orderedAccounts.map((account) => {
      const candidate = toAutoSwitchCandidate(account);
      const eta = etaByName.get(account.name);
      const score = candidate ? normalizeScore(candidate.current_score) : null;
      const nextResetLabel = candidate
        ? formatResetAt(selectCurrentNextResetWindow(account, candidate))
        : "-";
      const availabilityLabel = computeAvailability(account) ?? "unknown";

      return {
        name: account.name,
        planLabel: account.plan_type ?? "-",
        identityLabel: maskAccountId(account.identity),
        availabilityLabel,
        current: currentAccounts.has(account.name),
        score,
        scoreLabel: formatPercent(score),
        etaLabel: formatEta(eta),
        nextResetLabel,
        fiveHourLabel: formatUsage(account.five_hour),
        oneWeekLabel: formatUsage(account.one_week),
        detailLines: [
          `Identity: ${maskAccountId(account.identity)}`,
          `Plan: ${account.plan_type ?? "-"}`,
          `Availability: ${availabilityLabel}`,
          `Score: ${formatPercent(score)}`,
          `ETA: ${formatEta(eta)}`,
          `5H used: ${formatUsage(account.five_hour)}`,
          `1W used: ${formatUsage(account.one_week)}`,
          `Next reset: ${nextResetLabel}`,
        ],
      };
    }),
  };
}

export async function handleTuiCommand(options: {
  positionals: string[];
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  streams: CliStreams;
  debugLog?: DebugLogger;
  interruptSignal?: AbortSignal;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
}): Promise<number> {
  if (options.positionals.length > 1) {
    throw new Error(`Usage: ${getUsage("tui")}`);
  }

  const initialQuery = options.positionals[0] ?? "";
  if (!options.streams.stdin.isTTY || !options.streams.stdout.isTTY) {
    throw new Error(
      'codexm tui requires an interactive terminal. Use "codexm list" or "codexm list --json" instead.',
    );
  }

  const silentStatusStream = new PassThrough() as unknown as NodeJS.WriteStream;

  return await runAccountDashboardTui({
    stdin: options.streams.stdin,
    stdout: options.streams.stdout,
    initialQuery,
    loadSnapshot: async () => await buildAccountDashboardSnapshot({
      store: options.store,
      debugLog: options.debugLog,
    }),
    switchAccount: async (name) => {
      const { result, desktopForceWarning } = await performManualSwitch({
        name,
        force: false,
        store: options.store,
        desktopLauncher: options.desktopLauncher,
        stderr: silentStatusStream,
        debugLog: options.debugLog,
        interruptSignal: options.interruptSignal,
        managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
        managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
      });

      return {
        statusMessage: `Switched to "${result.account.name}".`,
        warningMessages: [
          ...result.warnings,
          ...(desktopForceWarning ? [desktopForceWarning] : []),
        ],
      };
    },
  });
}
