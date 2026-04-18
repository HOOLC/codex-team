import type { WatchProcessManager, WatchProcessState } from "./process.js";

export async function ensureDetachedWatch(
  watchProcessManager: Pick<WatchProcessManager, "getStatus" | "startDetached" | "stop">,
  options: { autoSwitch: boolean; autoSwitchEtaHours: number | null; debug: boolean },
): Promise<
  | { action: "started" | "restarted"; state: WatchProcessState }
  | { action: "reused"; state: WatchProcessState }
> {
  const status = await watchProcessManager.getStatus();
  if (status.running && status.state) {
    if (
      status.state.auto_switch === options.autoSwitch &&
      status.state.auto_switch_eta_hours === options.autoSwitchEtaHours &&
      status.state.debug === options.debug
    ) {
      return {
        action: "reused",
        state: status.state,
      };
    }

    await watchProcessManager.stop();
    return {
      action: "restarted",
      state: await watchProcessManager.startDetached(options),
    };
  }

  return {
    action: "started",
    state: await watchProcessManager.startDetached(options),
  };
}
