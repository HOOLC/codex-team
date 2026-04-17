import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface AuthSnapshotTokens {
  account_id?: string;
  [key: string]: unknown;
}

export interface AuthSnapshot {
  auth_mode: string;
  OPENAI_API_KEY?: string | null;
  tokens?: AuthSnapshotTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

export type QuotaStatus = "ok" | "stale" | "error" | "unsupported";

export interface QuotaWindowSnapshot {
  used_percent: number;
  window_seconds: number;
  reset_after_seconds?: number;
  reset_at?: string;
}

export interface QuotaSnapshot {
  status: QuotaStatus;
  plan_type?: string;
  credits_balance?: number;
  fetched_at?: string;
  error_message?: string;
  unlimited?: boolean;
  five_hour?: QuotaWindowSnapshot;
  one_week?: QuotaWindowSnapshot;
}

export interface SnapshotMeta {
  name: string;
  auth_mode: string;
  account_id: string;
  user_id?: string;
  auto_switch_eligible: boolean;
  created_at: string;
  updated_at: string;
  last_switched_at: string | null;
  quota: QuotaSnapshot;
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

function asOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return asNonEmptyString(value, fieldName);
}

function asOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Field "${fieldName}" must be a boolean.`);
  }

  return value;
}

function asOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Field "${fieldName}" must be a number.`);
  }

  return value;
}

function normalizeAuthMode(authMode: string): string {
  return authMode.trim().toLowerCase();
}

function isSupportedAuthMode(authMode: string): boolean {
  return isApiKeyAuthMode(authMode) || isSupportedChatGPTAuthMode(authMode);
}

function assertSupportedAuthMode(authMode: string, fieldName: string): string {
  const normalized = normalizeAuthMode(authMode);
  if (!isSupportedAuthMode(normalized)) {
    throw new Error(`Unsupported ${fieldName}: ${authMode}`);
  }

  return normalized;
}

export function isApiKeyAuthMode(authMode: string): boolean {
  return normalizeAuthMode(authMode) === "apikey";
}

export function isSupportedChatGPTAuthMode(authMode: string): boolean {
  return normalizeAuthMode(authMode) === "chatgpt";
}

function extractAuthClaim(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = payload["https://api.openai.com/auth"];
  return isRecord(value) ? value : undefined;
}

function extractStringClaim(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function extractSnapshotJwtPayloads(snapshot: AuthSnapshot): Record<string, unknown>[] {
  const tokens = snapshot.tokens ?? {};
  const payloads: Record<string, unknown>[] = [];

  for (const tokenName of ["id_token", "access_token"]) {
    const token = tokens[tokenName];
    if (typeof token !== "string" || token.trim() === "") {
      continue;
    }

    try {
      payloads.push(decodeJwtPayload(token));
    } catch {
      // Ignore invalid JWT payloads and fall back to other sources.
    }
  }

  return payloads;
}

export function getSnapshotUserId(snapshot: AuthSnapshot): string | undefined {
  for (const payload of extractSnapshotJwtPayloads(snapshot)) {
    const authClaim = extractAuthClaim(payload);
    const chatGPTUserId = authClaim?.chatgpt_user_id;
    if (typeof chatGPTUserId === "string" && chatGPTUserId.trim() !== "") {
      return chatGPTUserId;
    }

    const userId = extractStringClaim(payload, "user_id");
    if (userId) {
      return userId;
    }
  }

  return undefined;
}

export function getSnapshotEmail(snapshot: AuthSnapshot): string | undefined {
  for (const payload of extractSnapshotJwtPayloads(snapshot)) {
    const email = extractStringClaim(payload, "email");
    if (email) {
      return email;
    }
  }

  return undefined;
}

function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export function composeIdentity(accountId: string, userId?: string): string {
  return typeof userId === "string" && userId.trim() !== ""
    ? `${accountId}:${userId}`
    : accountId;
}

export function getSnapshotAccountId(snapshot: AuthSnapshot): string {
  if (isApiKeyAuthMode(snapshot.auth_mode)) {
    const apiKey = snapshot.OPENAI_API_KEY;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new Error('Field "OPENAI_API_KEY" must be a non-empty string for apikey auth.');
    }

    return `key_${fingerprintApiKey(apiKey)}`;
  }

  const accountId = snapshot.tokens?.account_id;
  if (typeof accountId !== "string" || accountId.trim() === "") {
    throw new Error('Field "tokens.account_id" must be a non-empty string.');
  }

  return accountId;
}

export function getSnapshotIdentity(snapshot: AuthSnapshot): string {
  return composeIdentity(
    getSnapshotAccountId(snapshot),
    isSupportedChatGPTAuthMode(snapshot.auth_mode) ? getSnapshotUserId(snapshot) : undefined,
  );
}

export function getMetaIdentity(meta: Pick<SnapshotMeta, "account_id" | "user_id">): string {
  return composeIdentity(meta.account_id, meta.user_id);
}

export function defaultQuotaSnapshot(): QuotaSnapshot {
  return {
    status: "stale",
  };
}

function parseQuotaSnapshot(raw: unknown): QuotaSnapshot {
  if (raw === undefined || raw === null) {
    return defaultQuotaSnapshot();
  }

  if (!isRecord(raw)) {
    throw new Error('Field "quota" must be an object.');
  }

  const status = raw.status;
  if (
    status !== "ok" &&
    status !== "stale" &&
    status !== "error" &&
    status !== "unsupported"
  ) {
    throw new Error('Field "quota.status" must be one of ok/stale/error/unsupported.');
  }

  return {
    status,
    plan_type: asOptionalString(raw.plan_type, "quota.plan_type"),
    credits_balance: asOptionalNumber(raw.credits_balance, "quota.credits_balance"),
    fetched_at: asOptionalString(raw.fetched_at, "quota.fetched_at"),
    error_message: asOptionalString(raw.error_message, "quota.error_message"),
    unlimited: asOptionalBoolean(raw.unlimited, "quota.unlimited"),
    five_hour: parseQuotaWindowSnapshot(raw.five_hour, "quota.five_hour"),
    one_week: parseQuotaWindowSnapshot(raw.one_week, "quota.one_week"),
  };
}

function parseQuotaWindowSnapshot(
  raw: unknown,
  fieldName: string,
): QuotaWindowSnapshot | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (!isRecord(raw)) {
    throw new Error(`Field "${fieldName}" must be an object.`);
  }

  return {
    used_percent: asNonEmptyNumber(raw.used_percent, `${fieldName}.used_percent`),
    window_seconds: asNonEmptyNumber(raw.window_seconds, `${fieldName}.window_seconds`),
    reset_after_seconds: asOptionalNumber(raw.reset_after_seconds, `${fieldName}.reset_after_seconds`),
    reset_at: asOptionalString(raw.reset_at, `${fieldName}.reset_at`),
  };
}

function asNonEmptyNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Field "${fieldName}" must be a number.`);
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

  const authMode = assertSupportedAuthMode(
    asNonEmptyString(parsed.auth_mode, "auth_mode"),
    "auth_mode",
  );
  const tokens = parsed.tokens;

  if (tokens !== undefined && tokens !== null && !isRecord(tokens)) {
    throw new Error('Field "tokens" must be an object.');
  }
  const apiKeyMode = isApiKeyAuthMode(authMode);
  const normalizedApiKey =
    parsed.OPENAI_API_KEY === null || parsed.OPENAI_API_KEY === undefined
      ? parsed.OPENAI_API_KEY
      : asNonEmptyString(parsed.OPENAI_API_KEY, "OPENAI_API_KEY");

  if (apiKeyMode) {
    if (typeof normalizedApiKey !== "string" || normalizedApiKey.trim() === "") {
      throw new Error('Field "OPENAI_API_KEY" must be a non-empty string for apikey auth.');
    }
  } else {
    if (!isRecord(tokens)) {
      throw new Error('Field "tokens" must be an object.');
    }

    asNonEmptyString(tokens.account_id, "tokens.account_id");
  }

  return {
    ...parsed,
    auth_mode: authMode,
    OPENAI_API_KEY: normalizedApiKey,
    ...(isRecord(tokens)
      ? {
          tokens: {
            ...tokens,
            ...(typeof tokens.account_id === "string" && tokens.account_id.trim() !== ""
              ? { account_id: tokens.account_id }
              : {}),
          },
        }
      : {}),
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
    account_id: getSnapshotAccountId(snapshot),
    user_id: isSupportedChatGPTAuthMode(snapshot.auth_mode)
      ? getSnapshotUserId(snapshot)
      : undefined,
    auto_switch_eligible: true,
    created_at: existingCreatedAt ?? timestamp,
    updated_at: timestamp,
    last_switched_at: null,
    quota: defaultQuotaSnapshot(),
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
    auth_mode: assertSupportedAuthMode(
      asNonEmptyString(parsed.auth_mode, "auth_mode"),
      "auth_mode",
    ),
    account_id: asNonEmptyString(parsed.account_id, "account_id"),
    user_id: asOptionalString(parsed.user_id, "user_id"),
    auto_switch_eligible: asOptionalBoolean(parsed.auto_switch_eligible, "auto_switch_eligible") ?? true,
    created_at: asNonEmptyString(parsed.created_at, "created_at"),
    updated_at: asNonEmptyString(parsed.updated_at, "updated_at"),
    last_switched_at: lastSwitchedAt,
    quota: parseQuotaSnapshot(parsed.quota),
  };
}

export function maskAccountId(accountId: string): string {
  if (accountId.length <= 8) {
    return accountId;
  }

  return `${accountId.slice(0, 4)}...${accountId.slice(-3)}`;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Token payload is missing.");
  }

  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
  const decoded = Buffer.from(padded, "base64url").toString("utf8");
  const parsed: unknown = JSON.parse(decoded);

  if (!isRecord(parsed)) {
    throw new Error("Token payload must be a JSON object.");
  }

  return parsed;
}
