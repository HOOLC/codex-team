import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAuthSnapshot, type AuthSnapshot } from "../src/auth-snapshot.js";

export async function createTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codex-team-"));
}

export async function cleanupTempHome(homeDir: string): Promise<void> {
  await rm(homeDir, { recursive: true, force: true });
}

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

export function createAuthPayload(
  accountId: string,
  authMode = "chatgpt",
  planType = "plus",
  userId?: string,
): AuthSnapshot {
  const authClaim = {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: planType,
    ...(typeof userId === "string" && userId.trim() !== ""
      ? {
          chatgpt_user_id: userId,
          user_id: userId,
        }
      : {}),
  };
  const issuedAt = 1_773_850_555;

  return {
    auth_mode: authMode,
    OPENAI_API_KEY: null,
    tokens: {
      account_id: accountId,
      access_token: encodeJwt({
        iss: "https://auth.openai.com",
        aud: "app_codexm_tests",
        client_id: "app_codexm_tests",
        iat: issuedAt,
        exp: issuedAt + 86_400,
        "https://api.openai.com/auth": authClaim,
      }),
      refresh_token: `refresh-${accountId}`,
      id_token: encodeJwt({
        iss: "https://auth.openai.com",
        aud: "app_codexm_tests",
        client_id: "app_codexm_tests",
        email: `${accountId}@example.com`,
        iat: issuedAt,
        exp: issuedAt + 3_600,
        "https://api.openai.com/auth": authClaim,
      }),
    },
    last_refresh: "2026-03-18T00:00:00.000Z",
  };
}

export function createApiKeyPayload(apiKey: string): AuthSnapshot {
  return {
    auth_mode: "apikey",
    OPENAI_API_KEY: apiKey,
  };
}

export async function writeCurrentAuth(
  homeDir: string,
  accountId: string,
  authMode = "chatgpt",
  planType = "plus",
  userId?: string,
): Promise<void> {
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(codexDir, "auth.json"),
    `${JSON.stringify(createAuthPayload(accountId, authMode, planType, userId), null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function writeCurrentApiKeyAuth(
  homeDir: string,
  apiKey: string,
): Promise<void> {
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(codexDir, "auth.json"),
    `${JSON.stringify(createApiKeyPayload(apiKey), null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function writeCurrentConfig(
  homeDir: string,
  rawConfig: string,
): Promise<void> {
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(codexDir, "config.toml"),
    rawConfig.endsWith("\n") ? rawConfig : `${rawConfig}\n`,
    { mode: 0o600 },
  );
}

export async function readCurrentConfig(homeDir: string): Promise<string> {
  return readFile(join(homeDir, ".codex", "config.toml"), "utf8");
}

export async function readCurrentAuth(homeDir: string): Promise<AuthSnapshot> {
  const raw = await readFile(join(homeDir, ".codex", "auth.json"), "utf8");
  return parseAuthSnapshot(raw);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

export function installFetchMock(
  implementation: typeof fetch,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  return () => {
    globalThis.fetch = originalFetch;
  };
}
