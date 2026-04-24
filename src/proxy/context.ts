import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AccountStore } from "../account-store/index.js";
import { cloneJsonValue } from "./json.js";
import { resolveProxyDataDir } from "./state.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SCHEMA_VERSION = 1;
const RESPONSE_ID_PREFIX = "resp_pxy_";
const CHAIN_ID_PREFIX = "chain_pxy_";

export interface ProxyResponseCheckpoint {
  version: number;
  proxy_response_id: string;
  chain_id: string;
  parent_proxy_response_id: string | null;
  upstream_response_id: string | null;
  account_name: string;
  request_shape_without_input: Record<string, unknown>;
  canonical_context: unknown[];
  created_at: string;
  updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseCheckpointDirectory(store: AccountStore): string {
  return join(resolveProxyDataDir(store.paths.codexTeamDir), "responses");
}

function responseCheckpointPath(store: AccountStore, proxyResponseId: string): string {
  return join(responseCheckpointDirectory(store), `${proxyResponseId}.json`);
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, { mode: FILE_MODE });
  await rename(tempPath, path);
}

function parseProxyResponseCheckpoint(raw: string): ProxyResponseCheckpoint | null {
  if (raw.trim() === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (
    parsed.version !== SCHEMA_VERSION
    || typeof parsed.proxy_response_id !== "string"
    || parsed.proxy_response_id.trim() === ""
    || typeof parsed.chain_id !== "string"
    || parsed.chain_id.trim() === ""
    || (parsed.parent_proxy_response_id !== null && typeof parsed.parent_proxy_response_id !== "string")
    || (parsed.upstream_response_id !== null && typeof parsed.upstream_response_id !== "string")
    || typeof parsed.account_name !== "string"
    || parsed.account_name.trim() === ""
    || !isRecord(parsed.request_shape_without_input)
    || !Array.isArray(parsed.canonical_context)
    || typeof parsed.created_at !== "string"
    || typeof parsed.updated_at !== "string"
  ) {
    return null;
  }

  return {
    version: SCHEMA_VERSION,
    proxy_response_id: parsed.proxy_response_id,
    chain_id: parsed.chain_id,
    parent_proxy_response_id: parsed.parent_proxy_response_id,
    upstream_response_id: parsed.upstream_response_id,
    account_name: parsed.account_name,
    request_shape_without_input: cloneJsonValue(parsed.request_shape_without_input),
    canonical_context: cloneJsonValue(parsed.canonical_context),
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  };
}

export function createProxyResponseId(): string {
  return `${RESPONSE_ID_PREFIX}${randomUUID()}`;
}

export function createProxyChainId(): string {
  return `${CHAIN_ID_PREFIX}${randomUUID()}`;
}

export function isProxyResponseId(value: string): boolean {
  return value.startsWith(RESPONSE_ID_PREFIX);
}

export async function readProxyResponseCheckpoint(
  store: AccountStore,
  proxyResponseId: string,
): Promise<ProxyResponseCheckpoint | null> {
  try {
    return parseProxyResponseCheckpoint(
      await readFile(responseCheckpointPath(store, proxyResponseId), "utf8"),
    );
  } catch {
    return null;
  }
}

export async function writeProxyResponseCheckpoint(
  store: AccountStore,
  checkpoint: ProxyResponseCheckpoint,
): Promise<void> {
  await atomicWriteFile(
    responseCheckpointPath(store, checkpoint.proxy_response_id),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
}
