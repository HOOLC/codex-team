import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
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
  SnapshotMeta,
  createSnapshotMeta,
  parseAuthSnapshot,
  parseSnapshotMeta,
  readAuthSnapshotFile,
} from "./auth-snapshot.js";

const execFile = promisify(execFileCallback);

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SCHEMA_VERSION = 1;
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface StorePaths {
  homeDir: string;
  codexDir: string;
  codexTeamDir: string;
  currentAuthPath: string;
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
  authPath: string;
  metaPath: string;
  duplicateAccountId: boolean;
}

export interface CurrentAccountStatus {
  exists: boolean;
  auth_mode: string | null;
  account_id: string | null;
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

function defaultPaths(homeDir = homedir()): StorePaths {
  const codexDir = join(homeDir, ".codex");
  const codexTeamDir = join(homeDir, ".codex-team");

  return {
    homeDir,
    codexDir,
    codexTeamDir,
    currentAuthPath: join(codexDir, "auth.json"),
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

async function detectRunningCodexProcesses(): Promise<number[]> {
  try {
    const { stdout } = await execFile("ps", ["-Ao", "pid=,command="]);
    const pids: number[] = [];

    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }

      const pid = Number(match[1]);
      const command = match[2];

      if (
        pid !== process.pid &&
        /(^|\s|\/)codex(\s|$)/.test(command) &&
        !command.includes("codex-team")
      ) {
        pids.push(pid);
      }
    }

    return pids;
  } catch {
    return [];
  }
}

export class AccountStore {
  readonly paths: StorePaths;

  constructor(paths?: Partial<StorePaths> & { homeDir?: string }) {
    const resolved = defaultPaths(paths?.homeDir);
    this.paths = {
      ...resolved,
      ...paths,
      homeDir: paths?.homeDir ?? resolved.homeDir,
    };
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
    const meta = parseSnapshotMeta(rawMeta);

    if (meta.name !== name) {
      throw new Error(`Account metadata name mismatch for "${name}".`);
    }

    if (meta.account_id !== snapshot.tokens.account_id) {
      throw new Error(`Account metadata account_id mismatch for "${name}".`);
    }

    return {
      ...meta,
      authPath,
      metaPath,
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
      counts.set(account.account_id, (counts.get(account.account_id) ?? 0) + 1);
    }

    accounts.sort((left, right) => left.name.localeCompare(right.name));

    return {
      accounts: accounts.map((account) => ({
        ...account,
        duplicateAccountId: (counts.get(account.account_id) ?? 0) > 1,
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
        matched_accounts: [],
        managed: false,
        duplicate_match: false,
        warnings,
      };
    }

    const snapshot = await readAuthSnapshotFile(this.paths.currentAuthPath);
    const matchedAccounts = accounts
      .filter((account) => account.account_id === snapshot.tokens.account_id)
      .map((account) => account.name);

    return {
      exists: true,
      auth_mode: snapshot.auth_mode,
      account_id: snapshot.tokens.account_id,
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
    const accountDir = this.accountDirectory(name);
    const authPath = this.accountAuthPath(name);
    const metaPath = this.accountMetaPath(name);
    const accountExists = await pathExists(accountDir);

    if (accountExists && !force) {
      throw new Error(`Account "${name}" already exists. Use --force to overwrite it.`);
    }

    const existingCreatedAt =
      accountExists && (await pathExists(metaPath))
        ? parseSnapshotMeta(await readJsonFile(metaPath)).created_at
        : undefined;

    await ensureDirectory(accountDir, DIRECTORY_MODE);
    await atomicWriteFile(authPath, `${rawSnapshot.trimEnd()}\n`);
    await atomicWriteFile(
      metaPath,
      stringifyJson(createSnapshotMeta(name, snapshot, new Date(), existingCreatedAt)),
    );

    return this.readManagedAccount(name);
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

    const rawAuth = await readJsonFile(account.authPath);
    await atomicWriteFile(this.paths.currentAuthPath, `${rawAuth.trimEnd()}\n`);
    const writtenSnapshot = await readAuthSnapshotFile(this.paths.currentAuthPath);

    if (writtenSnapshot.tokens.account_id !== account.account_id) {
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

    const runningCodexPids = await detectRunningCodexProcesses();
    if (runningCodexPids.length > 0) {
      warnings.push(
        `Detected running codex processes (${runningCodexPids.join(", ")}). Existing sessions may still hold the previous login state.`,
      );
    }

    return {
      account: await this.readManagedAccount(name),
      warnings,
      backup_path: backupPath,
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
      if (account.duplicateAccountId) {
        warnings.push(
          `Account "${account.name}" shares account_id ${account.account_id} with another saved account.`,
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

export function createAccountStore(homeDir?: string): AccountStore {
  return new AccountStore({ homeDir });
}
