import { join } from "node:path";

import {
  AuthSnapshot,
  SnapshotMeta,
  createSnapshotMeta,
  getMetaIdentity,
  getSnapshotAccountId,
  getSnapshotEmail,
  getSnapshotIdentity,
  getSnapshotUserId,
  isSupportedChatGPTAuthMode,
  parseSnapshotMeta,
  readAuthSnapshotFile,
} from "../auth-snapshot.js";
import type { ManagedAccount, StorePaths, StoreState } from "./types.js";
import {
  DIRECTORY_MODE,
  FILE_MODE,
  SCHEMA_VERSION,
  atomicWriteFile,
  ensureAccountName,
  ensureDirectory,
  pathExists,
  readJsonFile,
  stringifyJson,
} from "./storage.js";

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

export class AccountStoreRepository {
  readonly paths: StorePaths;

  constructor(paths: StorePaths) {
    this.paths = paths;
  }

  accountDirectory(name: string): string {
    ensureAccountName(name);
    return join(this.paths.accountsDir, name);
  }

  accountAuthPath(name: string): string {
    return join(this.accountDirectory(name), "auth.json");
  }

  accountMetaPath(name: string): string {
    return join(this.accountDirectory(name), "meta.json");
  }

  accountConfigPath(name: string): string {
    return join(this.accountDirectory(name), "config.toml");
  }

  async writeAccountAuthSnapshot(name: string, snapshot: AuthSnapshot): Promise<void> {
    await atomicWriteFile(
      this.accountAuthPath(name),
      stringifyJson(snapshot),
    );
  }

  async writeAccountMeta(name: string, meta: SnapshotMeta): Promise<void> {
    await atomicWriteFile(this.accountMetaPath(name), stringifyJson(meta));
  }

  async ensureEmptyAccountConfigSnapshot(name: string): Promise<string> {
    const configPath = this.accountConfigPath(name);
    await atomicWriteFile(configPath, "");
    return configPath;
  }

  async syncCurrentAuthIfMatching(snapshot: AuthSnapshot): Promise<void> {
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

  async ensureLayout(): Promise<void> {
    await ensureDirectory(this.paths.codexTeamDir, DIRECTORY_MODE);
    await ensureDirectory(this.paths.accountsDir, DIRECTORY_MODE);
    await ensureDirectory(this.paths.backupsDir, DIRECTORY_MODE);
  }

  async readState(): Promise<StoreState> {
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

  async writeState(state: StoreState): Promise<void> {
    await this.ensureLayout();
    await atomicWriteFile(this.paths.statePath, stringifyJson(state));
  }

  async readManagedAccount(name: string): Promise<ManagedAccount> {
    const accountPath = this.accountDirectory(name);
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
      email: getSnapshotEmail(snapshot) ?? null,
      accountPath,
      authPath,
      metaPath,
      configPath: (await pathExists(this.accountConfigPath(name))) ? this.accountConfigPath(name) : null,
      duplicateAccountId: false,
    };
  }

  async listAccounts(): Promise<{ accounts: ManagedAccount[]; warnings: string[] }> {
    await this.ensureLayout();

    const { readdir } = await import("node:fs/promises");
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

  async readCurrentStatusAccounts() {
    return await this.listAccounts();
  }

  createSnapshotMeta(
    name: string,
    snapshot: AuthSnapshot,
    now: Date,
    createdAt?: string | null,
  ) {
    return createSnapshotMeta(name, snapshot, now, createdAt ?? undefined);
  }
}
