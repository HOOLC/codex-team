import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import {
  AuthSnapshot,
  QuotaSnapshot,
  QuotaStatus,
  QuotaWindowSnapshot,
  SnapshotMeta,
  createSnapshotMeta,
  getMetaIdentity,
  getSnapshotAccountId,
  getSnapshotIdentity,
  getSnapshotUserId,
  isSupportedChatGPTAuthMode,
  parseAuthSnapshot,
  parseSnapshotMeta,
  readAuthSnapshotFile,
} from "./auth-snapshot.js";
import {
  extractChatGPTAuth,
  fetchQuotaSnapshot,
} from "./quota-client.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SCHEMA_VERSION = 1;
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const QUOTA_REFRESH_CONCURRENCY = 3;

export interface StorePaths {
  homeDir: string;
  codexDir: string;
  codexTeamDir: string;
  currentAuthPath: string;
  currentConfigPath: string;
  accountsDir: string;
  backupsDir: string;
  statePath: string;
}

export interface StoreState {
  schema_version: number;
  last_switched_account: string | null;
  last_backup_path: string | null;
}

export interface ManagedAccount extends SnapshotMeta {
  identity: string;
  authPath: string;
  metaPath: string;
  configPath: string | null;
  duplicateAccountId: boolean;
}

export interface AccountQuotaSummary {
  name: string;
  account_id: string;
  user_id: string | null;
  identity: string;
  plan_type: string | null;
  credits_balance: number | null;
  status: QuotaStatus;
  fetched_at: string | null;
  error_message: string | null;
  unlimited: boolean;
  five_hour: QuotaWindowSnapshot | null;
  one_week: QuotaWindowSnapshot | null;
}

export interface CurrentAccountStatus {
  exists: boolean;
  auth_mode: string | null;
  account_id: string | null;
  user_id: string | null;
  identity: string | null;
  matched_accounts: string[];
  managed: boolean;
  duplicate_match: boolean;
  warnings: string[];
}

export interface DoctorReport {
  healthy: boolean;
  warnings: string[];
  issues: string[];
  account_count: number;
  invalid_accounts: string[];
  current_auth_present: boolean;
}

export interface SwitchAccountResult {
  account: ManagedAccount;
  warnings: string[];
  backup_path: string | null;
}

export interface UpdateAccountResult {
  account: ManagedAccount;
}

export interface RefreshQuotaResult {
  account: ManagedAccount;
  quota: QuotaSnapshot;
}

export interface RefreshAllQuotasResult {
  successes: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
}

function defaultPaths(homeDir = homedir()): StorePaths {
  const codexDir = join(homeDir, ".codex");
  const codexTeamDir = join(homeDir, ".codex-team");

  return {
    homeDir,
    codexDir,
    codexTeamDir,
    currentAuthPath: join(codexDir, "auth.json"),
    currentConfigPath: join(codexDir, "config.toml"),
    accountsDir: join(codexTeamDir, "accounts"),
    backupsDir: join(codexTeamDir, "backups"),
    statePath: join(codexTeamDir, "state.json"),
  };
}

async function chmodIfPossible(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensureDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmodIfPossible(path, mode);
}

async function atomicWriteFile(
  path: string,
  content: string,
  mode = FILE_MODE,
): Promise<void> {
  const directory = dirname(path);
  const tempPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );

  await ensureDirectory(directory, DIRECTORY_MODE);
  await writeFile(tempPath, content, { encoding: "utf8", mode });
  await chmodIfPossible(tempPath, mode);
  await rename(tempPath, path);
  await chmodIfPossible(path, mode);
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureAccountName(name: string): void {
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new Error(
      'Account name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ and cannot contain path separators.',
    );
  }
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

async function readJsonFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function canAutoMigrateLegacyChatGPTMeta(
  meta: SnapshotMeta,
  snapshot: AuthSnapshot,
): boolean {
  if (!isSupportedChatGPTAuthMode(meta.auth_mode) || !isSupportedChatGPTAuthMode(snapshot.auth_mode)) {
    return false;
  }

  if (typeof meta.user_id === "string" && meta.user_id.trim() !== "") {
    return false;
  }

  const snapshotUserId = getSnapshotUserId(snapshot);
  if (!snapshotUserId) {
    return false;
  }

  return meta.account_id === getSnapshotAccountId(snapshot);
}

export class AccountStore {
  readonly paths: StorePaths;
  readonly fetchImpl?: typeof fetch;

  constructor(paths?: Partial<StorePaths> & { homeDir?: string; fetchImpl?: typeof fetch }) {
    const resolved = defaultPaths(paths?.homeDir);
    this.paths = {
      ...resolved,
      ...paths,
      homeDir: paths?.homeDir ?? resolved.homeDir,
    };
    this.fetchImpl = paths?.fetchImpl;
  }

  private accountDirectory(name: string): string {
    ensureAccountName(name);
    return join(this.paths.accountsDir, name);
  }

  private accountAuthPath(name: string): string {
    return join(this.accountDirectory(name), "auth.json");
  }

  private accountMetaPath(name: string): string {
    return join(this.accountDirectory(name), "meta.json");
  }

  private accountConfigPath(name: string): string {
    return join(this.accountDirectory(name), "config.toml");
  }

  private async writeAccountAuthSnapshot(
    name: string,
    snapshot: AuthSnapshot,
  ): Promise<void> {
    await atomicWriteFile(
      this.accountAuthPath(name),
      stringifyJson(snapshot),
    );
  }

  private async writeAccountMeta(name: string, meta: SnapshotMeta): Promise<void> {
    await atomicWriteFile(this.accountMetaPath(name), stringifyJson(meta));
  }

  private validateConfigSnapshot(name: string, snapshot: AuthSnapshot, rawConfig: string | null): void {
    if (snapshot.auth_mode !== "apikey") {
      return;
    }

    if (!rawConfig) {
      throw new Error(`Current ~/.codex/config.toml is required to save apikey account "${name}".`);
    }

    if (!/^\s*model_provider\s*=\s*["'][^"']+["']/mu.test(rawConfig)) {
      throw new Error(`Current ~/.codex/config.toml is missing model_provider for apikey account "${name}".`);
    }

    if (!/^\s*base_url\s*=\s*["'][^"']+["']/mu.test(rawConfig)) {
      throw new Error(`Current ~/.codex/config.toml is missing base_url for apikey account "${name}".`);
    }
  }

  private sanitizeConfigForAccountAuth(rawConfig: string): string {
    const lines = rawConfig.split(/\r?\n/u);
    const result: string[] = [];
    let skippingProviderSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        skippingProviderSection = /^\[model_providers\.[^\]]+\]$/u.test(trimmed);
        if (skippingProviderSection) {
          continue;
        }
      }

      if (skippingProviderSection) {
        continue;
      }

      if (/^\s*model_provider\s*=/u.test(line)) {
        continue;
      }

      if (/^\s*preferred_auth_method\s*=\s*["']apikey["']\s*$/u.test(line)) {
        continue;
      }

      result.push(line);
    }

    return `${result.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
  }

  private async ensureEmptyAccountConfigSnapshot(name: string): Promise<string> {
    const configPath = this.accountConfigPath(name);
    await atomicWriteFile(configPath, "");
    return configPath;
  }

  private async syncCurrentAuthIfMatching(snapshot: AuthSnapshot): Promise<void> {
    if (!(await pathExists(this.paths.currentAuthPath))) {
      return;
    }

    try {
      const currentSnapshot = await readAuthSnapshotFile(this.paths.currentAuthPath);
      if (getSnapshotIdentity(currentSnapshot) !== getSnapshotIdentity(snapshot)) {
        return;
      }

      await atomicWriteFile(this.paths.currentAuthPath, stringifyJson(snapshot));
    } catch {
      // Ignore sync failures here; the stored snapshot is already updated.
    }
  }

  private async quotaSummaryForAccount(
    account: ManagedAccount,
  ): Promise<AccountQuotaSummary> {
    let planType = account.quota.plan_type ?? null;

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
      plan_type: planType,
      credits_balance: account.quota.credits_balance ?? null,
      status: account.quota.status,
      fetched_at: account.quota.fetched_at ?? null,
      error_message: account.quota.error_message ?? null,
      unlimited: account.quota.unlimited === true,
      five_hour: account.quota.five_hour ?? null,
      one_week: account.quota.one_week ?? null,
    };
  }

  private async ensureLayout(): Promise<void> {
    await ensureDirectory(this.paths.codexTeamDir, DIRECTORY_MODE);
    await ensureDirectory(this.paths.accountsDir, DIRECTORY_MODE);
    await ensureDirectory(this.paths.backupsDir, DIRECTORY_MODE);
  }

  private async readState(): Promise<StoreState> {
    if (!(await pathExists(this.paths.statePath))) {
      return {
        schema_version: SCHEMA_VERSION,
        last_switched_account: null,
        last_backup_path: null,
      };
    }

    const raw = await readJsonFile(this.paths.statePath);
    const parsed = JSON.parse(raw) as Partial<StoreState>;

    return {
      schema_version: parsed.schema_version ?? SCHEMA_VERSION,
      last_switched_account: parsed.last_switched_account ?? null,
      last_backup_path: parsed.last_backup_path ?? null,
    };
  }

  private async writeState(state: StoreState): Promise<void> {
    await this.ensureLayout();
    await atomicWriteFile(this.paths.statePath, stringifyJson(state));
  }

  private async readManagedAccount(name: string): Promise<ManagedAccount> {
    const metaPath = this.accountMetaPath(name);
    const authPath = this.accountAuthPath(name);
    const [rawMeta, snapshot] = await Promise.all([
      readJsonFile(metaPath),
      readAuthSnapshotFile(authPath),
    ]);
    let meta = parseSnapshotMeta(rawMeta);

    if (meta.name !== name) {
      throw new Error(`Account metadata name mismatch for "${name}".`);
    }

    const snapshotIdentity = getSnapshotIdentity(snapshot);
    if (getMetaIdentity(meta) !== snapshotIdentity) {
      if (canAutoMigrateLegacyChatGPTMeta(meta, snapshot)) {
        meta = {
          ...meta,
          account_id: getSnapshotAccountId(snapshot),
          user_id: getSnapshotUserId(snapshot),
        };
        await this.writeAccountMeta(name, meta);
      } else {
        throw new Error(`Account metadata account_id mismatch for "${name}".`);
      }
    }

    if (getMetaIdentity(meta) !== snapshotIdentity) {
      throw new Error(`Account metadata account_id mismatch for "${name}".`);
    }

    return {
      ...meta,
      identity: getMetaIdentity(meta),
      authPath,
      metaPath,
      configPath: (await pathExists(this.accountConfigPath(name))) ? this.accountConfigPath(name) : null,
      duplicateAccountId: false,
    };
  }

  async listAccounts(): Promise<{ accounts: ManagedAccount[]; warnings: string[] }> {
    await this.ensureLayout();

    const entries = await readdir(this.paths.accountsDir, { withFileTypes: true });
    const accounts: ManagedAccount[] = [];
    const warnings: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        accounts.push(await this.readManagedAccount(entry.name));
      } catch (error) {
        warnings.push(
          `Account "${entry.name}" is invalid: ${(error as Error).message}`,
        );
      }
    }

    const counts = new Map<string, number>();
    for (const account of accounts) {
      counts.set(account.identity, (counts.get(account.identity) ?? 0) + 1);
    }

    accounts.sort((left, right) => left.name.localeCompare(right.name));

    return {
      accounts: accounts.map((account) => ({
        ...account,
        duplicateAccountId: (counts.get(account.identity) ?? 0) > 1,
      })),
      warnings,
    };
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
    await this.ensureLayout();

    if (!(await pathExists(this.paths.currentAuthPath))) {
      throw new Error("Current ~/.codex/auth.json does not exist.");
    }

    const rawSnapshot = await readJsonFile(this.paths.currentAuthPath);
    const snapshot = parseAuthSnapshot(rawSnapshot);
    const rawConfig =
      (await pathExists(this.paths.currentConfigPath))
        ? await readJsonFile(this.paths.currentConfigPath)
        : null;
    const accountDir = this.accountDirectory(name);
    const authPath = this.accountAuthPath(name);
    const metaPath = this.accountMetaPath(name);
    const configPath = this.accountConfigPath(name);
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

    this.validateConfigSnapshot(name, snapshot, rawConfig);
    await ensureDirectory(accountDir, DIRECTORY_MODE);
    await atomicWriteFile(authPath, `${rawSnapshot.trimEnd()}\n`);
    if (snapshot.auth_mode === "apikey" && rawConfig) {
      await atomicWriteFile(configPath, rawConfig.endsWith("\n") ? rawConfig : `${rawConfig}\n`);
    } else if (await pathExists(configPath)) {
      await rm(configPath, { force: true });
    }
    const meta = createSnapshotMeta(
      name,
      snapshot,
      new Date(),
      existingMeta?.created_at,
    );
    meta.last_switched_at = existingMeta?.last_switched_at ?? null;
    meta.quota = existingMeta?.quota ?? meta.quota;
    await atomicWriteFile(
      metaPath,
      stringifyJson(meta),
    );

    return this.readManagedAccount(name);
  }

  async updateCurrentManagedAccount(): Promise<UpdateAccountResult> {
    await this.ensureLayout();

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
    const metaPath = this.accountMetaPath(name);
    const existingMeta = parseSnapshotMeta(await readJsonFile(metaPath));

    this.validateConfigSnapshot(name, currentSnapshot, currentRawConfig);
    await atomicWriteFile(
      this.accountAuthPath(name),
      `${currentRawSnapshot.trimEnd()}\n`,
    );
    if (currentSnapshot.auth_mode === "apikey" && currentRawConfig) {
      await atomicWriteFile(
        this.accountConfigPath(name),
        currentRawConfig.endsWith("\n") ? currentRawConfig : `${currentRawConfig}\n`,
      );
    } else if (await pathExists(this.accountConfigPath(name))) {
      await rm(this.accountConfigPath(name), { force: true });
    }
    await atomicWriteFile(
      metaPath,
      stringifyJson(
        {
          ...createSnapshotMeta(
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
      account: await this.readManagedAccount(name),
    };
  }

  async switchAccount(name: string): Promise<SwitchAccountResult> {
    ensureAccountName(name);
    await this.ensureLayout();

    const account = await this.readManagedAccount(name);
    const warnings: string[] = [];
    let backupPath: string | null = null;

    await ensureDirectory(this.paths.codexDir, DIRECTORY_MODE);

    if (await pathExists(this.paths.currentAuthPath)) {
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
      await this.ensureEmptyAccountConfigSnapshot(name);
      warnings.push(
        `Saved apikey account "${name}" was missing config.toml snapshot. Created an empty snapshot; configure baseUrl manually if needed.`,
      );
    } else if (await pathExists(this.paths.currentConfigPath)) {
      const currentRawConfig = await readJsonFile(this.paths.currentConfigPath);
      await atomicWriteFile(
        this.paths.currentConfigPath,
        this.sanitizeConfigForAccountAuth(currentRawConfig),
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

    await this.writeState({
      schema_version: SCHEMA_VERSION,
      last_switched_account: name,
      last_backup_path: backupPath,
    });

    return {
      account: await this.readManagedAccount(name),
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

  async refreshQuotaForAccount(name: string): Promise<RefreshQuotaResult> {
    ensureAccountName(name);
    await this.ensureLayout();

    const account = await this.readManagedAccount(name);
    const meta = parseSnapshotMeta(await readJsonFile(account.metaPath));
    const snapshot = await readAuthSnapshotFile(account.authPath);
    const now = new Date();

    try {
      const result = await fetchQuotaSnapshot(snapshot, {
        homeDir: this.paths.homeDir,
        fetchImpl: this.fetchImpl,
        now,
      });

      if (JSON.stringify(result.authSnapshot) !== JSON.stringify(snapshot)) {
        await this.writeAccountAuthSnapshot(name, result.authSnapshot);
        await this.syncCurrentAuthIfMatching(result.authSnapshot);
      }

      meta.auth_mode = result.authSnapshot.auth_mode;
      meta.account_id = getSnapshotAccountId(result.authSnapshot);
      meta.user_id = getSnapshotUserId(result.authSnapshot);
      meta.updated_at = now.toISOString();
      meta.quota = result.quota;
      await this.writeAccountMeta(name, meta);

      return {
        account: await this.readManagedAccount(name),
        quota: meta.quota,
      };
    } catch (error) {
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
        error_message: (error as Error).message,
      };
      await this.writeAccountMeta(name, meta);
      throw new Error(`Failed to refresh quota for "${name}": ${(error as Error).message}`);
    }
  }

  async refreshAllQuotas(targetName?: string): Promise<RefreshAllQuotasResult> {
    const { accounts } = await this.listAccounts();
    const targets = targetName
      ? accounts.filter((account) => account.name === targetName)
      : accounts;

    if (targetName && targets.length === 0) {
      throw new Error(`Account "${targetName}" does not exist.`);
    }

    const results = new Array<
      | { success: AccountQuotaSummary }
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
            const refreshed = await this.refreshQuotaForAccount(account.name);
            results[index] = {
              success: await this.quotaSummaryForAccount(refreshed.account),
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
    for (const result of results) {
      if (!result) {
        continue;
      }

      if ("success" in result) {
        successes.push(result.success);
      } else {
        failures.push(result.failure);
      }
    }

    return {
      successes,
      failures,
    };
  }

  async removeAccount(name: string): Promise<void> {
    ensureAccountName(name);
    const accountDir = this.accountDirectory(name);

    if (!(await pathExists(accountDir))) {
      throw new Error(`Account "${name}" does not exist.`);
    }

    await rm(accountDir, { recursive: true, force: false });
  }

  async renameAccount(oldName: string, newName: string): Promise<ManagedAccount> {
    ensureAccountName(oldName);
    ensureAccountName(newName);

    const oldDir = this.accountDirectory(oldName);
    const newDir = this.accountDirectory(newName);

    if (!(await pathExists(oldDir))) {
      throw new Error(`Account "${oldName}" does not exist.`);
    }

    if (await pathExists(newDir)) {
      throw new Error(`Account "${newName}" already exists.`);
    }

    await rename(oldDir, newDir);
    const metaPath = this.accountMetaPath(newName);
    const meta = parseSnapshotMeta(await readJsonFile(metaPath));
    meta.name = newName;
    meta.updated_at = new Date().toISOString();
    await atomicWriteFile(metaPath, stringifyJson(meta));

    return this.readManagedAccount(newName);
  }

  async doctor(): Promise<DoctorReport> {
    await this.ensureLayout();

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
      await this.readState();
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
