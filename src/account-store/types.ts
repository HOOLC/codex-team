import type { QuotaSnapshot, QuotaStatus, QuotaWindowSnapshot, SnapshotMeta } from "../auth-snapshot.js";

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
  warning?: string;
}

export interface RefreshAllQuotasResult {
  successes: AccountQuotaSummary[];
  failures: Array<{ name: string; error: string }>;
  warnings: string[];
}
