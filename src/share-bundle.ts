import { readFile } from "node:fs/promises";

import {
  type AuthSnapshot,
  parseAuthSnapshot,
} from "./auth-snapshot.js";
import {
  FILE_MODE,
  atomicWriteFile,
} from "./account-store/storage.js";

export const SHARE_BUNDLE_SCHEMA_VERSION = 1;

export interface ShareBundle {
  schema_version: number;
  exported_at: string;
  source_type: "current" | "managed";
  source_name: string | null;
  suggested_name: string | null;
  auth_snapshot: AuthSnapshot;
  config_snapshot: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringOrNull(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Field "${fieldName}" must be a string or null.`);
  }
  return value;
}

function asNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Field "${fieldName}" must be a non-empty string.`);
  }
  return value;
}

export function createShareBundle(options: {
  sourceType: "current" | "managed";
  sourceName?: string | null;
  suggestedName?: string | null;
  authSnapshot: AuthSnapshot;
  configSnapshot?: string | null;
  exportedAt?: Date;
}): ShareBundle {
  return {
    schema_version: SHARE_BUNDLE_SCHEMA_VERSION,
    exported_at: (options.exportedAt ?? new Date()).toISOString(),
    source_type: options.sourceType,
    source_name: options.sourceName ?? null,
    suggested_name: options.suggestedName ?? null,
    auth_snapshot: parseAuthSnapshot(JSON.stringify(options.authSnapshot)),
    config_snapshot: options.configSnapshot ?? null,
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

  const schemaVersion = parsed.schema_version;
  if (schemaVersion !== SHARE_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported share bundle schema version: ${String(schemaVersion)}`);
  }

  const sourceType = parsed.source_type;
  if (sourceType !== "current" && sourceType !== "managed") {
    throw new Error(`Unsupported share bundle source_type: ${String(sourceType)}`);
  }

  if (!("auth_snapshot" in parsed)) {
    throw new Error("Share bundle is missing auth snapshot.");
  }

  return {
    schema_version: schemaVersion,
    exported_at: asNonEmptyString(parsed.exported_at, "exported_at"),
    source_type: sourceType,
    source_name: asStringOrNull(parsed.source_name, "source_name"),
    suggested_name: asStringOrNull(parsed.suggested_name, "suggested_name"),
    auth_snapshot: parseAuthSnapshot(JSON.stringify(parsed.auth_snapshot)),
    config_snapshot: asStringOrNull(parsed.config_snapshot, "config_snapshot"),
  };
}

export async function readShareBundleFile(filePath: string): Promise<ShareBundle> {
  return parseShareBundle(await readFile(filePath, "utf8"));
}

export async function writeShareBundleFile(filePath: string, bundle: ShareBundle): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, FILE_MODE);
}
