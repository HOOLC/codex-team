import type { AccountStore } from "../account-store/index.js";
import type { DaemonProcessManager } from "./process.js";
import { defaultDaemonState } from "./state.js";
import { enqueueDaemonRequest } from "./requests.js";

export async function triggerDaemonAuthRefresh(options: {
  store: AccountStore;
  daemonProcessManager: DaemonProcessManager;
  ensureDaemon: boolean;
  source: string;
}): Promise<{ started: boolean; enqueued: boolean }> {
  const status = await options.daemonProcessManager.getStatus();
  const currentState = status.state ?? defaultDaemonState(options.store.paths.codexTeamDir);

  if (!status.running) {
    if (!options.ensureDaemon) {
      return {
        started: false,
        enqueued: false,
      };
    }

    await options.daemonProcessManager.ensureConfig({
      stayalive: true,
      watch: currentState.watch,
      auto_switch: currentState.watch ? currentState.auto_switch : false,
      proxy: currentState.proxy,
      host: currentState.host,
      port: currentState.port,
      debug: currentState.debug,
      base_url: currentState.base_url,
      openai_base_url: currentState.openai_base_url,
    });
  }

  await enqueueDaemonRequest(options.store.paths.codexTeamDir, {
    type: "auth-refresh-now",
    source: options.source,
  });
  return {
    started: !status.running,
    enqueued: true,
  };
}
