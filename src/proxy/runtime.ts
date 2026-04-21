import type { AccountStore } from "../account-store/index.js";
import { readAuthSnapshotFile } from "../auth-snapshot.js";
import { readProxyState, writeProxyState } from "./state.js";
import { isSyntheticProxyAuthSnapshot } from "./synthetic-auth.js";

export async function isSyntheticProxyRuntimeActive(store: AccountStore): Promise<boolean> {
  try {
    return isSyntheticProxyAuthSnapshot(await readAuthSnapshotFile(store.paths.currentAuthPath));
  } catch {
    return false;
  }
}

export async function markProxyRoutingDisabled(store: AccountStore): Promise<void> {
  const state = await readProxyState(store.paths.codexTeamDir);
  if (!state || state.enabled !== true) {
    return;
  }

  await writeProxyState(store.paths.codexTeamDir, {
    ...state,
    enabled: false,
  });
}
