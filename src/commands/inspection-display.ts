import { maskAccountId } from "../auth-snapshot.js";
import type { AccountStore, ManagedAccount } from "../account-store/index.js";
import {
  computeAvailability,
  describeCurrentUsageSummary,
  type CliQuotaSummary,
} from "../cli/quota.js";
import { formatLocalUsageWindowLine, type LocalUsageWindowName } from "../local-usage/format.js";
import type { LocalUsageSummary } from "../local-usage/types.js";
import type { ProxyQuotaAggregate } from "../proxy/quota.js";
import { PROXY_ACCOUNT_ID, PROXY_ACCOUNT_NAME } from "../proxy/constants.js";
import type { WatchHistoryEtaContext } from "../watch/history.js";
import {
  formatDateTime,
  formatResetAt,
} from "../cli/time-format.js";
import type {
  CliDoctorReport,
  CurrentStatusView,
  DoctorCurrentAuthView,
  DoctorDesktopRuntimeView,
  DoctorRuntimeView,
} from "./inspection-runtime.js";

export function toWatchEtaTarget(account: Awaited<ReturnType<AccountStore["refreshAllQuotas"]>>["successes"][number]) {
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

export function toJsonEta(eta: WatchHistoryEtaContext) {
  const rate = eta.rate_1w_units_per_hour;
  const eta5hEq1wHours =
    eta.status === "ok" && rate && rate > 0 && typeof eta.remaining_5h_eq_1w === "number"
      ? Number((eta.remaining_5h_eq_1w / rate).toFixed(2))
      : null;
  const eta1wHours =
    eta.status === "ok" && rate && rate > 0 && typeof eta.remaining_1w === "number"
      ? Number((eta.remaining_1w / rate).toFixed(2))
      : null;

  return {
    status: eta.status,
    hours: eta.etaHours,
    bottleneck: eta.bottleneck,
    eta_5h_eq_1w_hours: eta5hEq1wHours,
    eta_1w_hours: eta1wHours,
    rate_1w_units_per_hour: eta.rate_1w_units_per_hour,
    remaining_5h_eq_1w: eta.remaining_5h_eq_1w,
    remaining_1w: eta.remaining_1w,
  };
}

export function describeCurrentSource(source: CurrentStatusView["source"]): string {
  switch (source) {
    case "desktop-runtime":
      return "managed Desktop runtime (mcp + auth.json)";
    case "direct-runtime":
      return "direct Codex runtime (app-server + auth.json)";
    default:
      return "local auth.json";
  }
}

export function describeCurrentStatus(
  status: CurrentStatusView,
  usage?: {
    quota: CliQuotaSummary | null;
    unavailableReason: string | null;
    sourceLabel?: string;
  },
): string {
  const lines: string[] = [];

  if (!status.exists) {
    lines.push("Current auth: missing");
  } else {
    lines.push("Current auth: present");
    lines.push(`Source: ${describeCurrentSource(status.source)}`);
    lines.push(`Auth mode: ${status.auth_mode}`);
    if (status.identity) {
      lines.push(`Identity: ${maskAccountId(status.identity)}`);
    }
    if (status.matched_accounts.length === 0) {
      lines.push("Managed account: no (unmanaged)");
    } else if (status.matched_accounts.length === 1) {
      lines.push(`Managed account: ${status.matched_accounts[0]}`);
    } else {
      lines.push(`Managed account: multiple (${status.matched_accounts.join(", ")})`);
    }
  }

  for (const warning of status.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  if (usage) {
    lines.push(
      describeCurrentUsageSummary(usage.quota, usage.unavailableReason, usage.sourceLabel),
    );
  }

  return lines.join("\n");
}

export function quotaSummaryLabel(quota: CliQuotaSummary | null): string {
  return describeCurrentUsageSummary(quota, null).replace(/^Usage:\s*/, "");
}

export function runtimeAccountLabel(account: { auth_mode: string | null; email?: string | null; plan_type?: string | null } | null): string {
  if (!account) {
    return "unavailable";
  }

  const fields = [account.auth_mode ?? "unknown"];
  if (account.email) {
    fields.push(account.email);
  }
  if (account.plan_type) {
    fields.push(account.plan_type);
  }
  return fields.join(" | ");
}

export function buildSingleAccountDetailText(options: {
  account: ManagedAccount;
  quota: CliQuotaSummary | null;
  quotaFailure: string | null;
  eta: WatchHistoryEtaContext | null;
  current: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>;
  daemonStatus: { running: boolean };
  usageWindow: LocalUsageWindowName;
  usageSummary: LocalUsageSummary;
  warnings: string[];
  proxyCurrentUpstreamName: string | null;
  proxyLastUpstreamLine: string | null;
}): string {
  const isCurrent = options.current.account_id === options.account.account_id
    || options.current.matched_accounts.includes(options.account.name);
  const quotaLine = options.quota
    ? quotaSummaryLabel(options.quota)
    : `refresh failed${options.quotaFailure ? ` | ${options.quotaFailure}` : ""}`;
  const etaLine = options.eta
    ? `${options.eta.etaHours}h | bottleneck ${options.eta.bottleneck ?? "-"}`
    : "-";
  const lines = [
    `Name: ${options.account.name}`,
    `Email: ${options.account.email ?? "-"}`,
    `Auth: ${options.account.auth_mode}`,
    `Protected: ${options.account.auto_switch_eligible === false ? "yes" : "no"}`,
    `Current: ${isCurrent ? "yes" : "no"}`,
    `Proxy current upstream: ${options.proxyCurrentUpstreamName === options.account.name ? "yes" : "no"}`,
    `Identity: ${options.account.identity}`,
    `Account: ${options.account.account_id}`,
    `User: ${options.account.user_id ?? "-"}`,
    `Joined: ${formatDateTime(options.account.created_at)}`,
    `Last switched: ${formatDateTime(options.account.last_switched_at)}`,
    "",
    `Quota: ${quotaLine}`,
    `ETA: ${etaLine}`,
    `5H used/reset: ${options.quota?.five_hour?.used_percent ?? "-"}% / ${formatResetAt(options.quota?.five_hour?.reset_at)}`,
    `1W used/reset: ${options.quota?.one_week?.used_percent ?? "-"}% / ${formatResetAt(options.quota?.one_week?.reset_at)}`,
    `Fetched: ${formatDateTime(options.quota?.fetched_at)}`,
    "",
    formatLocalUsageWindowLine(options.usageWindow, options.usageSummary.windows[options.usageWindow]),
    `Daemon: ${options.daemonStatus.running ? "running" : "stopped"}`,
  ];

  if (options.proxyLastUpstreamLine) {
    lines.push(options.proxyLastUpstreamLine);
  }

  for (const warning of options.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join("\n");
}

export function buildSingleAccountDetailJson(options: {
  account: ManagedAccount;
  quota: CliQuotaSummary | null;
  quotaFailure: string | null;
  eta: WatchHistoryEtaContext | null;
  current: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>;
  daemonStatus: { running: boolean; state: unknown };
  usageWindow: LocalUsageWindowName;
  usageSummary: LocalUsageSummary;
  warnings: string[];
  proxyCurrentUpstreamName: string | null;
  proxyLastUpstreamLabel: string | null;
}) {
  const isCurrent = options.current.account_id === options.account.account_id
    || options.current.matched_accounts.includes(options.account.name);

  return {
    account: {
      name: options.account.name,
      email: options.account.email,
      auth_mode: options.account.auth_mode,
      auto_switch_eligible: options.account.auto_switch_eligible,
      identity: options.account.identity,
      account_path: options.account.accountPath,
      account_id: options.account.account_id,
      user_id: options.account.user_id,
      created_at: options.account.created_at,
      last_switched_at: options.account.last_switched_at,
      is_current: isCurrent,
      is_proxy_current_upstream: options.proxyCurrentUpstreamName === options.account.name,
    },
    quota: options.quota,
    quota_error: options.quotaFailure,
    eta: options.eta ? toJsonEta(options.eta) : null,
    usage: {
      selected_window: options.usageWindow,
      window: options.usageSummary.windows[options.usageWindow],
    },
    daemon: {
      running: options.daemonStatus.running,
      state: options.daemonStatus.state,
    },
    proxy_last_upstream: options.proxyLastUpstreamLabel,
    warnings: options.warnings,
  };
}

function hasRuntimeAuthDifference(
  left: DoctorDesktopRuntimeView["account"] | null,
  right: { auth_mode: string | null } | null,
): boolean | null {
  if (!left || !right || !left.auth_mode || !right.auth_mode) {
    return null;
  }

  return left.auth_mode !== right.auth_mode;
}

export function describeDoctorReport(report: CliDoctorReport): string {
  const lines = [
    `Doctor: ${report.healthy ? "healthy" : "issues found"}`,
    `Store: ${report.store.healthy ? "healthy" : "issues found"} | accounts=${report.store.account_count} | invalid=${report.store.invalid_accounts.length}`,
    `Current auth: ${report.current_auth.status}${
      report.current_auth.status === "ok"
        ? ` | ${report.current_auth.auth_mode ?? "unknown"} | managed=${report.current_auth.managed ? "yes" : "no"}`
        : report.current_auth.error
          ? ` | ${report.current_auth.error}`
          : ""
    }`,
    `Direct runtime: ${report.direct_runtime.status}${
      report.direct_runtime.status === "ok"
        ? ` | ${runtimeAccountLabel(report.direct_runtime.account)}`
        : report.direct_runtime.error
          ? ` | ${report.direct_runtime.error}`
          : ""
    }`,
  ];

  if (report.direct_runtime.status === "ok") {
    lines.push(`Direct quota: ${quotaSummaryLabel(report.direct_runtime.quota)}`);
  }

  lines.push(
    `Desktop runtime: ${report.desktop_runtime.status}${
      report.desktop_runtime.status === "ok"
        ? ` | ${runtimeAccountLabel(report.desktop_runtime.account)}`
        : report.desktop_runtime.error
          ? ` | ${report.desktop_runtime.error}`
          : ""
    }`,
  );

  if (report.desktop_runtime.status === "ok" && report.desktop_runtime.quota) {
    lines.push(`Desktop quota: ${quotaSummaryLabel(report.desktop_runtime.quota)}`);
  }

  for (const warning of report.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  for (const issue of report.issues) {
    lines.push(`Issue: ${issue}`);
  }

  return lines.join("\n");
}
