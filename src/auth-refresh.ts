import type { AccountStore, ManagedAccount } from "./account-store/index.js";
import {
  decodeJwtPayload,
  getSnapshotTokenExpiresAt,
  readAuthSnapshotFile,
  type AuthSnapshot,
} from "./auth-snapshot.js";
import { extractChatGPTAuth } from "./quota-client.js";

export const AUTH_REFRESH_SWEEP_INTERVAL_MS = 30 * 60 * 1_000;
export const AUTH_REFRESH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const AUTH_REFRESH_EXPIRY_WINDOW_MS = 48 * 60 * 60 * 1_000;
export const AUTH_REPAIR_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;

const AUTH_REFRESH_RETRY_BACKOFF_MS = [
  30 * 60 * 1_000,
  2 * 60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
];
const AUTH_REFRESH_REPAIR_ERROR_PATTERNS = [
  /token_expired/i,
  /refresh token/i,
  /sign(?:ing)? in again/i,
  /token is expired/i,
  /already been used to generate a new access token/i,
];

export interface AuthRefreshDecision {
  due: boolean;
  reason: string;
  expires_at: string | null;
}

export interface AuthRefreshSweepResult {
  refreshed: Array<{ name: string; expires_at: string | null }>;
  failed: Array<{ name: string; error: string }>;
  skipped: Array<{ name: string; reason: string; expires_at: string | null }>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hasRefreshToken(snapshot: AuthSnapshot): boolean {
  try {
    return Boolean(extractChatGPTAuth(snapshot).refreshToken);
  } catch {
    return false;
  }
}

function resolveRetryBackoffMs(failCount: number): number {
  return AUTH_REFRESH_RETRY_BACKOFF_MS[
    Math.min(Math.max(0, failCount), AUTH_REFRESH_RETRY_BACKOFF_MS.length - 1)
  ] ?? AUTH_REFRESH_RETRY_BACKOFF_MS[AUTH_REFRESH_RETRY_BACKOFF_MS.length - 1]!;
}

async function needsAuthRepair(account: ManagedAccount, now: Date): Promise<boolean> {
  const refreshError = account.last_auth_refresh_status === "error"
    && AUTH_REFRESH_REPAIR_ERROR_PATTERNS.some((pattern) =>
      pattern.test(account.last_auth_refresh_error ?? "")
    );
  if (!refreshError) {
    return false;
  }

  if (account.quota.status === "stale") {
    return true;
  }

  try {
    const snapshot = await readAuthSnapshotFile(account.authPath);
    const expiresAt = getSnapshotAccessTokenExpiresAt(snapshot) ?? getSnapshotTokenExpiresAt(snapshot);
    if (!expiresAt) {
      return false;
    }

    const expiresAtMs = Date.parse(expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime() + AUTH_REPAIR_WARNING_WINDOW_MS;
  } catch {
    return false;
  }
}

function getSnapshotAccessTokenExpiresAt(snapshot: AuthSnapshot): string | null {
  const accessToken = snapshot.tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    return null;
  }

  try {
    const exp = decodeJwtPayload(accessToken).exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0
      ? new Date(exp * 1_000).toISOString()
      : null;
  } catch {
    return null;
  }
}

export async function summarizeAuthRepairAdvice(
  accounts: ManagedAccount[],
  now: Date = new Date(),
): Promise<string | null> {
  const affected: string[] = [];

  for (const account of accounts) {
    if (await needsAuthRepair(account, now)) {
      affected.push(account.name);
    }
  }

  if (affected.length === 0) {
    return null;
  }

  return affected.length === 1
    ? `Saved auth for ${affected[0]} needs replace: refresh failed and it is already stale or expires within 3d. Run "codexm replace ${affected[0]}" to refresh it.`
    : `Saved auth for ${affected.length} accounts (${affected.join(", ")}) needs replace: refresh failed and each account is already stale or expires within 3d. Run "codexm replace <name>" for each affected account.`;
}

export function inspectManagedAccountAuthRefreshNeed(
  account: ManagedAccount,
  snapshot: AuthSnapshot,
  now: Date,
): AuthRefreshDecision {
  if (snapshot.auth_mode !== "chatgpt") {
    return {
      due: false,
      reason: "auth mode is not chatgpt",
      expires_at: null,
    };
  }

  if (!hasRefreshToken(snapshot)) {
    return {
      due: false,
      reason: "auth.json is missing refresh_token",
      expires_at: getSnapshotTokenExpiresAt(snapshot),
    };
  }

  const expiresAt = getSnapshotTokenExpiresAt(snapshot);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs - now.getTime() <= AUTH_REFRESH_EXPIRY_WINDOW_MS) {
    return {
      due: true,
      reason: "token expires within 48h",
      expires_at: expiresAt,
    };
  }

  const lastRefreshAtMs = Date.parse(account.last_auth_refresh_at ?? "");
  if (!Number.isFinite(lastRefreshAtMs)) {
    return {
      due: true,
      reason: "auth has never been refreshed by codexm",
      expires_at: expiresAt,
    };
  }

  const elapsedMs = now.getTime() - lastRefreshAtMs;
  if (account.last_auth_refresh_status === "error") {
    const backoffMs = resolveRetryBackoffMs(account.auth_refresh_fail_count ?? 0);
    return {
      due: elapsedMs >= backoffMs,
      reason: elapsedMs >= backoffMs
        ? "retry backoff elapsed after a failed auth refresh"
        : `retry backoff active (${Math.ceil((backoffMs - elapsedMs) / 60_000)}m remaining)`,
      expires_at: expiresAt,
    };
  }

  return {
    due: elapsedMs >= AUTH_REFRESH_MIN_INTERVAL_MS,
    reason: elapsedMs >= AUTH_REFRESH_MIN_INTERVAL_MS
      ? "regular 24h auth refresh interval elapsed"
      : `last auth refresh is still recent (${Math.ceil((AUTH_REFRESH_MIN_INTERVAL_MS - elapsedMs) / 60_000)}m remaining)`,
    expires_at: expiresAt,
  };
}

export async function runAuthRefreshSweep(options: {
  store: AccountStore;
  now?: Date;
  signal?: AbortSignal;
  debugLog?: (message: string) => void;
  onEvent?: (event:
    | { type: "start"; account: string; reason: string; expires_at: string | null }
    | { type: "complete"; account: string; expires_at: string | null }
    | { type: "failed"; account: string; error: string }
    | { type: "skipped"; account: string; reason: string; expires_at: string | null }) => Promise<void> | void;
}): Promise<AuthRefreshSweepResult> {
  const now = options.now ?? new Date();
  const { accounts } = await options.store.listAccounts();
  const result: AuthRefreshSweepResult = {
    refreshed: [],
    failed: [],
    skipped: [],
  };

  for (const account of accounts) {
    if (options.signal?.aborted) {
      break;
    }

    let snapshot: AuthSnapshot;
    try {
      snapshot = await readAuthSnapshotFile(account.authPath);
    } catch (error) {
      const message = (error as Error).message;
      result.failed.push({ name: account.name, error: message });
      await options.onEvent?.({ type: "failed", account: account.name, error: message });
      continue;
    }

    const decision = inspectManagedAccountAuthRefreshNeed(account, snapshot, now);
    if (!decision.due) {
      result.skipped.push({
        name: account.name,
        reason: decision.reason,
        expires_at: decision.expires_at,
      });
      await options.onEvent?.({
        type: "skipped",
        account: account.name,
        reason: decision.reason,
        expires_at: decision.expires_at,
      });
      continue;
    }

    options.debugLog?.(
      `auth-refresh: refreshing ${account.name} reason=${decision.reason} expires_at=${decision.expires_at ?? "-"}`,
    );
    await options.onEvent?.({
      type: "start",
      account: account.name,
      reason: decision.reason,
      expires_at: decision.expires_at,
    });

    try {
      const refreshed = await options.store.refreshAuthForAccount(account.name, { now });
      result.refreshed.push({
        name: account.name,
        expires_at: refreshed.expires_at,
      });
      await options.onEvent?.({
        type: "complete",
        account: account.name,
        expires_at: refreshed.expires_at,
      });
    } catch (error) {
      const message = (error as Error).message;
      result.failed.push({ name: account.name, error: message });
      await options.onEvent?.({ type: "failed", account: account.name, error: message });
    }
  }

  return result;
}

export async function runAuthRefreshLoop(options: {
  store: AccountStore;
  signal?: AbortSignal;
  debugLog?: (message: string) => void;
  onEvent?: Parameters<typeof runAuthRefreshSweep>[0]["onEvent"];
  intervalMs?: number;
}): Promise<void> {
  const intervalMs = options.intervalMs ?? AUTH_REFRESH_SWEEP_INTERVAL_MS;

  while (!options.signal?.aborted) {
    await runAuthRefreshSweep({
      store: options.store,
      signal: options.signal,
      debugLog: options.debugLog,
      onEvent: options.onEvent,
    });
    if (options.signal?.aborted) {
      return;
    }
    await delay(intervalMs, options.signal);
  }
}
