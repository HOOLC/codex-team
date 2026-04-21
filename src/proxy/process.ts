import { createDaemonProcessManager } from "../daemon/process.js";
import { defaultDaemonState } from "../daemon/state.js";
import {
  DEFAULT_PROXY_HOST,
  DEFAULT_PROXY_PORT,
  proxyBackendBaseUrl,
  proxyOpenAIBaseUrl,
} from "./constants.js";
import { readProxyState, writeProxyState, type ProxyProcessState, type ProxyStatus } from "./state.js";

export interface ProxyProcessManager {
  startDetached(options: {
    host: string;
    port: number;
    debug: boolean;
  }): Promise<ProxyProcessState>;
  getStatus(): Promise<ProxyStatus>;
  stop(): Promise<{
    running: boolean;
    state: ProxyProcessState | null;
    stopped: boolean;
  }>;
}

function toMaterializedProxyState(
  previous: ProxyProcessState | null,
  state: {
    pid: number;
    host: string;
    port: number;
    started_at: string;
    log_path: string;
    base_url: string;
    openai_base_url: string;
    debug: boolean;
  },
): ProxyProcessState {
  return {
    ...(previous ?? {}),
    pid: state.pid,
    host: state.host,
    port: state.port,
    started_at: state.started_at,
    log_path: state.log_path,
    base_url: state.base_url,
    openai_base_url: state.openai_base_url,
    debug: state.debug,
  };
}

export function createProxyProcessManager(codexTeamDir: string): ProxyProcessManager {
  const daemonProcessManager = createDaemonProcessManager(codexTeamDir);

  async function getStatus(): Promise<ProxyStatus> {
    const [daemonStatus, proxyState] = await Promise.all([
      daemonProcessManager.getStatus(),
      readProxyState(codexTeamDir),
    ]);
    if (!daemonStatus.running || !daemonStatus.state?.proxy) {
      return {
        running: false,
        state: proxyState,
      };
    }

    return {
      running: true,
      state: toMaterializedProxyState(proxyState, daemonStatus.state),
    };
  }

  async function startDetached(options: {
    host: string;
    port: number;
    debug: boolean;
  }): Promise<ProxyProcessState> {
    const current = (await daemonProcessManager.getStatus()).state ?? defaultDaemonState(codexTeamDir);
    const host = options.host || current.host || DEFAULT_PROXY_HOST;
    const port = options.port || current.port || DEFAULT_PROXY_PORT;
    const result = await daemonProcessManager.ensureConfig({
      stayalive: true,
      watch: current.watch,
      auto_switch: current.watch ? current.auto_switch : false,
      proxy: true,
      host,
      port,
      debug: current.debug || options.debug,
      base_url: proxyBackendBaseUrl(host, port),
      openai_base_url: proxyOpenAIBaseUrl(host, port),
    });
    const previous = await readProxyState(codexTeamDir);
    const state = toMaterializedProxyState(previous, result.state);
    await writeProxyState(codexTeamDir, state);
    return state;
  }

  async function stop(): Promise<{
    running: boolean;
    state: ProxyProcessState | null;
    stopped: boolean;
  }> {
    const status = await getStatus();
    if (!status.running || !status.state) {
      return {
        running: false,
        state: status.state,
        stopped: false,
      };
    }

    const daemonStatus = await daemonProcessManager.getStatus();
    if (daemonStatus.running && daemonStatus.state?.watch) {
      await daemonProcessManager.ensureConfig({
        stayalive: true,
        watch: true,
        auto_switch: daemonStatus.state.auto_switch,
        proxy: false,
        host: daemonStatus.state.host,
        port: daemonStatus.state.port,
        debug: daemonStatus.state.debug,
        base_url: daemonStatus.state.base_url,
        openai_base_url: daemonStatus.state.openai_base_url,
      });
    } else {
      await daemonProcessManager.stop();
    }

    await writeProxyState(codexTeamDir, {
      ...status.state,
      pid: 0,
    });
    return {
      running: false,
      state: status.state,
      stopped: true,
    };
  }

  return {
    startDetached,
    getStatus,
    stop,
  };
}
