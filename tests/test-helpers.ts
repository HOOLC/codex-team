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

export function createAuthPayload(accountId: string, authMode = "chatgpt"): AuthSnapshot {
  return {
    auth_mode: authMode,
    OPENAI_API_KEY: null,
    tokens: {
      account_id: accountId,
      access_token: `access-${accountId}`,
      refresh_token: `refresh-${accountId}`,
      id_token: `id-${accountId}`,
    },
    last_refresh: "2026-03-18T00:00:00.000Z",
  };
}

export async function writeCurrentAuth(
  homeDir: string,
  accountId: string,
  authMode = "chatgpt",
): Promise<void> {
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(codexDir, "auth.json"),
    `${JSON.stringify(createAuthPayload(accountId, authMode), null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function readCurrentAuth(homeDir: string): Promise<AuthSnapshot> {
  const raw = await readFile(join(homeDir, ".codex", "auth.json"), "utf8");
  return parseAuthSnapshot(raw);
}
