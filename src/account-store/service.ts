import { join } from "node:path";
import {
  copyFile,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";

import {
  AuthSnapshot,
  QuotaSnapshot,
  getSnapshotAccountId,
  getSnapshotIdentity,
  getSnapshotTokenExpiresAt,
  getSnapshotUserId,
  parseAuthSnapshot,
  parseSnapshotMeta,
  readAuthSnapshotFile,
} from "../auth-snapshot.js";
import { AccountStoreRepository } from "./repository.js";
import { sanitizeConfigForAccountAuth, validateConfigSnapshot } from "./config.js";
import {
  DIRECTORY_MODE,
  FILE_MODE,
  QUOTA_REFRESH_CONCURRENCY,
  SCHEMA_VERSION,
  atomicWriteFile,
  chmodIfPossible,
  defaultPaths,
  ensureAccountName,
  ensureDirectory,
  pathExists,
  readJsonFile,
  stringifyJson,
} from "./storage.js";
import type {
  AccountQuotaSummary,
  CurrentAccountStatus,
  DoctorReport,
  ManagedAccount,
  RefreshAllQuotasResult,
  RefreshQuotaResult,
  StorePaths,
  UpdateAccountResult,
  SwitchAccountResult,
} from "./types.js";
import {
  extractChatGPTAuth,
  fetchQuotaSnapshot,
  refreshChatGPTAuthTokens,
  type QuotaClientMode,
} from "../quota-client.js";
import { appendEventLog, buildEventPayload, shortenErrorMessage } from "../logging.js";
import { stripProxyRuntimeConfig } from "../proxy/config.js";
import { resolveProxyDataDir } from "../proxy/state.js";
import { isSyntheticProxyAuthSnapshot } from "../proxy/synthetic-auth.js";
export type {
  AccountQuotaSummary,
  CurrentAccountStatus,
  DoctorReport,
  ManagedAccount,
  RefreshAllQuotasResult,
  RefreshQuotaResult,
  StorePaths,
  SwitchAccountResult,
  UpdateAccountResult,
} from "./types.js";

const LIST_CACHED_QUOTA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

interface RefreshQuotaOptions {
  quotaClientMode?: QuotaClientMode;
  allowCachedQuotaFallback?: boolean;
  cachedQuotaMaxAgeMs?: number;
}

function isFiniteTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasQuotaWindowSnapshot(
  window: QuotaSnapshot["five_hour"] | QuotaSnapshot["one_week"],
): boolean {
  return typeof window?.used_percent === "number" && typeof window.window_seconds === "number";
}

function quotaHasWindowSnapshot(quota: QuotaSnapshot | null | undefined): quota is QuotaSnapshot {
  return quota !== null
    && quota !== undefined
    && (hasQuotaWindowSnapshot(quota.five_hour) || hasQuotaWindowSnapshot(quota.one_week));
}

function toLastGoodQuotaSnapshot(quota: QuotaSnapshot): QuotaSnapshot | null {
  if (!quotaHasWindowSnapshot(quota)) {
    return null;
  }

  return {
    status: "ok",
    plan_type: quota.plan_type,
    credits_balance: quota.credits_balance,
    fetched_at: quota.fetched_at,
    unlimited: quota.unlimited,
    five_hour: quota.five_hour,
    one_week: quota.one_week,
  };
}

export class AccountStore {
  readonly paths: StorePaths;
  readonly fetchImpl?: typeof fetch;
  private readonly repository: AccountStoreRepository;

  constructor(paths?: Partial<StorePaths> & { homeDir?: string; fetchImpl?: typeof fetch }) {
    const resolved = defaultPaths(paths?.homeDir);
    this.paths = {
      ...resolved,
      ...paths,
      homeDir: paths?.homeDir ?? resolved.homeDir,
    };
    this.fetchImpl = paths?.fetchImpl;
    this.repository = new AccountStoreRepository(this.paths);
  }

  private async quotaSummaryForAccount(
    account: ManagedAccount,
    quotaOverride?: QuotaSnapshot,
  ): Promise<AccountQuotaSummary> {
    const quota = quotaOverride ?? account.quota;
    let planType = quota.plan_type ?? null;

    try {
      const snapshot = await readAuthSnapshotFile(account.authPath);
      const extracted = extractChatGPTAuth(snapshot);
      planType ??= extracted.planType ?? null;
    } catch {
      // Ignore derived plan type failures and fall back to metadata.
    }

    return {
      name: account.name,
      account_id: account.account_id,
      user_id: account.user_id ?? null,
      identity: account.identity,
      auto_switch_eligible: account.auto_switch_eligible,
      plan_type: planType,
      credits_balance: quota.credits_balance ?? null,
      status: quota.status,
      fetched_at: quota.fetched_at ?? null,
      error_message: quota.error_message ?? null,
      unlimited: quota.unlimited === true,
      five_hour: quota.five_hour ?? null,
      one_week: quota.one_week ?? null,
    };
  }

  private getCachedQuotaFallback(
    account: ManagedAccount,
    refreshError: Error,
    now: Date,
    maxAgeMs: number,
  ): { quota: QuotaSnapshot; warning: string } | null {
    const cachedQuota = account.last_good_quota ?? account.quota;
    const cachedFetchedAt = cachedQuota.fetched_at;
    if (
      !isFiniteTimestamp(cachedFetchedAt) ||
      !quotaHasWindowSnapshot(cachedQuota)
    ) {
      return null;
    }
    const cachedFetchedAtMs = Date.parse(cachedFetchedAt);
    if (Number.isFinite(maxAgeMs) && now.getTime() - cachedFetchedAtMs > maxAgeMs) {
      return null;
    }

    return {
      quota: {
        ...cachedQuota,
        status: "stale",
        error_message: refreshError.message,
      },
      warning: `${account.name} using cached quota from ${cachedFetchedAt} after refresh failed: ${refreshError.message}`,
    };
  }

  async listAccounts(): Promise<{ accounts: ManagedAccount[]; warnings: string[] }> {
    return await this.repository.listAccounts();
  }

  async getManagedAccount(name: string): Promise<ManagedAccount> {
    ensureAccountName(name);
    return await this.repository.readManagedAccount(name);
  }

  async getCurrentStatus(): Promise<CurrentAccountStatus> {
    const { accounts, warnings } = await this.listAccounts();

    if (!(await pathExists(this.paths.currentAuthPath))) {
      return {
        exists: false,
        auth_mode: null,
        account_id: null,
        user_id: null,
        identity: null,
        matched_accounts: [],
        managed: false,
        duplicate_match: false,
        warnings,
      };
    }

    const snapshot = await readAuthSnapshotFile(this.paths.currentAuthPath);
    const currentIdentity = getSnapshotIdentity(snapshot);
    const currentAccountId = getSnapshotAccountId(snapshot);
    const currentUserId = getSnapshotUserId(snapshot) ?? null;
    const matchedAccounts = accounts
      .filter((account) => account.identity === currentIdentity)
      .map((account) => account.name);

    return {
      exists: true,
      auth_mode: snapshot.auth_mode,
      account_id: currentAccountId,
      user_id: currentUserId,
      identity: currentIdentity,
      matched_accounts: matchedAccounts,
      managed: matchedAccounts.length > 0,
      duplicate_match: matchedAccounts.length > 1,
      warnings,
    };
  }

  async saveCurrentAccount(name: string, force = false): Promise<ManagedAccount> {
    ensureAccountName(name);
    await this.repository.ensureLayout();

    if (!(await pathExists(this.paths.currentAuthPath))) {
      throw new Error("Current ~/.codex/auth.json does not exist.");
    }

    const rawSnapshot = await readJsonFile(this.paths.currentAuthPath);
    const snapshot = parseAuthSnapshot(rawSnapshot);
    const rawConfig =
      (await pathExists(this.paths.currentConfigPath))
        ? await readJsonFile(this.paths.currentConfigPath)
        : null;
    const accountDir = this.repository.accountDirectory(name);
    const authPath = this.repository.accountAuthPath(name);
    const metaPath = this.repository.accountMetaPath(name);
    const configPath = this.repository.accountConfigPath(name);
    const identity = getSnapshotIdentity(snapshot);
    const accountExists = await pathExists(accountDir);
    const existingMeta =
      accountExists && (await pathExists(metaPath))
        ? parseSnapshotMeta(await readJsonFile(metaPath))
        : undefined;

    if (accountExists && !force) {
      throw new Error(`Account "${name}" already exists. Use --force to overwrite it.`);
    }

    const { accounts } = await this.listAccounts();
    const duplicateIdentityAccounts = accounts.filter(
      (account) => account.name !== name && account.identity === identity,
    );
    if (duplicateIdentityAccounts.length > 0) {
      const joinedNames = duplicateIdentityAccounts.map((account) => `"${account.name}"`).join(", ");
      throw new Error(
        `Identity ${identity} is already managed by ${joinedNames}.`,
      );
    }

    validateConfigSnapshot(name, snapshot, rawConfig);
    await ensureDirectory(accountDir, DIRECTORY_MODE);
    await atomicWriteFile(authPath, `${rawSnapshot.trimEnd()}\n`);
    if (snapshot.auth_mode === "apikey" && rawConfig) {
      await atomicWriteFile(configPath, rawConfig.endsWith("\n") ? rawConfig : `${rawConfig}\n`);
    } else if (await pathExists(configPath)) {
      await rm(configPath, { force: true });
    }
    const meta = this.repository.createSnapshotMeta(
      name,
      snapshot,
      new Date(),
      existingMeta?.created_at,
    );
    meta.last_switched_at = existingMeta?.last_switched_at ?? null;
    meta.quota = existingMeta?.quota ?? meta.quota;
    meta.last_good_quota = existingMeta?.last_good_quota ?? meta.last_good_quota;
    await atomicWriteFile(
      metaPath,
      stringifyJson(meta),
    );

    return await this.repository.readManagedAccount(name);
  }

  async addAccountSnapshot(
    name: string,
    snapshot: AuthSnapshot,
    options: {
      force?: boolean;
      rawConfig?: string | null;
    } = {},
  ): Promise<ManagedAccount> {
    ensureAccountName(name);
    await this.repository.ensureLayout();

    const normalizedSnapshot = parseAuthSnapshot(JSON.stringify(snapshot));
    const rawSnapshot = stringifyJson(normalizedSnapshot);
    const rawConfig = options.rawConfig ?? null;
    const accountDir = this.repository.accountDirectory(name);
    const authPath = this.repository.accountAuthPath(name);
    const metaPath = this.repository.accountMetaPath(name);
    const configPath = this.repository.accountConfigPath(name);
    const identity = getSnapshotIdentity(normalizedSnapshot);
    const accountExists = await pathExists(accountDir);
    const existingMeta =
      accountExists && (await pathExists(metaPath))
        ? parseSnapshotMeta(await readJsonFile(metaPath))
        : undefined;

    if (accountExists && !options.force) {
      throw new Error(`Account "${name}" already exists. Use --force to overwrite it.`);
    }

    const { accounts } = await this.listAccounts();
    const duplicateIdentityAccounts = accounts.filter(
      (account) => account.name !== name && account.identity === identity,
    );
    if (duplicateIdentityAccounts.length > 0) {
      const joinedNames = duplicateIdentityAccounts.map((account) => `"${account.name}"`).join(", ");
      throw new Error(
        `Identity ${identity} is already managed by ${joinedNames}.`,
      );
    }

    await ensureDirectory(accountDir, DIRECTORY_MODE);
    await atomicWriteFile(authPath, rawSnapshot);
    if (rawConfig !== null) {
      await atomicWriteFile(
        configPath,
        rawConfig === "" || rawConfig.endsWith("\n") ? rawConfig : `${rawConfig}\n`,
      );
    } else if (await pathExists(configPath)) {
      await rm(configPath, { force: true });
    }

    const meta = this.repository.createSnapshotMeta(
      name,
      normalizedSnapshot,
      new Date(),
      existingMeta?.created_at,
    );
    meta.last_switched_at = existingMeta?.last_switched_at ?? null;
    meta.quota = existingMeta?.quota ?? meta.quota;
    meta.last_good_quota = existingMeta?.last_good_quota ?? meta.last_good_quota;
    await atomicWriteFile(metaPath, stringifyJson(meta));

    return await this.repository.readManagedAccount(name);
  }

  async updateCurrentManagedAccount(): Promise<UpdateAccountResult> {
    await this.repository.ensureLayout();

    if (!(await pathExists(this.paths.currentAuthPath))) {
      throw new Error("Current ~/.codex/auth.json does not exist.");
    }

    const current = await this.getCurrentStatus();
    if (!current.managed) {
      throw new Error("Current account is not managed.");
    }

    if (current.duplicate_match || current.matched_accounts.length !== 1) {
      throw new Error(
        `Current account matches multiple managed accounts: ${current.matched_accounts.join(", ")}.`,
      );
    }

    const name = current.matched_accounts[0];
    const currentRawSnapshot = await readJsonFile(this.paths.currentAuthPath);
    const currentSnapshot = parseAuthSnapshot(currentRawSnapshot);
    const currentRawConfig =
      (await pathExists(this.paths.currentConfigPath))
        ? await readJsonFile(this.paths.currentConfigPath)
        : null;
    const metaPath = this.repository.accountMetaPath(name);
    const existingMeta = parseSnapshotMeta(await readJsonFile(metaPath));

    validateConfigSnapshot(name, currentSnapshot, currentRawConfig);
    await atomicWriteFile(
      this.repository.accountAuthPath(name),
      `${currentRawSnapshot.trimEnd()}\n`,
    );
    if (currentSnapshot.auth_mode === "apikey" && currentRawConfig) {
      await atomicWriteFile(
        this.repository.accountConfigPath(name),
        currentRawConfig.endsWith("\n") ? currentRawConfig : `${currentRawConfig}\n`,
      );
    } else if (await pathExists(this.repository.accountConfigPath(name))) {
      await rm(this.repository.accountConfigPath(name), { force: true });
    }
    await atomicWriteFile(
      metaPath,
      stringifyJson(
        {
          ...this.repository.createSnapshotMeta(
            name,
            currentSnapshot,
            new Date(),
            existingMeta.created_at,
          ),
          last_switched_at: existingMeta.last_switched_at,
          quota: existingMeta.quota,
        },
      ),
    );

    return {
      account: await this.repository.readManagedAccount(name),
    };
  }

  async switchAccount(name: string): Promise<SwitchAccountResult> {
    ensureAccountName(name);
    await this.repository.ensureLayout();

    const account = await this.repository.readManagedAccount(name);
    const warnings: string[] = [];
    let backupPath: string | null = null;
    let syntheticProxyWasActive = false;

    await ensureDirectory(this.paths.codexDir, DIRECTORY_MODE);

    if (await pathExists(this.paths.currentAuthPath)) {
      try {
        syntheticProxyWasActive = isSyntheticProxyAuthSnapshot(
          await readAuthSnapshotFile(this.paths.currentAuthPath),
        );
      } catch {
        syntheticProxyWasActive = false;
      }
      backupPath = join(this.paths.backupsDir, "last-active-auth.json");
      await copyFile(this.paths.currentAuthPath, backupPath);
      await chmodIfPossible(backupPath, FILE_MODE);
    }
    if (await pathExists(this.paths.currentConfigPath)) {
      const configBackupPath = join(this.paths.backupsDir, "last-active-config.toml");
      await copyFile(this.paths.currentConfigPath, configBackupPath);
      await chmodIfPossible(configBackupPath, FILE_MODE);
    }

    const rawAuth = await readJsonFile(account.authPath);
    await atomicWriteFile(this.paths.currentAuthPath, `${rawAuth.trimEnd()}\n`);
    if (account.auth_mode === "apikey" && account.configPath) {
      const rawConfig = await readJsonFile(account.configPath);
      await atomicWriteFile(
        this.paths.currentConfigPath,
        rawConfig.endsWith("\n") ? rawConfig : `${rawConfig}\n`,
      );
    } else if (account.auth_mode === "apikey") {
      await this.repository.ensureEmptyAccountConfigSnapshot(name);
      warnings.push(
        `Saved apikey account "${name}" was missing config.toml snapshot. Created an empty snapshot; configure baseUrl manually if needed.`,
      );
    } else if (await pathExists(this.paths.currentConfigPath)) {
      const currentRawConfig = await readJsonFile(this.paths.currentConfigPath);
      let configSource = currentRawConfig;
      if (syntheticProxyWasActive) {
        const directConfigBackupPath = join(
          resolveProxyDataDir(this.paths.codexTeamDir),
          "last-direct-config.toml",
        );
        if (await pathExists(directConfigBackupPath)) {
          configSource = await readFile(directConfigBackupPath, "utf8");
        }
      }
      const sanitizedConfig =
        syntheticProxyWasActive && configSource === currentRawConfig
          ? stripProxyRuntimeConfig(sanitizeConfigForAccountAuth(configSource)).join("\n")
          : sanitizeConfigForAccountAuth(configSource);
      await atomicWriteFile(
        this.paths.currentConfigPath,
        sanitizedConfig === "" ? "\n" : `${sanitizedConfig.replace(/\n+$/u, "")}\n`,
      );
    }
    const writtenSnapshot = await readAuthSnapshotFile(this.paths.currentAuthPath);

    if (getSnapshotIdentity(writtenSnapshot) !== account.identity) {
      throw new Error(`Switch verification failed for account "${name}".`);
    }

    const meta = parseSnapshotMeta(await readJsonFile(account.metaPath));
    meta.last_switched_at = new Date().toISOString();
    meta.updated_at = meta.last_switched_at;
    await atomicWriteFile(account.metaPath, stringifyJson(meta));

    await this.repository.writeState({
      schema_version: SCHEMA_VERSION,
      last_switched_account: name,
      last_backup_path: backupPath,
    });

    return {
      account: await this.repository.readManagedAccount(name),
      warnings,
      backup_path: backupPath,
    };
  }

  async listQuotaSummaries(): Promise<{
    accounts: AccountQuotaSummary[];
    warnings: string[];
  }> {
    const { accounts, warnings } = await this.listAccounts();
    const summaries = await Promise.all(
      accounts.map((account) => this.quotaSummaryForAccount(account)),
    );

    return {
      accounts: summaries,
      warnings,
    };
  }

  async refreshQuotaForAccount(
    name: string,
    options: RefreshQuotaOptions = {},
  ): Promise<RefreshQuotaResult> {
    ensureAccountName(name);
    await this.repository.ensureLayout();

    const account = await this.repository.readManagedAccount(name);
    const meta = parseSnapshotMeta(await readJsonFile(account.metaPath));
    const snapshot = await readAuthSnapshotFile(account.authPath);
    const now = new Date();

    try {
      const result = await fetchQuotaSnapshot(snapshot, {
        fetchImpl: this.fetchImpl,
        now,
        mode: options.quotaClientMode,
      });

      if (JSON.stringify(result.authSnapshot) !== JSON.stringify(snapshot)) {
        await this.repository.writeAccountAuthSnapshot(name, result.authSnapshot);
        await this.repository.syncCurrentAuthIfMatching(result.authSnapshot);
      }

      meta.auth_mode = result.authSnapshot.auth_mode;
      meta.account_id = getSnapshotAccountId(result.authSnapshot);
      meta.user_id = getSnapshotUserId(result.authSnapshot);
      meta.updated_at = now.toISOString();
      meta.quota = result.quota;
      const nextLastGoodQuota = toLastGoodQuotaSnapshot(result.quota);
      if (nextLastGoodQuota) {
        meta.last_good_quota = nextLastGoodQuota;
      }
      await this.repository.writeAccountMeta(name, meta);

      return {
        account: await this.repository.readManagedAccount(name),
        quota: meta.quota,
      };
    } catch (error) {
      const refreshError =
        error instanceof Error ? error : new Error(String(error));
      if (options.allowCachedQuotaFallback) {
        const fallback = this.getCachedQuotaFallback(
          account,
          refreshError,
          now,
          options.cachedQuotaMaxAgeMs ?? LIST_CACHED_QUOTA_MAX_AGE_MS,
        );
        if (fallback) {
          const fallbackSource = account.last_good_quota ?? toLastGoodQuotaSnapshot(account.quota);
          meta.updated_at = now.toISOString();
          meta.quota = fallback.quota;
          meta.last_good_quota = fallbackSource;
          await this.repository.writeAccountMeta(name, meta);
          await appendEventLog(this.paths.codexTeamDir, buildEventPayload({
            component: "quota",
            event: "quota.refresh.used_stale_snapshot",
            trigger: "cli",
            level: "warn",
            fields: {
              account_name: account.name,
              cached_fetched_at: fallbackSource?.fetched_at ?? fallback.quota.fetched_at ?? null,
              error: shortenErrorMessage(refreshError.message),
            },
          }));
          return {
            account: await this.repository.readManagedAccount(name),
            quota: fallback.quota,
            warning: fallback.warning,
          };
        }
      }

      let planType = meta.quota.plan_type;
      try {
        const extracted = extractChatGPTAuth(snapshot);
        planType ??= extracted.planType;
      } catch {
        // Ignore derived plan type failures on error.
      }

      meta.updated_at = now.toISOString();
      meta.quota = {
        ...meta.quota,
        status: "error",
        plan_type: planType,
        fetched_at: now.toISOString(),
        error_message: refreshError.message,
      };
      meta.last_good_quota = account.last_good_quota ?? toLastGoodQuotaSnapshot(account.quota);
      await this.repository.writeAccountMeta(name, meta);
      throw new Error(`Failed to refresh quota for "${name}": ${refreshError.message}`);
    }
  }

  async refreshAuthForAccount(
    name: string,
    options: {
      now?: Date;
    } = {},
  ): Promise<{
    account: ManagedAccount;
    authSnapshot: AuthSnapshot;
    expires_at: string | null;
  }> {
    ensureAccountName(name);
    await this.repository.ensureLayout();

    const account = await this.repository.readManagedAccount(name);
    const meta = parseSnapshotMeta(await readJsonFile(account.metaPath));
    const snapshot = await readAuthSnapshotFile(account.authPath);
    const now = options.now ?? new Date();

    if (snapshot.auth_mode !== "chatgpt") {
      meta.last_auth_refresh_at = now.toISOString();
      meta.last_auth_refresh_status = "skipped";
      meta.last_auth_refresh_error = "auth refresh is only supported for chatgpt auth.";
      meta.auth_refresh_fail_count = 0;
      meta.updated_at = now.toISOString();
      await this.repository.writeAccountMeta(name, meta);
      return {
        account: await this.repository.readManagedAccount(name),
        authSnapshot: snapshot,
        expires_at: getSnapshotTokenExpiresAt(snapshot),
      };
    }

    try {
      const refreshedSnapshot = await refreshChatGPTAuthTokens(snapshot, {
        fetchImpl: this.fetchImpl,
        now,
      });
      await this.repository.writeAccountAuthSnapshot(name, refreshedSnapshot);
      await this.repository.syncCurrentAuthIfMatching(refreshedSnapshot);

      meta.auth_mode = refreshedSnapshot.auth_mode;
      meta.account_id = getSnapshotAccountId(refreshedSnapshot);
      meta.user_id = getSnapshotUserId(refreshedSnapshot);
      meta.updated_at = now.toISOString();
      meta.last_auth_refresh_at = now.toISOString();
      meta.last_auth_refresh_status = "ok";
      meta.last_auth_refresh_error = null;
      meta.auth_refresh_fail_count = 0;
      await this.repository.writeAccountMeta(name, meta);

      return {
        account: await this.repository.readManagedAccount(name),
        authSnapshot: refreshedSnapshot,
        expires_at: getSnapshotTokenExpiresAt(refreshedSnapshot),
      };
    } catch (error) {
      meta.updated_at = now.toISOString();
      meta.last_auth_refresh_at = now.toISOString();
      meta.last_auth_refresh_status = "error";
      meta.last_auth_refresh_error = (error as Error).message;
      meta.auth_refresh_fail_count = (meta.auth_refresh_fail_count ?? 0) + 1;
      await this.repository.writeAccountMeta(name, meta);
      throw error;
    }
  }

  async refreshAllQuotas(
    targetName?: string,
    options: RefreshQuotaOptions = {},
  ): Promise<RefreshAllQuotasResult> {
    const { accounts } = await this.listAccounts();
    const targets = targetName
      ? accounts.filter((account) => account.name === targetName)
      : accounts;

    if (targetName && targets.length === 0) {
      throw new Error(`Account "${targetName}" does not exist.`);
    }

    const results = new Array<
      | { success: AccountQuotaSummary; warning?: string }
      | { failure: { name: string; error: string } }
    >(targets.length);
    let nextIndex = 0;
    const workerCount = Math.min(QUOTA_REFRESH_CONCURRENCY, targets.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;

          if (index >= targets.length) {
            return;
          }

          const account = targets[index];
          try {
            const refreshed = await this.refreshQuotaForAccount(account.name, options);
            results[index] = {
              success: await this.quotaSummaryForAccount(refreshed.account, refreshed.quota),
              ...(refreshed.warning ? { warning: refreshed.warning } : {}),
            };
          } catch (error) {
            results[index] = {
              failure: {
                name: account.name,
                error: (error as Error).message,
              },
            };
          }
        }
      }),
    );

    const successes: AccountQuotaSummary[] = [];
    const failures: Array<{ name: string; error: string }> = [];
    const warnings: string[] = [];
    for (const result of results) {
      if (!result) {
        continue;
      }

      if ("success" in result) {
        successes.push(result.success);
        if (typeof result.warning === "string") {
          warnings.push(result.warning);
        }
      } else {
        failures.push(result.failure);
      }
    }

    return {
      successes,
      failures,
      warnings,
    };
  }

  async removeAccount(name: string): Promise<void> {
    ensureAccountName(name);
    const accountDir = this.repository.accountDirectory(name);

    if (!(await pathExists(accountDir))) {
      throw new Error(`Account "${name}" does not exist.`);
    }

    await rm(accountDir, { recursive: true, force: false });
  }

  async renameAccount(oldName: string, newName: string): Promise<ManagedAccount> {
    ensureAccountName(oldName);
    ensureAccountName(newName);

    const oldDir = this.repository.accountDirectory(oldName);
    const newDir = this.repository.accountDirectory(newName);

    if (!(await pathExists(oldDir))) {
      throw new Error(`Account "${oldName}" does not exist.`);
    }

    if (await pathExists(newDir)) {
      throw new Error(`Account "${newName}" already exists.`);
    }

    await rename(oldDir, newDir);
    const metaPath = this.repository.accountMetaPath(newName);
    const meta = parseSnapshotMeta(await readJsonFile(metaPath));
    meta.name = newName;
    meta.updated_at = new Date().toISOString();
    await atomicWriteFile(metaPath, stringifyJson(meta));

    return await this.repository.readManagedAccount(newName);
  }

  async setAutoSwitchEligibility(name: string, eligible: boolean): Promise<ManagedAccount> {
    ensureAccountName(name);
    const account = await this.repository.readManagedAccount(name);
    const meta = parseSnapshotMeta(await readJsonFile(account.metaPath));
    meta.auto_switch_eligible = eligible;
    meta.updated_at = new Date().toISOString();
    await this.repository.writeAccountMeta(name, meta);
    return await this.repository.readManagedAccount(name);
  }

  async doctor(): Promise<DoctorReport> {
    await this.repository.ensureLayout();

    const issues: string[] = [];
    const warnings: string[] = [];
    const invalidAccounts: string[] = [];

    const rootStat = await stat(this.paths.codexTeamDir);
    if ((rootStat.mode & 0o777) !== DIRECTORY_MODE) {
      issues.push(
        `Store directory permissions are ${(rootStat.mode & 0o777).toString(8)}, expected 700.`,
      );
    }

    if (await pathExists(this.paths.statePath)) {
      const stateStat = await stat(this.paths.statePath);
      if ((stateStat.mode & 0o777) !== FILE_MODE) {
        issues.push(
          `State file permissions are ${(stateStat.mode & 0o777).toString(8)}, expected 600.`,
        );
      }
      await this.repository.readState();
    }

    const { accounts, warnings: accountWarnings } = await this.listAccounts();
    for (const warning of accountWarnings) {
      warnings.push(warning);
      const match = warning.match(/^Account "(.+)" is invalid:/);
      if (match) {
        invalidAccounts.push(match[1]);
      }
    }

    for (const account of accounts) {
      const authStat = await stat(account.authPath);
      const metaStat = await stat(account.metaPath);
      if ((authStat.mode & 0o777) !== FILE_MODE) {
        issues.push(`Account "${account.name}" auth permissions must be 600.`);
      }
      if ((metaStat.mode & 0o777) !== FILE_MODE) {
        issues.push(`Account "${account.name}" metadata permissions must be 600.`);
      }
      if (account.auth_mode === "apikey" && !account.configPath) {
        issues.push(`Account "${account.name}" is missing config.toml snapshot required for apikey auth.`);
      }
      if (account.duplicateAccountId) {
        warnings.push(
          `Account "${account.name}" shares identity ${account.identity} with another saved account.`,
        );
      }
    }

    let currentAuthPresent = false;
    if (await pathExists(this.paths.currentAuthPath)) {
      currentAuthPresent = true;
      try {
        await readAuthSnapshotFile(this.paths.currentAuthPath);
      } catch (error) {
        issues.push(`Current auth.json is invalid: ${(error as Error).message}`);
      }
    } else {
      warnings.push("Current ~/.codex/auth.json is missing.");
    }

    return {
      healthy: issues.length === 0,
      warnings,
      issues,
      account_count: accounts.length,
      invalid_accounts: invalidAccounts,
      current_auth_present: currentAuthPresent,
    };
  }
}

export function createAccountStore(
  homeDir?: string,
  options?: { fetchImpl?: typeof fetch },
): AccountStore {
  return new AccountStore({ homeDir, fetchImpl: options?.fetchImpl });
}
