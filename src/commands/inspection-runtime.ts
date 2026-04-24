import { readFile, stat } from "node:fs/promises";

import { getSnapshotIdentity, parseAuthSnapshot } from "../auth-snapshot.js";
import type { AccountStore } from "../account-store/index.js";
import type {
  CodexDesktopLauncher,
  RuntimeAccountSnapshot,
  RuntimeReadSource,
} from "../desktop/launcher.js";
import { toCliQuotaSummaryFromRuntimeQuota, type CliQuotaSummary } from "../cli/quota.js";
import { PROXY_ACCOUNT_ID, PROXY_ACCOUNT_NAME } from "../proxy/constants.js";

export interface CurrentStatusView extends Awaited<ReturnType<AccountStore["getCurrentStatus"]>> {
  source: "auth.json" | "desktop-runtime" | "direct-runtime";
  runtime_differs_from_local: boolean;
}

export interface CurrentRuntimeAccountView {
  snapshot: RuntimeAccountSnapshot;
  source: RuntimeReadSource;
}

export interface CurrentRuntimeQuotaView {
  quota: CliQuotaSummary;
  source: RuntimeReadSource;
}

export interface DoctorCurrentAuthView {
  status: "ok" | "missing" | "invalid";
  auth_mode: string | null;
  identity: string | null;
  matched_accounts: string[];
  managed: boolean;
  error: string | null;
}

export interface DoctorRuntimeView {
  status: "ok" | "unavailable" | "error";
  account: RuntimeAccountSnapshot | null;
  quota: CliQuotaSummary | null;
  error: string | null;
}

export interface DoctorDesktopRuntimeView {
  status: "ok" | "unavailable" | "error";
  account: RuntimeAccountSnapshot | null;
  quota: CliQuotaSummary | null;
  error: string | null;
  differs_from_local: boolean | null;
  differs_from_direct: boolean | null;
}

export interface CliDoctorReport {
  healthy: boolean;
  store: Awaited<ReturnType<AccountStore["doctor"]>>;
  current_auth: DoctorCurrentAuthView;
  direct_runtime: DoctorRuntimeView;
  desktop_runtime: DoctorDesktopRuntimeView;
  warnings: string[];
  issues: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function hasRuntimeAuthDifference(
  left: { auth_mode: string | null } | null,
  right: { auth_mode: string | null } | null,
): boolean | null {
  if (!left || !right || !left.auth_mode || !right.auth_mode) {
    return null;
  }

  return left.auth_mode !== right.auth_mode;
}

export async function tryReadDirectRuntimeQuota(
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: (message: string) => void,
): Promise<CurrentRuntimeQuotaView | null> {
  try {
    const quotaSnapshot = await desktopLauncher.readDirectRuntimeQuota();
    if (!quotaSnapshot) {
      debugLog?.("current: direct runtime quota unavailable");
      return null;
    }

    debugLog?.("current: using direct runtime quota");
    return {
      quota: toCliQuotaSummaryFromRuntimeQuota(quotaSnapshot),
      source: "direct",
    };
  } catch (error) {
    debugLog?.(`current: direct runtime quota read failed: ${(error as Error).message}`);
    return null;
  }
}

export async function tryReadCurrentRuntimeAccount(
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: (message: string) => void,
): Promise<CurrentRuntimeAccountView | null> {
  try {
    const accountResult = await desktopLauncher.readCurrentRuntimeAccountResult();
    if (!accountResult) {
      debugLog?.("current: runtime account unavailable");
      return null;
    }

    debugLog?.(`current: using ${accountResult.source} runtime account`);
    return accountResult;
  } catch (error) {
    debugLog?.(`current: runtime account read failed: ${(error as Error).message}`);
    return null;
  }
}

export function buildCurrentStatusView(
  localStatus: Awaited<ReturnType<AccountStore["getCurrentStatus"]>>,
  runtimeAccountView: CurrentRuntimeAccountView | null,
): CurrentStatusView {
  const warnings = [...localStatus.warnings];
  let runtimeDiffersFromLocal = false;
  const runtimeAccount = runtimeAccountView?.snapshot ?? null;
  const effectiveAccountId = localStatus.account_id;
  const isProxyCurrent = effectiveAccountId === PROXY_ACCOUNT_ID;

  if (runtimeAccount && runtimeAccount.auth_mode !== localStatus.auth_mode) {
    runtimeDiffersFromLocal = true;
    warnings.push(
      runtimeAccountView?.source === "desktop"
        ? "Managed Desktop auth differs from ~/.codex/auth.json."
        : "Direct Codex runtime auth differs from ~/.codex/auth.json.",
    );
  }

  return {
    ...localStatus,
    exists:
      localStatus.exists ||
      (runtimeAccount !== null && runtimeAccount.auth_mode !== null),
    auth_mode: runtimeAccount?.auth_mode ?? localStatus.auth_mode,
    account_id: effectiveAccountId,
    matched_accounts: isProxyCurrent ? [PROXY_ACCOUNT_NAME] : localStatus.matched_accounts,
    managed: isProxyCurrent ? true : localStatus.managed,
    duplicate_match: isProxyCurrent ? false : localStatus.duplicate_match,
    warnings,
    source:
      runtimeAccountView?.source === "desktop"
        ? "desktop-runtime"
        : runtimeAccountView?.source === "direct"
          ? "direct-runtime"
          : "auth.json",
    runtime_differs_from_local: runtimeDiffersFromLocal,
  };
}

async function inspectDoctorCurrentAuth(store: AccountStore): Promise<DoctorCurrentAuthView> {
  if (!(await pathExists(store.paths.currentAuthPath))) {
    return {
      status: "missing",
      auth_mode: null,
      identity: null,
      matched_accounts: [],
      managed: false,
      error: null,
    };
  }

  try {
    const localStatus = await store.getCurrentStatus();
    return {
      status: "ok",
      auth_mode: localStatus.auth_mode,
      identity: localStatus.identity,
      matched_accounts: localStatus.matched_accounts,
      managed: localStatus.managed,
      error: null,
    };
  } catch (error) {
    let parsedAuthMode: string | null = null;
    let parsedIdentity: string | null = null;

    try {
      const rawAuth = await readFile(store.paths.currentAuthPath, "utf8");
      const snapshot = parseAuthSnapshot(rawAuth);
      parsedAuthMode = snapshot.auth_mode;
      parsedIdentity = getSnapshotIdentity(snapshot);
    } catch {
      // Keep the doctor output best-effort when current auth parsing fails.
    }

    return {
      status: "invalid",
      auth_mode: parsedAuthMode,
      identity: parsedIdentity,
      matched_accounts: [],
      managed: false,
      error: (error as Error).message,
    };
  }
}

async function inspectDirectRuntime(
  desktopLauncher: CodexDesktopLauncher,
): Promise<DoctorRuntimeView> {
  try {
    const account = await desktopLauncher.readDirectRuntimeAccount();
    if (!account) {
      return {
        status: "unavailable",
        account: null,
        quota: null,
        error: "Direct runtime did not return account info.",
      };
    }

    try {
      const quotaSnapshot = await desktopLauncher.readDirectRuntimeQuota();
      return {
        status: "ok",
        account,
        quota: quotaSnapshot ? toCliQuotaSummaryFromRuntimeQuota(quotaSnapshot) : null,
        error: null,
      };
    } catch {
      return {
        status: "ok",
        account,
        quota: null,
        error: null,
      };
    }
  } catch (error) {
    return {
      status: "error",
      account: null,
      quota: null,
      error: (error as Error).message,
    };
  }
}

async function inspectDesktopRuntime(
  desktopLauncher: CodexDesktopLauncher,
  currentAuth: DoctorCurrentAuthView,
  directRuntime: DoctorRuntimeView,
): Promise<DoctorDesktopRuntimeView> {
  try {
    const account = await desktopLauncher.readManagedCurrentAccount();
    const quotaSnapshot = await desktopLauncher.readManagedCurrentQuota();

    if (!account && !quotaSnapshot) {
      return {
        status: "unavailable",
        account: null,
        quota: null,
        error: null,
        differs_from_local: null,
        differs_from_direct: null,
      };
    }

    return {
      status: "ok",
      account,
      quota: quotaSnapshot ? toCliQuotaSummaryFromRuntimeQuota(quotaSnapshot) : null,
      error: null,
      differs_from_local: hasRuntimeAuthDifference(
        account,
        currentAuth.status === "ok" ? { auth_mode: currentAuth.auth_mode } : null,
      ),
      differs_from_direct: hasRuntimeAuthDifference(account, directRuntime.account),
    };
  } catch (error) {
    return {
      status: "error",
      account: null,
      quota: null,
      error: (error as Error).message,
      differs_from_local: null,
      differs_from_direct: null,
    };
  }
}

export async function runDoctorChecks(
  store: AccountStore,
  desktopLauncher: CodexDesktopLauncher,
): Promise<CliDoctorReport> {
  const [storeReport, currentAuth, directRuntime] = await Promise.all([
    store.doctor(),
    inspectDoctorCurrentAuth(store),
    inspectDirectRuntime(desktopLauncher),
  ]);
  const desktopRuntime = await inspectDesktopRuntime(desktopLauncher, currentAuth, directRuntime);

  const warnings = [...storeReport.warnings];
  const issues = [...storeReport.issues];

  if (currentAuth.status === "missing") {
    issues.push("Current ~/.codex/auth.json is missing.");
  } else if (currentAuth.status === "invalid" && currentAuth.error) {
    issues.push(`Current auth.json is invalid: ${currentAuth.error}`);
  }

  if (directRuntime.status !== "ok") {
    issues.push(directRuntime.error ?? "Direct runtime health check failed.");
  } else if (!directRuntime.quota) {
    warnings.push("Direct runtime quota probe did not return usage info.");
  }

  if (desktopRuntime.status === "error") {
    warnings.push(`Managed Desktop runtime probe failed: ${desktopRuntime.error}`);
  }

  if (desktopRuntime.differs_from_local === true) {
    warnings.push("Managed Desktop runtime auth differs from ~/.codex/auth.json.");
  }

  if (desktopRuntime.differs_from_direct === true) {
    warnings.push("Managed Desktop runtime auth differs from the direct runtime probe.");
  }

  const uniqueWarnings = [...new Set(warnings)];
  const uniqueIssues = [...new Set(issues)];

  return {
    healthy: uniqueIssues.length === 0,
    store: storeReport,
    current_auth: currentAuth,
    direct_runtime: directRuntime,
    desktop_runtime: desktopRuntime,
    warnings: uniqueWarnings,
    issues: uniqueIssues,
  };
}
