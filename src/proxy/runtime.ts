import { join } from "node:path";

import type { AccountStore, ManagedAccount } from "../account-store/index.js";
import { getSnapshotIdentity, readAuthSnapshotFile } from "../auth-snapshot.js";
import { pathExists } from "../account-store/storage.js";
import { writeSyntheticProxyRuntime } from "./config.js";
import { readProxyState, writeProxyState, resolveProxyDataDir } from "./state.js";
import { isSyntheticProxyAuthSnapshot } from "./synthetic-auth.js";

export async function isSyntheticProxyRuntimeActive(store: AccountStore): Promise<boolean> {
  try {
    return isSyntheticProxyAuthSnapshot(await readAuthSnapshotFile(store.paths.currentAuthPath));
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
