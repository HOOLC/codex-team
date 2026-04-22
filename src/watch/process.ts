import { createDaemonProcessManager } from "../daemon/process.js";
import { defaultDaemonState } from "../daemon/state.js";

export interface WatchProcessState {
  pid: number;
  started_at: string;
  log_path: string;
  auto_switch: boolean;
  debug: boolean;
}

export interface WatchProcessManager {
  startDetached(options: {
    autoSwitch: boolean;
    debug: boolean;
  }): Promise<WatchProcessState>;
  getStatus(): Promise<{
    running: boolean;
    state: WatchProcessState | null;
  }>;
  stop(): Promise<{
    running: boolean;
    state: WatchProcessState | null;
    stopped: boolean;
  }>;
}

function toWatchState(state: {
  pid: number;
  started_at: string;
  log_path: string;
  auto_switch: boolean;
  debug: boolean;
}): WatchProcessState {
  return {
    pid: state.pid,
    started_at: state.started_at,
    log_path: state.log_path,
    auto_switch: state.auto_switch,
    debug: state.debug,
  };
}

export function createWatchProcessManager(codexTeamDir: string): WatchProcessManager {
  const daemonProcessManager = createDaemonProcessManager(codexTeamDir);

  async function getStatus(): Promise<{ running: boolean; state: WatchProcessState | null }> {
    const status = await daemonProcessManager.getStatus();
    if (!status.running || !status.state?.watch) {
      return {
        running: false,
        state: null,
      };
    }

    return {
      running: true,
      state: toWatchState(status.state),
    };
  }

  async function startDetached(options: {
    autoSwitch: boolean;
    debug: boolean;
  }): Promise<WatchProcessState> {
    const current = (await daemonProcessManager.getStatus()).state ?? defaultDaemonState(codexTeamDir);
    const result = await daemonProcessManager.ensureConfig({
      stayalive: true,
      watch: true,
      auto_switch: options.autoSwitch,
      proxy: current.proxy,
      host: current.host,
      port: current.port,
      debug: current.debug || options.debug,
      base_url: current.base_url,
      openai_base_url: current.openai_base_url,
    });
    return toWatchState(result.state);
  }

  async function stop(): Promise<{
    running: boolean;
    state: WatchProcessState | null;
    stopped: boolean;
  }> {
    const status = await daemonProcessManager.getStatus();
    if (!status.running || !status.state?.watch) {
      return {
        running: false,
        state: null,
        stopped: false,
      };
    }

    const previousState = toWatchState(status.state);
    if (status.state.proxy) {
      await daemonProcessManager.ensureConfig({
        stayalive: true,
        watch: false,
        auto_switch: false,
        proxy: true,
        host: status.state.host,
        port: status.state.port,
        debug: status.state.debug,
        base_url: status.state.base_url,
        openai_base_url: status.state.openai_base_url,
      });
    } else {
      await daemonProcessManager.stop();
    }

    return {
      running: false,
      state: previousState,
      stopped: true,
    };
  }

  return {
    startDetached,
    getStatus,
    stop,
  };
}
