import { join } from "node:path";
import { copyFile, readFile } from "node:fs/promises";

import type { AccountStore, ManagedAccount } from "../account-store/index.js";
import { getSnapshotIdentity, readAuthSnapshotFile } from "../auth-snapshot.js";
import {
  DIRECTORY_MODE,
  FILE_MODE,
  atomicWriteFile,
  chmodIfPossible,
  ensureDirectory,
  pathExists,
} from "../account-store/storage.js";
import { sanitizeConfigForAccountAuth } from "../account-store/config.js";
import {
  reapplySyntheticProxyRuntime,
  stripProxyRuntimeConfig,
  writeSyntheticProxyRuntime,
} from "./config.js";
import { readProxyState, type ProxyProcessState, writeProxyState, resolveProxyDataDir } from "./state.js";
import { isSyntheticProxyAuthSnapshot } from "./synthetic-auth.js";

export async function isSyntheticProxyRuntimeActive(store: AccountStore): Promise<boolean> {
  try {
    return isSyntheticProxyAuthSnapshot(await readAuthSnapshotFile(store.paths.currentAuthPath));
  } catch {
    return false;
  }
}

function readConfigStringValue(rawConfig: string, key: string): string | null {
  for (const line of rawConfig.split(/\r?\n/u)) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "u"));
    if (match) {
      return match[1] ?? null;
    }
  }
  return null;
}

export async function isSyntheticProxyConfigActive(
  store: AccountStore,
  state?: ProxyProcessState | null,
): Promise<boolean> {
  const proxyState = state ?? await readProxyState(store.paths.codexTeamDir);
  if (!proxyState) {
    return false;
  }

  if (!(await pathExists(store.paths.currentConfigPath))) {
    return false;
  }

  try {
    const rawConfig = await readFile(store.paths.currentConfigPath, "utf8");
    return readConfigStringValue(rawConfig, "chatgpt_base_url") === proxyState.base_url
      && readConfigStringValue(rawConfig, "openai_base_url") === proxyState.openai_base_url;
  } catch {
    return false;
  }
}

export async function resolveManagedDesktopApiBaseUrl(
  store: AccountStore,
): Promise<string | null> {
  const state = await readProxyState(store.paths.codexTeamDir);
  return state?.enabled === true ? state.base_url : null;
}

async function resolveProxyDirectAuthBackupPath(store: AccountStore): Promise<string | null> {
  const state = await readProxyState(store.paths.codexTeamDir);
  if (state?.direct_auth_backup_path && await pathExists(state.direct_auth_backup_path)) {
    return state.direct_auth_backup_path;
  }

  const defaultBackupPath = join(resolveProxyDataDir(store.paths.codexTeamDir), "last-direct-auth.json");
  return await pathExists(defaultBackupPath) ? defaultBackupPath : null;
}

async function resolveProxyDirectConfigBackupPath(store: AccountStore): Promise<string | null> {
  const state = await readProxyState(store.paths.codexTeamDir);
  if (state?.direct_config_backup_path && await pathExists(state.direct_config_backup_path)) {
    return state.direct_config_backup_path;
  }

  const defaultBackupPath = join(resolveProxyDataDir(store.paths.codexTeamDir), "last-direct-config.toml");
  return await pathExists(defaultBackupPath) ? defaultBackupPath : null;
}

export async function resolveProxyManualUpstreamAccountName(
  store: AccountStore,
  accounts?: ManagedAccount[],
): Promise<string | null> {
  const backupPath = await resolveProxyDirectAuthBackupPath(store);
  if (!backupPath) {
    return null;
  }

  try {
    const snapshot = await readAuthSnapshotFile(backupPath);
    const identity = getSnapshotIdentity(snapshot);
    const managedAccounts = accounts ?? (await store.listAccounts()).accounts;
    return managedAccounts.find((account) => account.identity === identity)?.name ?? null;
  } catch {
    return null;
  }
}

async function resolveDirectConfigBackupContent(
  store: AccountStore,
  account: ManagedAccount,
): Promise<string | null> {
  if (account.auth_mode === "apikey") {
    if (account.configPath && await pathExists(account.configPath)) {
      return await readFile(account.configPath, "utf8");
    }
    return null;
  }

  const directConfigBackupPath = await resolveProxyDirectConfigBackupPath(store);
  const candidatePaths = [
    ...(account.configPath ? [account.configPath] : []),
    ...(await pathExists(store.paths.currentConfigPath) ? [store.paths.currentConfigPath] : []),
    ...(directConfigBackupPath ? [directConfigBackupPath] : []),
  ];
  for (const path of candidatePaths) {
    if (!(await pathExists(path))) {
      continue;
    }
    const rawConfig = await readFile(path, "utf8");
    const sanitized = stripProxyRuntimeConfig(sanitizeConfigForAccountAuth(rawConfig)).join("\n").replace(/\n+$/u, "");
    return sanitized === "" ? "\n" : `${sanitized}\n`;
  }

  return null;
}

export async function persistProxyUpstreamAccountSelection(
  store: AccountStore,
  account: ManagedAccount,
): Promise<void> {
  const proxyDataDir = resolveProxyDataDir(store.paths.codexTeamDir);
  await ensureDirectory(proxyDataDir, DIRECTORY_MODE);

  const state = await readProxyState(store.paths.codexTeamDir);
  const authBackupPath = state?.direct_auth_backup_path ?? join(proxyDataDir, "last-direct-auth.json");
  const configBackupPath = state?.direct_config_backup_path ?? join(proxyDataDir, "last-direct-config.toml");

  await copyFile(account.authPath, authBackupPath);
  await chmodIfPossible(authBackupPath, FILE_MODE);

  const configBackupContent = await resolveDirectConfigBackupContent(store, account);
  if (configBackupContent !== null) {
    await atomicWriteFile(configBackupPath, configBackupContent, FILE_MODE);
  }

  if (state) {
    await writeProxyState(store.paths.codexTeamDir, {
      ...state,
      direct_auth_backup_path: authBackupPath,
      direct_config_backup_path: configBackupContent !== null ? configBackupPath : state.direct_config_backup_path,
      direct_auth_existed: true,
      direct_config_existed: configBackupContent !== null ? true : state.direct_config_existed,
    });
  }
}

export async function ensureSyntheticProxyRuntimeActive(store: AccountStore): Promise<{
  restored: boolean;
  state: ProxyProcessState | null;
  authWasSynthetic: boolean;
  configWasSynthetic: boolean;
}> {
  const state = await readProxyState(store.paths.codexTeamDir);
  if (!state || state.enabled !== true) {
    return {
      restored: false,
      state,
      authWasSynthetic: false,
      configWasSynthetic: false,
    };
  }

  const [authWasSynthetic, configWasSynthetic] = await Promise.all([
    isSyntheticProxyRuntimeActive(store),
    isSyntheticProxyConfigActive(store, state),
  ]);
  if (authWasSynthetic && configWasSynthetic) {
    return {
      restored: false,
      state,
      authWasSynthetic,
      configWasSynthetic,
    };
  }

  const restoredState = await reapplySyntheticProxyRuntime({
    store,
    state,
  });
  await writeProxyState(store.paths.codexTeamDir, restoredState);
  return {
    restored: true,
    state: restoredState,
    authWasSynthetic,
    configWasSynthetic,
  };
}
