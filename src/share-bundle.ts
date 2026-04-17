import { readFile } from "node:fs/promises";

import {
  type AuthSnapshot,
  getSnapshotAccountId,
  getSnapshotEmail,
  getSnapshotIdentity,
  getSnapshotUserId,
  isApiKeyAuthMode,
  isSupportedChatGPTAuthMode,
  parseAuthSnapshot,
} from "./auth-snapshot.js";
import {
  FILE_MODE,
  atomicWriteFile,
} from "./account-store/storage.js";
import {
  extractChatGPTAuth,
} from "./quota-client.js";

export const SHARE_BUNDLE_KIND = "auth_bundle";
export const SHARE_BUNDLE_VERSION = 1;

export type ShareBundleAuthKind = "chatgpt" | "apikey";

export interface ShareBundleProfile {
  account_id?: string;
  user_id?: string;
  email?: string;
  plan?: string;
}

export interface ShareBundleAuth {
  kind: ShareBundleAuthKind;
  auth_json: AuthSnapshot;
  config_toml?: string;
  profile?: ShareBundleProfile;
}

export interface ShareBundle {
  kind: typeof SHARE_BUNDLE_KIND;
  version: number;
  exported_at: string;
  auth: ShareBundleAuth;
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

function normalizeShareBundleAuthKind(value: unknown, fieldName: string): ShareBundleAuthKind {
  if (typeof value !== "string") {
    throw new Error(`Field "${fieldName}" must be a string.`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "chatgpt" || normalized === "apikey") {
    return normalized;
  }

  throw new Error(`Unsupported ${fieldName}: ${value}`);
}

function getShareBundleAuthKind(snapshot: AuthSnapshot): ShareBundleAuthKind {
  if (isApiKeyAuthMode(snapshot.auth_mode)) {
    return "apikey";
  }
  if (isSupportedChatGPTAuthMode(snapshot.auth_mode)) {
    return "chatgpt";
  }

  throw new Error(`Unsupported auth snapshot mode for share bundle: ${snapshot.auth_mode}`);
}

function parseShareBundleProfile(raw: unknown): ShareBundleProfile | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (!isRecord(raw)) {
    throw new Error('Field "auth.profile" must be an object.');
  }

  const profile: ShareBundleProfile = {
    account_id: asOptionalString(raw.account_id, "auth.profile.account_id"),
    user_id: asOptionalString(raw.user_id, "auth.profile.user_id"),
    email: asOptionalString(raw.email, "auth.profile.email"),
    plan: asOptionalString(raw.plan, "auth.profile.plan"),
  };

  if (
    profile.account_id === undefined &&
    profile.user_id === undefined &&
    profile.email === undefined &&
    profile.plan === undefined
  ) {
    return undefined;
  }

  return profile;
}

export interface DerivedShareBundleFacts {
  kind: ShareBundleAuthKind;
  account_id: string;
  user_id: string | null;
  identity: string;
  email: string | null;
  plan: string | null;
}

export function deriveShareBundleFacts(snapshot: AuthSnapshot): DerivedShareBundleFacts {
  const kind = getShareBundleAuthKind(snapshot);
  const extractedAuth = kind === "chatgpt" ? extractChatGPTAuth(snapshot) : null;

  return {
    kind,
    account_id: getSnapshotAccountId(snapshot),
    user_id: kind === "chatgpt" ? getSnapshotUserId(snapshot) ?? null : null,
    identity: getSnapshotIdentity(snapshot),
    email: kind === "chatgpt" ? getSnapshotEmail(snapshot) ?? null : null,
    plan: kind === "chatgpt" ? extractedAuth?.planType ?? null : null,
  };
}

export function createShareBundle(options: {
  authSnapshot: AuthSnapshot;
  configToml?: string | null;
  exportedAt?: Date;
}): ShareBundle {
  const authSnapshot = parseAuthSnapshot(JSON.stringify(options.authSnapshot));
  const facts = deriveShareBundleFacts(authSnapshot);
  const configToml = options.configToml ?? undefined;

  return {
    kind: SHARE_BUNDLE_KIND,
    version: SHARE_BUNDLE_VERSION,
    exported_at: (options.exportedAt ?? new Date()).toISOString(),
    auth: {
      kind: facts.kind,
      auth_json: authSnapshot,
      ...(configToml === undefined ? {} : { config_toml: configToml }),
      ...(facts.kind === "chatgpt"
        ? {
            profile: {
              account_id: facts.account_id,
              ...(facts.user_id ? { user_id: facts.user_id } : {}),
              ...(facts.email ? { email: facts.email } : {}),
              ...(facts.plan ? { plan: facts.plan } : {}),
            },
          }
        : {}),
    },
  };
}

export function parseShareBundle(raw: string): ShareBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse share bundle JSON: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Share bundle must be a JSON object.");
  }

  if (parsed.kind !== SHARE_BUNDLE_KIND) {
    throw new Error(`Unsupported share bundle kind: ${String(parsed.kind)}`);
  }

  if (parsed.version !== SHARE_BUNDLE_VERSION) {
    throw new Error(`Unsupported share bundle version: ${String(parsed.version)}`);
  }

  if (!isRecord(parsed.auth)) {
    throw new Error('Field "auth" must be an object.');
  }

  const authKind = normalizeShareBundleAuthKind(parsed.auth.kind, "auth.kind");
  const authSnapshot = parseAuthSnapshot(JSON.stringify(parsed.auth.auth_json));
  const derivedKind = getShareBundleAuthKind(authSnapshot);
  if (derivedKind !== authKind) {
    throw new Error(
      `Share bundle auth kind "${authKind}" does not match auth snapshot mode "${authSnapshot.auth_mode}".`,
    );
  }

  return {
    kind: SHARE_BUNDLE_KIND,
    version: SHARE_BUNDLE_VERSION,
    exported_at: asNonEmptyString(parsed.exported_at, "exported_at"),
    auth: {
      kind: authKind,
      auth_json: authSnapshot,
      ...(parsed.auth.config_toml === undefined
        ? {}
        : { config_toml: asNonEmptyString(parsed.auth.config_toml, "auth.config_toml") }),
      ...(parsed.auth.profile === undefined
        ? {}
        : { profile: parseShareBundleProfile(parsed.auth.profile) }),
    },
  };
}

export async function readShareBundleFile(filePath: string): Promise<ShareBundle> {
  return parseShareBundle(await readFile(filePath, "utf8"));
}

export async function writeShareBundleFile(filePath: string, bundle: ShareBundle): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, FILE_MODE);
}
