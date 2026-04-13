import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

import type { StorePaths } from "./account-store-types.js";

export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;
export const SCHEMA_VERSION = 1;
export const QUOTA_REFRESH_CONCURRENCY = 3;

const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function defaultPaths(homeDir = homedir()): StorePaths {
  const codexDir = join(homeDir, ".codex");
  const codexTeamDir = join(homeDir, ".codex-team");

  return {
    homeDir,
    codexDir,
    codexTeamDir,
    currentAuthPath: join(codexDir, "auth.json"),
    currentConfigPath: join(codexDir, "config.toml"),
    accountsDir: join(codexTeamDir, "accounts"),
    backupsDir: join(codexTeamDir, "backups"),
    statePath: join(codexTeamDir, "state.json"),
  };
}

export async function chmodIfPossible(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function ensureDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmodIfPossible(path, mode);
}

export async function atomicWriteFile(
  path: string,
  content: string,
  mode = FILE_MODE,
): Promise<void> {
  const directory = dirname(path);
  const tempPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );

  await ensureDirectory(directory, DIRECTORY_MODE);
  await writeFile(tempPath, content, { encoding: "utf8", mode });
  await chmodIfPossible(tempPath, mode);
  await rename(tempPath, path);
  await chmodIfPossible(path, mode);
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function ensureAccountName(name: string): void {
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new Error(
      'Account name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ and cannot contain path separators.',
    );
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function readJsonFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
