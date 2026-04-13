import dayjs from "dayjs";

import type { AccountStore } from "../account-store/index.js";
import type { CliQuotaSummary } from "../cli/quota.js";
import type { ManagedWatchStatusEvent } from "../desktop/launcher.js";

function formatWatchField(key: string, value: string | number): string {
  if (typeof value === "number") {
    return `${key}=${value}`;
  }

  return `${key}=${JSON.stringify(value)}`;
}

function computeRemainingPercent(usedPercent: number | undefined): number | null {
  if (typeof usedPercent !== "number") {
    return null;
  }

  return Math.max(0, 100 - usedPercent);
}

export function formatWatchLogLine(message: string): string {
  return `[${dayjs().format("HH:mm:ss")}] ${message}`;
}

export function describeWatchQuotaUpdate(quota: CliQuotaSummary | null): string {
  if (!quota) {
    return "Quota update: Usage: unavailable";
  }

  if (quota.refresh_status !== "ok") {
    if (quota.refresh_status === "unsupported") {
      return "Quota update: Usage: unsupported";
    }

    return `Quota update: Usage: ${quota.refresh_status}${quota.error_message ? ` | ${quota.error_message}` : ""}`;
  }

  return `Quota update: Usage: ${quota.available ?? "unknown"} | 5H ${quota.five_hour?.used_percent ?? "-"}% used | 1W ${quota.one_week?.used_percent ?? "-"}% used`;
}

export function describeWatchQuotaEvent(
  accountLabel: string,
  quota: CliQuotaSummary | null,
): string {
  if (!quota || quota.refresh_status !== "ok") {
    return `quota ${formatWatchField("account", accountLabel)} status=${
      quota?.refresh_status ?? "unavailable"
    }`;
  }

  return [
    "quota",
    formatWatchField("account", accountLabel),
    `usage=${quota.available ?? "unknown"}`,
    `5H=${computeRemainingPercent(quota.five_hour?.used_percent) ?? "-"}% left`,
    `1W=${computeRemainingPercent(quota.one_week?.used_percent) ?? "-"}% left`,
  ].join(" ");
}

export function describeWatchStatusEvent(accountLabel: string, event: ManagedWatchStatusEvent): string {
  if (event.type === "reconnected") {
    return [
      "reconnect-ok",
      formatWatchField("account", accountLabel),
      formatWatchField("attempt", event.attempt),
    ].join(" ");
  }

  const fields = [
    "reconnect-lost",
    formatWatchField("account", accountLabel),
    formatWatchField("attempt", event.attempt),
  ];
  if (event.error) {
    fields.push(formatWatchField("error", event.error));
  }
  return fields.join(" ");
}

export function describeWatchAutoSwitchEvent(
  fromAccount: string,
  toAccount: string,
  warnings: string[],
): string {
  const fields = [
    "auto-switch",
    formatWatchField("from", fromAccount),
    formatWatchField("to", toAccount),
  ];
  if (warnings.length > 0) {
    fields.push(formatWatchField("warnings", warnings.length));
  }
  return fields.join(" ");
}

export function describeWatchAutoSwitchSkippedEvent(accountLabel: string, reason: string): string {
  return [
    "auto-switch-skipped",
    formatWatchField("account", accountLabel),
    `reason=${reason}`,
  ].join(" ");
}

export async function resolveWatchAccountLabel(store: AccountStore): Promise<string> {
  try {
    const current = await store.getCurrentStatus();
    if (current.matched_accounts.length === 1) {
      return current.matched_accounts[0];
    }
  } catch {
    // Keep watch logging best-effort when local current-state inspection fails.
  }

  return "current";
}
