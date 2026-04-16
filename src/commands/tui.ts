import { PassThrough } from "node:stream";

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { maskAccountId } from "../auth-snapshot.js";
import { type AccountStore, type AccountQuotaSummary, type ManagedAccount } from "../account-store/index.js";
import { buildListSummary } from "../cli/quota-summary.js";
import { computeAvailability } from "../cli/quota.js";
import { rankListCandidates, selectCurrentNextResetWindow, toAutoSwitchCandidate } from "../cli/quota-ranking.js";
import { normalizeDisplayedScore } from "../plan-quota-profile.js";
import { type CodexDesktopLauncher } from "../desktop/launcher.js";
import { resolveManagedDesktopState } from "../desktop/managed-state.js";
import { getPlatform } from "../platform.js";
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
import { type RunnerOptions, type RunnerResult } from "../codex-cli-runner.js";

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
    available: deriveAvailability(account),
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

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return dayjs.utc(value).tz(dayjs.tz.guess()).format("YYYY-MM-DD HH:mm");
}

function formatClock(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return dayjs.utc(value).tz(dayjs.tz.guess()).format("HH:mm");
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

function deriveAvailability(account: AccountQuotaSummary): string {
  const computed = computeAvailability(account);
  if (computed) {
    return computed;
  }

  const usedPercents = [account.five_hour?.used_percent, account.one_week?.used_percent].filter(
    (value): value is number => typeof value === "number",
  );

  if (usedPercents.length === 0) {
    return account.status === "error" ? "error" : "unknown";
  }

  if (usedPercents.some((value) => value >= 100)) {
    return "unavailable";
  }

  return "available";
}

function formatBottleneck(eta: WatchHistoryEtaContext | undefined): string {
  if (!eta?.bottleneck) {
    return "-";
  }

  return eta.bottleneck === "five_hour" ? "5H" : "1W";
}

function buildReasonLabel(account: AccountQuotaSummary, eta: WatchHistoryEtaContext | undefined): string {
  if (account.status === "error") {
    return account.error_message ?? "quota refresh failed";
  }

  if (account.status === "stale") {
    return account.error_message
      ? `cached quota after ${account.error_message}`
      : "using cached quota";
  }

  const exhaustedWindows = [
    typeof account.five_hour?.used_percent === "number" && account.five_hour.used_percent >= 100 ? "5H" : null,
    typeof account.one_week?.used_percent === "number" && account.one_week.used_percent >= 100 ? "1W" : null,
  ].filter((value): value is string => value !== null);

  if (exhaustedWindows.length > 0) {
    return `exhausted ${exhaustedWindows.join(" + ")}`;
  }

  if (eta?.status === "idle") {
    return "idle watch history";
  }

  if (eta?.status === "ok" && eta.bottleneck) {
    return `${formatBottleneck(eta)} is the bottleneck`;
  }

  return "available";
}

function toQuotaSummary(account: ManagedAccount, refreshed: AccountQuotaSummary | null): AccountQuotaSummary {
  if (refreshed) {
    return refreshed;
  }

  return {
    name: account.name,
    account_id: account.account_id,
    user_id: account.user_id ?? null,
    identity: account.identity,
    plan_type: account.quota.plan_type ?? null,
    credits_balance: account.quota.credits_balance ?? null,
    status: account.quota.status,
    fetched_at: account.quota.fetched_at ?? null,
    error_message: account.quota.error_message ?? null,
    unlimited: account.quota.unlimited === true,
    five_hour: account.quota.five_hour ?? null,
    one_week: account.quota.one_week ?? null,
  };
}

function describeCurrentHeader(
  status: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
  usableCount: number,
  totalCount: number,
  latestFetchedAt: string | null,
): string {
  const currentLabel = !status.exists
    ? "missing"
    : status.matched_accounts.length === 1
      ? status.matched_accounts[0]
      : status.matched_accounts.length > 1
        ? "multiple"
        : "unmanaged";

  return `codexm | current ${currentLabel} | ${usableCount}/${totalCount} usable | updated ${formatClock(latestFetchedAt)}`;
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
  const { accounts, warnings: accountWarnings } = await options.store.listAccounts();
  const current = await options.store.getCurrentStatus();
  const now = new Date();
  const watchHistoryStore = createWatchHistoryStore(options.store.paths.codexTeamDir);
  const watchHistory = await watchHistoryStore.read(now);
  const refreshedByName = new Map(result.successes.map((account) => [account.name, account] as const));
  const allAccounts = accounts.map((account) => toQuotaSummary(account, refreshedByName.get(account.name) ?? null));
  const etaByName = new Map(
    allAccounts.map((account) => [
      account.name,
      computeWatchHistoryEta(watchHistory, toWatchEtaTarget(account), now),
    ] as const),
  );
  const orderedAccounts = orderAccounts(allAccounts);
  const currentAccounts = new Set(current.matched_accounts);
  const { summaryLine, poolLine } = buildListSummary(result.successes);
  const latestFetchedAt = allAccounts
    .map((account) => account.fetched_at)
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const usableCount = allAccounts.filter((account) => deriveAvailability(account) === "available").length;

  options.debugLog?.(
    `tui: accounts=${allAccounts.length} successes=${result.successes.length} failures=${result.failures.length} warnings=${result.warnings.length + accountWarnings.length} current_matches=${current.matched_accounts.length} watch_history_samples=${watchHistory.length}`,
  );

  return {
    headerLine: describeCurrentHeader(current, usableCount, allAccounts.length, latestFetchedAt),
    currentStatusLine: describeCurrentListStatus(current),
    summaryLine,
    poolLine,
    warnings: [...accountWarnings, ...result.warnings],
    failures: result.failures,
    accounts: orderedAccounts.map((account) => {
      const candidate = toAutoSwitchCandidate(account);
      const eta = etaByName.get(account.name);
      const score = candidate ? normalizeScore(candidate.current_score) : null;
      const nextResetLabel = candidate
        ? formatResetAt(selectCurrentNextResetWindow(account, candidate))
        : "-";
      const availabilityLabel = deriveAvailability(account);
      const reasonLabel = buildReasonLabel(account, eta);
      const maskedIdentity = maskAccountId(account.identity);
      const accountMeta = accounts.find((managedAccount) => managedAccount.name === account.name);

      return {
        name: account.name,
        planLabel: account.plan_type ?? "-",
        identityLabel: maskedIdentity,
        availabilityLabel,
        current: currentAccounts.has(account.name),
        score,
        scoreLabel: formatPercent(score),
        etaLabel: formatEta(eta),
        nextResetLabel,
        fiveHourLabel: formatUsage(account.five_hour),
        oneWeekLabel: formatUsage(account.one_week),
        authModeLabel: accountMeta?.auth_mode ?? "-",
        accountIdLabel: maskAccountId(account.account_id),
        userIdLabel: account.user_id ? maskAccountId(account.user_id) : "-",
        joinedAtLabel: formatDateTime(accountMeta?.created_at),
        lastSwitchedAtLabel: formatDateTime(accountMeta?.last_switched_at ?? null),
        fetchedAtLabel: formatDateTime(account.fetched_at),
        refreshStatusLabel: account.status,
        bottleneckLabel: formatBottleneck(eta),
        reasonLabel,
        detailLines: [
          `Identity: ${maskedIdentity}`,
          `Account: ${maskAccountId(account.account_id)}`,
          `User: ${account.user_id ? maskAccountId(account.user_id) : "-"}`,
          `Auth: ${accountMeta?.auth_mode ?? "-"}`,
          `Joined: ${formatDateTime(accountMeta?.created_at)}`,
          `Switched: ${formatDateTime(accountMeta?.last_switched_at ?? null)}`,
          `Fetched: ${formatDateTime(account.fetched_at)}`,
          `Plan: ${account.plan_type ?? "-"}`,
          `Availability: ${availabilityLabel}`,
          `Refresh: ${account.status}`,
          `Score: ${formatPercent(score)}`,
          `ETA: ${formatEta(eta)}`,
          `Bottleneck: ${formatBottleneck(eta)}`,
          `5H used: ${formatUsage(account.five_hour)}`,
          `1W used: ${formatUsage(account.one_week)}`,
          `Next reset: ${nextResetLabel}`,
          `Reason: ${reasonLabel}`,
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
  runCodexCli: (options: RunnerOptions) => Promise<RunnerResult>;
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

  const exit = await runAccountDashboardTui({
    stdin: options.streams.stdin,
    stdout: options.streams.stdout,
    initialQuery,
    loadSnapshot: async () => await buildAccountDashboardSnapshot({
      store: options.store,
      debugLog: options.debugLog,
    }),
    switchAccount: async (name, switchOptions) => {
      const { result, desktopForceWarning } = await performManualSwitch({
        name,
        force: switchOptions.force,
        store: options.store,
        desktopLauncher: options.desktopLauncher,
        stderr: silentStatusStream,
        debugLog: options.debugLog,
        interruptSignal: switchOptions.signal ?? options.interruptSignal,
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
    openDesktop: async (name) => {
      const appPath = await options.desktopLauncher.findInstalledApp();
      if (!appPath) {
        throw new Error("Codex Desktop not found at /Applications/Codex.app.");
      }

      const runningApps = await options.desktopLauncher.listRunningApps();
      if (runningApps.length > 0) {
        await options.desktopLauncher.activateApp(appPath);
        const warnings = (await options.desktopLauncher.isManagedDesktopRunning())
          ? []
          : [
              "Desktop is not codexm-managed; the focused app may still use its previous auth until relaunched.",
            ];

        return {
          statusMessage: `Focused Codex Desktop for "${name}".`,
          warningMessages: warnings,
        };
      }

      await options.desktopLauncher.launch(appPath);
      const platform = await getPlatform();
      const managedState = await resolveManagedDesktopState(
        options.desktopLauncher,
        appPath,
        runningApps,
        platform,
      );
      if (!managedState) {
        await options.desktopLauncher.clearManagedState().catch(() => undefined);
        throw new Error(
          "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
        );
      }

      await options.desktopLauncher.writeManagedState(managedState);
      return {
        statusMessage: `Opened Codex Desktop for "${name}".`,
        warningMessages: [],
      };
    },
  });

  if (exit.action === "open-codex") {
    const currentStatus = await options.store.getCurrentStatus();
    return (await options.runCodexCli({
      codexArgs: [],
      accountId: currentStatus.account_id,
      email: null,
      debugLog: options.debugLog,
      stderr: options.streams.stderr,
      signal: options.interruptSignal,
    })).exitCode;
  }

  return exit.code;
}
