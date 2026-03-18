import { readFile } from "node:fs/promises";

export interface AuthSnapshotTokens {
  account_id: string;
  [key: string]: unknown;
}

export interface AuthSnapshot {
  auth_mode: string;
  OPENAI_API_KEY?: string | null;
  tokens: AuthSnapshotTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

export interface SnapshotMeta {
  name: string;
  auth_mode: string;
  account_id: string;
  created_at: string;
  updated_at: string;
  last_switched_at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Field "${fieldName}" must be a non-empty string.`);
  }

  return value;
}

export function parseAuthSnapshot(raw: string): AuthSnapshot {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse auth snapshot JSON: ${(error as Error).message}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Auth snapshot must be a JSON object.");
  }

  const authMode = asNonEmptyString(parsed.auth_mode, "auth_mode");

  if (!isRecord(parsed.tokens)) {
    throw new Error('Field "tokens" must be an object.');
  }

  const accountId = asNonEmptyString(parsed.tokens.account_id, "tokens.account_id");

  return {
    ...parsed,
    auth_mode: authMode,
    tokens: {
      ...parsed.tokens,
      account_id: accountId,
    },
  };
}

export async function readAuthSnapshotFile(filePath: string): Promise<AuthSnapshot> {
  const raw = await readFile(filePath, "utf8");
  return parseAuthSnapshot(raw);
}

export function createSnapshotMeta(
  name: string,
  snapshot: AuthSnapshot,
  now: Date,
  existingCreatedAt?: string,
): SnapshotMeta {
  const timestamp = now.toISOString();

  return {
    name,
    auth_mode: snapshot.auth_mode,
    account_id: snapshot.tokens.account_id,
    created_at: existingCreatedAt ?? timestamp,
    updated_at: timestamp,
    last_switched_at: null,
  };
}

export function parseSnapshotMeta(raw: string): SnapshotMeta {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse account metadata JSON: ${(error as Error).message}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Account metadata must be a JSON object.");
  }

  const lastSwitchedAt = parsed.last_switched_at;
  if (lastSwitchedAt !== null && typeof lastSwitchedAt !== "string") {
    throw new Error('Field "last_switched_at" must be a string or null.');
  }

  return {
    name: asNonEmptyString(parsed.name, "name"),
    auth_mode: asNonEmptyString(parsed.auth_mode, "auth_mode"),
    account_id: asNonEmptyString(parsed.account_id, "account_id"),
    created_at: asNonEmptyString(parsed.created_at, "created_at"),
    updated_at: asNonEmptyString(parsed.updated_at, "updated_at"),
    last_switched_at: lastSwitchedAt,
  };
}

export function maskAccountId(accountId: string): string {
  if (accountId.length <= 10) {
    return accountId;
  }

  return `${accountId.slice(0, 6)}...${accountId.slice(-4)}`;
}
