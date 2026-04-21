import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type AuthSnapshot,
  type QuotaSnapshot,
  type QuotaWindowSnapshot,
  decodeJwtPayload,
  isSupportedChatGPTAuthMode,
} from "./auth-snapshot.js";

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com";
const USER_AGENT = "codexm/0.1";
const USAGE_FETCH_ATTEMPTS = 3;
const USAGE_FETCH_RETRY_DELAY_MS = 250;
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const LIST_FAST_FETCH_ATTEMPTS = 1;
const LIST_FAST_FETCH_TIMEOUT_MS = 3_000;

export type QuotaClientMode = "default" | "list-fast";

interface ExtractedChatGPTAuth {
  accessToken: string;
  accountId: string;
  refreshToken?: string;
  planType?: string;
  issuer?: string;
  clientId?: string;
  supported: boolean;
}

interface UsageApiResponse {
  plan_type?: string;
  rate_limit?: RateLimitDetails;
  additional_rate_limits?: AdditionalRateLimitDetails[] | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string;
  };
}

interface RateLimitDetails {
  primary_window?: UsageWindowRaw;
  secondary_window?: UsageWindowRaw;
}

interface AdditionalRateLimitDetails {
  rate_limit?: RateLimitDetails;
}

interface UsageWindowRaw {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface RefreshedTokenPayload {
  access_token: string;
  id_token: string;
  refresh_token?: string;
}

export interface QuotaFetchResult {
  quota: QuotaSnapshot;
  authSnapshot: AuthSnapshot;
}

export interface QuotaClientOptions {
  homeDir?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  mode?: QuotaClientMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parsePlanType(snapshot: AuthSnapshot): string | undefined {
  const tokens = snapshot.tokens ?? {};

  for (const tokenName of ["id_token", "access_token"]) {
    const token = tokens[tokenName];
    if (typeof token !== "string" || token.trim() === "") {
      continue;
    }

    try {
      const payload = decodeJwtPayload(token);
      const authClaim = extractAuthClaim(payload);
      const planType = authClaim?.chatgpt_plan_type;
      if (typeof planType === "string" && planType.trim() !== "") {
        return planType;
      }
    } catch {
      // Ignore invalid JWTs and fall back to other sources.
    }
  }

  return undefined;
}

export function extractChatGPTAuth(snapshot: AuthSnapshot): ExtractedChatGPTAuth {
  const authMode = snapshot.auth_mode ?? "";
  const supported = isSupportedChatGPTAuthMode(authMode);
  const tokens = snapshot.tokens ?? {};
  const accessTokenValue = tokens.access_token;
  const refreshTokenValue = tokens.refresh_token;
  const directAccountId = tokens.account_id;

  let accountId =
    typeof directAccountId === "string" && directAccountId.trim() !== ""
      ? directAccountId
      : undefined;
  let planType: string | undefined;
  let issuer: string | undefined;
  let clientId: string | undefined;

  for (const tokenName of ["id_token", "access_token"]) {
    const token = tokens[tokenName];
    if (typeof token !== "string" || token.trim() === "") {
      continue;
    }

    try {
      const payload = decodeJwtPayload(token);
      const authClaim = extractAuthClaim(payload);

      if (!accountId) {
        const maybeAccountId = authClaim?.chatgpt_account_id;
        if (typeof maybeAccountId === "string" && maybeAccountId.trim() !== "") {
          accountId = maybeAccountId;
        }
      }

      if (!planType) {
        const maybePlanType = authClaim?.chatgpt_plan_type;
        if (typeof maybePlanType === "string" && maybePlanType.trim() !== "") {
          planType = maybePlanType;
        }
      }

      issuer ??= extractStringClaim(payload, "iss");
      clientId ??=
        extractStringClaim(payload, "client_id") ??
        extractStringClaim(payload, "azp") ??
        (typeof payload.aud === "string" ? payload.aud : undefined);
    } catch {
      // Ignore invalid JWT payloads.
    }
  }

  if (!supported) {
    return {
      accessToken: typeof accessTokenValue === "string" ? accessTokenValue : "",
      accountId: accountId ?? "",
      refreshToken:
        typeof refreshTokenValue === "string" && refreshTokenValue.trim() !== ""
          ? refreshTokenValue
          : undefined,
      planType,
      issuer,
      clientId,
      supported: false,
    };
  }

  if (typeof accessTokenValue !== "string" || accessTokenValue.trim() === "") {
    throw new Error("auth.json is missing access_token.");
  }

  if (!accountId) {
    throw new Error("auth.json is missing ChatGPT account_id.");
  }

  return {
    accessToken: accessTokenValue,
    accountId,
    refreshToken:
      typeof refreshTokenValue === "string" && refreshTokenValue.trim() !== ""
        ? refreshTokenValue
        : undefined,
    planType,
    issuer,
    clientId,
    supported: true,
  };
}

async function readChatGPTBaseUrl(homeDir?: string): Promise<string> {
  if (!homeDir) {
    return DEFAULT_CHATGPT_BASE_URL;
  }

  try {
    const config = await readFile(join(homeDir, ".codex", "config.toml"), "utf8");
    for (const line of config.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("chatgpt_base_url")) {
        continue;
      }

      const [, rawValue] = trimmed.split("=", 2);
      const value = rawValue?.trim().replace(/^['"]|['"]$/gu, "");
      if (value) {
        return value.replace(/\/+$/u, "");
      }
    }
  } catch {
    // Fall through to the default base URL.
  }

  return DEFAULT_CHATGPT_BASE_URL;
}

async function resolveUsageUrls(homeDir?: string): Promise<string[]> {
  const baseUrl = await readChatGPTBaseUrl(homeDir);
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, "");
  const candidates = [
    `${normalizedBaseUrl}/backend-api/wham/usage`,
    "https://chatgpt.com/backend-api/wham/usage",
  ];

  return [...new Set(candidates)];
}

function normalizeFetchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientUsageStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isLastAttempt(attempt: number): boolean {
  return attempt >= USAGE_FETCH_ATTEMPTS;
}

function formatUsageAttemptError(url: string, attempt: number, message: string): string {
  const retryContext =
    USAGE_FETCH_ATTEMPTS > 1 ? ` attempt ${attempt}/${USAGE_FETCH_ATTEMPTS}` : "";
  return `${url}${retryContext} -> ${message}`;
}

function shouldRetryWithTokenRefresh(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("invalid_token") ||
    normalized.includes("deactivated_workspace")
  );
}

function parseCreditsBalance(balance: string | null | undefined): number | undefined {
  if (balance === undefined || balance === null) {
    return undefined;
  }

  const normalized = balance.trim().toLowerCase();
  if (normalized === "" || normalized === "null" || normalized === "none" || normalized === "nan") {
    return undefined;
  }

  const numeric = Number.parseFloat(balance);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  throw new Error(`Invalid credits balance "${balance}".`);
}

function mapUsagePayload(
  payload: UsageApiResponse,
  fallbackPlanType: string | undefined,
  fetchedAt: string,
): QuotaSnapshot {
  if (!payload.credits) {
    throw new Error('Usage response is missing the "credits" field.');
  }

  const windows = collectUsageWindows(payload);

  return {
    status: "ok",
    plan_type: payload.plan_type ?? fallbackPlanType,
    credits_balance: parseCreditsBalance(payload.credits.balance),
    fetched_at: fetchedAt,
    unlimited: payload.credits.unlimited === true,
    five_hour: pickNearestWindow(windows, 5 * 60 * 60),
    one_week: pickNearestWindow(windows, 7 * 24 * 60 * 60),
  };
}

function collectUsageWindows(payload: UsageApiResponse): UsageWindowRaw[] {
  const windows: UsageWindowRaw[] = [];

  const pushRateLimit = (rateLimit: RateLimitDetails | undefined) => {
    if (!rateLimit) {
      return;
    }

    if (rateLimit.primary_window) {
      windows.push(rateLimit.primary_window);
    }
    if (rateLimit.secondary_window) {
      windows.push(rateLimit.secondary_window);
    }
  };

  pushRateLimit(payload.rate_limit);
  for (const additional of payload.additional_rate_limits ?? []) {
    pushRateLimit(additional.rate_limit);
  }

  return windows;
}

function pickNearestWindow(
  windows: UsageWindowRaw[],
  targetSeconds: number,
): QuotaWindowSnapshot | undefined {
  const nearest = windows.reduce<UsageWindowRaw | undefined>((best, current) => {
    if (!best) {
      return current;
    }

    return Math.abs(current.limit_window_seconds - targetSeconds) <
      Math.abs(best.limit_window_seconds - targetSeconds)
      ? current
      : best;
  }, undefined);

  if (!nearest) {
    return undefined;
  }

  return {
    used_percent: nearest.used_percent,
    window_seconds: nearest.limit_window_seconds,
    reset_after_seconds: nearest.reset_after_seconds,
    reset_at:
      typeof nearest.reset_at === "number"
        ? new Date(nearest.reset_at * 1000).toISOString()
        : undefined,
  };
}

async function requestUsage(
  snapshot: AuthSnapshot,
  options: QuotaClientOptions,
): Promise<QuotaSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const mode = options.mode ?? "default";
  const extracted = extractChatGPTAuth(snapshot);
  const urls = await resolveUsageUrls(options.homeDir);
  const candidateUrls = mode === "list-fast" ? urls.slice(0, 1) : urls;
  const usageFetchAttempts =
    mode === "list-fast" ? LIST_FAST_FETCH_ATTEMPTS : USAGE_FETCH_ATTEMPTS;
  const usageFetchTimeoutMs =
    mode === "list-fast" ? LIST_FAST_FETCH_TIMEOUT_MS : USAGE_FETCH_TIMEOUT_MS;
  const now = (options.now ?? new Date()).toISOString();
  const errors: string[] = [];

  for (const url of candidateUrls) {
    for (let attempt = 1; attempt <= usageFetchAttempts; attempt += 1) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), usageFetchTimeoutMs);
      let response: Response;

      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${extracted.accessToken}`,
            "ChatGPT-Account-Id": extracted.accountId,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          signal: abortController.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        const message = abortController.signal.aborted
          ? `timed out after ${usageFetchTimeoutMs}ms`
          : normalizeFetchError(error);
        errors.push(formatUsageAttemptError(url, attempt, message));

        if (attempt < usageFetchAttempts) {
          await delay(USAGE_FETCH_RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text();
        errors.push(
          formatUsageAttemptError(
            url,
            attempt,
            `${response.status}: ${body.slice(0, 140).replace(/\s+/gu, " ").trim()}`,
          ),
        );

        if (isTransientUsageStatus(response.status) && attempt < usageFetchAttempts) {
          await delay(USAGE_FETCH_RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      let payload: UsageApiResponse;
      try {
        payload = (await response.json()) as UsageApiResponse;
      } catch (error) {
        errors.push(
          formatUsageAttemptError(
            url,
            attempt,
            `failed to parse JSON: ${normalizeFetchError(error)}`,
          ),
        );
        break;
      }

      return mapUsagePayload(payload, extracted.planType, now);
    }
  }

  throw new Error(
    errors.length === 0
      ? "Usage request failed: no candidate URL was attempted."
      : `Usage request failed: ${errors.join(" | ")}`,
  );
}

export async function refreshChatGPTAuthTokens(
  snapshot: AuthSnapshot,
  options: QuotaClientOptions,
): Promise<AuthSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const extracted = extractChatGPTAuth(snapshot);
  if (!extracted.refreshToken) {
    throw new Error("auth.json is missing refresh_token.");
  }

  const tokenUrl = `${(extracted.issuer ?? "https://auth.openai.com").replace(/\/+$/u, "")}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: extracted.refreshToken,
  });

  if (extracted.clientId) {
    body.set("client_id", extracted.clientId);
  }

  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Token refresh failed: ${response.status} ${errorText.slice(0, 140).replace(/\s+/gu, " ").trim()}`,
    );
  }

  const payload = (await response.json()) as RefreshedTokenPayload;
  const nextSnapshot = {
    ...snapshot,
    last_refresh: (options.now ?? new Date()).toISOString(),
    tokens: {
      ...(snapshot.tokens ?? {}),
      access_token: payload.access_token,
      id_token: payload.id_token,
      refresh_token: payload.refresh_token ?? extracted.refreshToken,
      account_id: extracted.accountId,
    },
  };

  return nextSnapshot;
}

export async function fetchQuotaSnapshot(
  snapshot: AuthSnapshot,
  options: QuotaClientOptions = {},
): Promise<QuotaFetchResult> {
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const extracted = extractChatGPTAuth(snapshot);

  if (!extracted.supported) {
    return {
      quota: {
        status: "unsupported",
        plan_type: extracted.planType ?? parsePlanType(snapshot),
        fetched_at: fetchedAt,
      },
      authSnapshot: snapshot,
    };
  }

  try {
    return {
      quota: await requestUsage(snapshot, options),
      authSnapshot: snapshot,
    };
  } catch (error) {
    if (options.mode === "list-fast") {
      throw error;
    }

    const message = normalizeFetchError(error);
    if (!extracted.refreshToken || !shouldRetryWithTokenRefresh(message)) {
      throw error;
    }

    const refreshedSnapshot = await refreshChatGPTAuthTokens(snapshot, options);
    return {
      quota: await requestUsage(refreshedSnapshot, options),
      authSnapshot: refreshedSnapshot,
    };
  }
}
