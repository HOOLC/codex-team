import {
  decodeJwtPayload,
  getSnapshotAccountId,
  getSnapshotEmail,
  getSnapshotUserId,
  isSupportedChatGPTAuthMode,
  type AuthSnapshot,
} from "../auth-snapshot.js";
import {
  PROXY_ACCOUNT_ID,
  PROXY_EMAIL,
  PROXY_PLAN_TYPE,
  PROXY_USER_ID,
} from "./constants.js";

const SYNTHETIC_ISSUER = "https://codexm.local/proxy";
const SYNTHETIC_AUDIENCE = "codexm-proxy";
const SYNTHETIC_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

function buildAuthClaim(): Record<string, unknown> {
  return {
    chatgpt_account_id: PROXY_ACCOUNT_ID,
    chatgpt_user_id: PROXY_USER_ID,
    chatgpt_plan_type: PROXY_PLAN_TYPE,
    user_id: PROXY_USER_ID,
    synthetic: "codexm-proxy",
  };
}

function buildProfileClaim(): Record<string, unknown> {
  return {
    email: PROXY_EMAIL,
  };
}

export function createSyntheticProxyAuthSnapshot(now = new Date()): AuthSnapshot {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + SYNTHETIC_LIFETIME_SECONDS;
  const authClaim = buildAuthClaim();
  const profileClaim = buildProfileClaim();
  const commonPayload = {
    iss: SYNTHETIC_ISSUER,
    aud: SYNTHETIC_AUDIENCE,
    client_id: SYNTHETIC_AUDIENCE,
    iat: issuedAt,
    exp: expiresAt,
    "https://api.openai.com/auth": authClaim,
    "https://api.openai.com/profile": profileClaim,
  };

  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: PROXY_ACCOUNT_ID,
      access_token: encodeJwt({
        ...commonPayload,
        scope: "codexm:proxy",
        email: PROXY_EMAIL,
      }),
      refresh_token: "codexm-proxy-refresh-token",
      id_token: encodeJwt({
        ...commonPayload,
        email: PROXY_EMAIL,
      }),
    },
    last_refresh: now.toISOString(),
  };
}

export function isSyntheticProxyAuthSnapshot(snapshot: AuthSnapshot): boolean {
  if (!isSupportedChatGPTAuthMode(snapshot.auth_mode)) {
    return false;
  }

  try {
    return (
      getSnapshotAccountId(snapshot) === PROXY_ACCOUNT_ID &&
      getSnapshotUserId(snapshot) === PROXY_USER_ID &&
      getSnapshotEmail(snapshot) === PROXY_EMAIL
    );
  } catch {
    return false;
  }
}

export function isSyntheticProxyBearerToken(value: string | null): boolean {
  const token = value?.replace(/^Bearer\s+/iu, "").trim();
  if (!token) {
    return false;
  }

  try {
    const payload = decodeJwtPayload(token);
    const authClaim = payload["https://api.openai.com/auth"];
    return (
      typeof authClaim === "object" &&
      authClaim !== null &&
      !Array.isArray(authClaim) &&
      (authClaim as Record<string, unknown>).chatgpt_account_id === PROXY_ACCOUNT_ID &&
      (authClaim as Record<string, unknown>).chatgpt_user_id === PROXY_USER_ID
    );
  } catch {
    return false;
  }
}
