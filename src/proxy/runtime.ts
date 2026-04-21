import { join } from "node:path";
import { readFile } from "node:fs/promises";

import type { AccountStore, ManagedAccount } from "../account-store/index.js";
import { getSnapshotIdentity, readAuthSnapshotFile } from "../auth-snapshot.js";
import { pathExists } from "../account-store/storage.js";
import { reapplySyntheticProxyRuntime, writeSyntheticProxyRuntime } from "./config.js";
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

async function resolveProxyDirectAuthBackupPath(store: AccountStore): Promise<string | null> {
  const state = await readProxyState(store.paths.codexTeamDir);
  if (state?.direct_auth_backup_path && await pathExists(state.direct_auth_backup_path)) {
    return state.direct_auth_backup_path;
  }

  const defaultBackupPath = join(resolveProxyDataDir(store.paths.codexTeamDir), "last-direct-auth.json");
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

export async function restoreSyntheticProxyRuntime(store: AccountStore): Promise<boolean> {
  const state = await readProxyState(store.paths.codexTeamDir);
  if (!state) {
    return false;
  }

  const restoredState = await writeSyntheticProxyRuntime({
    store,
    state,
  });
  await writeProxyState(store.paths.codexTeamDir, {
    ...restoredState,
    enabled: true,
  });
  return true;
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
