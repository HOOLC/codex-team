import type { AccountStore } from "../account-store/index.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import {
  DEFAULT_PROXY_HOST,
  proxyBackendBaseUrl,
  proxyOpenAIBaseUrl,
  resolveProxyPort,
} from "../proxy/constants.js";
import { restoreDirectRuntime, writeSyntheticProxyRuntime } from "../proxy/config.js";
import type { ProxyProcessManager } from "../proxy/process.js";
import { startProxyServer } from "../proxy/server.js";
import { readProxyState, writeProxyState, type ProxyProcessState } from "../proxy/state.js";
import { appendEventLog, appendProxyRequestLog, buildEventPayload, shortenErrorMessage } from "../logging.js";

type DebugLogger = (message: string) => void;

function resolveStateForPlan(host: string, port: number): ProxyProcessState {
  return {
    pid: 0,
    host,
    port,
    started_at: "",
    log_path: "",
    base_url: proxyBackendBaseUrl(host, port),
    openai_base_url: proxyOpenAIBaseUrl(host, port),
    debug: false,
  };
}

function describeStatus(status: {
  enabled: boolean;
  running: boolean;
  state: ProxyProcessState | null;
}): string {
  const state = status.state;
  const lines = [
    `Proxy: ${status.enabled ? "enabled" : "disabled"}`,
    `Daemon: ${status.running ? `running (pid ${state?.pid ?? "-"})` : "stopped"}`,
  ];
  if (state) {
    lines.push(`ChatGPT base URL: ${state.base_url}`);
    lines.push(`OpenAI base URL: ${state.openai_base_url}`);
    if (state.log_path) {
      lines.push(`Log: ${state.log_path}`);
    }
  }
  return lines.join("\n");
}

export async function enableProxyMode(options: {
  store: AccountStore;
  proxyProcessManager: ProxyProcessManager;
  host?: string;
  port?: number;
  debug: boolean;
}): Promise<ProxyProcessState> {
  const host = options.host ?? DEFAULT_PROXY_HOST;
  const port = options.port ?? resolveProxyPort();
  const processState = await options.proxyProcessManager.startDetached({
    host,
    port,
    debug: options.debug,
  });
  const enabledState = await writeSyntheticProxyRuntime({
    store: options.store,
    state: processState,
  });
  await writeProxyState(options.store.paths.codexTeamDir, enabledState);
  await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
    component: "proxy",
    event: "proxy.enable.completed",
    trigger: "cli",
    fields: {
      host,
      port,
      base_url: enabledState.base_url,
      openai_base_url: enabledState.openai_base_url,
      pid: enabledState.pid,
    },
  }));
  return enabledState;
}

export async function disableProxyMode(options: {
  store: AccountStore;
  proxyProcessManager: ProxyProcessManager;
}): Promise<{
  state: ProxyProcessState | null;
  restored: { auth_restored: boolean; config_restored: boolean };
  stopped: { running: boolean; state: ProxyProcessState | null; stopped: boolean };
}> {
  const state = await readProxyState(options.store.paths.codexTeamDir);
  const restored = await restoreDirectRuntime({
    store: options.store,
    state,
  });
  const stopped = await options.proxyProcessManager.disable();
  await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
    component: "proxy",
    event: "proxy.disable.completed",
    trigger: "cli",
    fields: {
      pid: stopped.state?.pid ?? null,
      auth_restored: restored.auth_restored,
      config_restored: restored.config_restored,
      stopped: stopped.stopped,
    },
  }));
  return {
    state,
    restored,
    stopped,
  };
}

export async function handleProxyCommand(options: {
  store: AccountStore;
  positionals: string[];
  optionValues: Map<string, string>;
  flags: Set<string>;
  stdout: NodeJS.WriteStream;
  debug: boolean;
  json: boolean;
  proxyProcessManager: ProxyProcessManager;
  debugLog?: DebugLogger;
}): Promise<number> {
  const subcommand = options.positionals[0];
  if (!subcommand) {
    throw new Error(`Usage: ${getUsage("proxy")}`);
  }

  if (subcommand === "serve") {
    const host = options.optionValues.get("--host") ?? DEFAULT_PROXY_HOST;
    const port = resolveProxyPort({
      cliValue: options.optionValues.get("--port"),
    });
    const server = await startProxyServer({
      store: options.store,
      host,
      port,
      debugLog: options.debugLog,
      requestLogger: async (payload) => {
        await appendProxyRequestLog(options.store.paths.codexTeamDir, payload);
      },
    });
    options.stdout.write(
      `codexm proxy serving ChatGPT at ${server.backendBaseUrl} and OpenAI API at ${server.openaiBaseUrl}\n`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        void server.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }

  if (subcommand === "enable") {
    const host = options.optionValues.get("--host") ?? DEFAULT_PROXY_HOST;
    const port = resolveProxyPort({
      cliValue: options.optionValues.get("--port"),
    });
    const plan = resolveStateForPlan(host, port);

    if (options.flags.has("--dry-run")) {
      const payload = {
        ok: true,
        action: "proxy.enable",
        dry_run: true,
        enabled: true,
        running: false,
        base_url: plan.base_url,
        openai_base_url: plan.openai_base_url,
      };
      if (options.json) {
        writeJson(options.stdout, payload);
      } else {
        options.stdout.write(
          `Would enable proxy with ChatGPT base URL ${plan.base_url} and OpenAI base URL ${plan.openai_base_url}.\n`,
        );
      }
      return 0;
    }

    let enabledState: ProxyProcessState;
    try {
      enabledState = await enableProxyMode({
        store: options.store,
        proxyProcessManager: options.proxyProcessManager,
        host,
        port,
        debug: options.debug,
      });
    } catch (error) {
      await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
        component: "proxy",
        event: "proxy.enable.failed",
        trigger: "cli",
        level: "error",
        errorMessageShort: shortenErrorMessage((error as Error).message),
        fields: { host, port },
      }));
      throw error;
    }
    const payload = {
      ok: true,
      action: "proxy.enable",
      enabled: true,
      running: true,
      pid: enabledState.pid,
      base_url: enabledState.base_url,
      openai_base_url: enabledState.openai_base_url,
      log_path: enabledState.log_path,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(`Proxy enabled: ${enabledState.base_url}\n`);
      options.stdout.write(`OpenAI API: ${enabledState.openai_base_url}\n`);
    }
    return 0;
  }

  if (subcommand === "disable") {
    const { restored, stopped } = await disableProxyMode({
      store: options.store,
      proxyProcessManager: options.proxyProcessManager,
    });
    const payload = {
      ok: true,
      action: "proxy.disable",
      enabled: false,
      stopped: stopped.stopped,
      auth_restored: restored.auth_restored,
      config_restored: restored.config_restored,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write("Proxy disabled. Restored previous direct auth/config and removed proxy config when possible.\n");
    }
    return 0;
  }

  if (subcommand === "status") {
    const [state, processStatus] = await Promise.all([
      readProxyState(options.store.paths.codexTeamDir),
      options.proxyProcessManager.getStatus(),
    ]);
    const effectiveState = processStatus.state ?? state;
    const payload = {
      ok: true,
      action: "proxy.status",
      enabled: effectiveState?.enabled === true,
      running: processStatus.running,
      state: effectiveState,
      base_url: effectiveState?.base_url ?? null,
      openai_base_url: effectiveState?.openai_base_url ?? null,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(`${describeStatus({
        enabled: payload.enabled,
        running: payload.running,
        state: effectiveState,
      })}\n`);
    }
    return 0;
  }

  if (subcommand === "stop") {
    const stopped = await options.proxyProcessManager.stop();
    const state = await readProxyState(options.store.paths.codexTeamDir);
    if (state) {
      await writeProxyState(options.store.paths.codexTeamDir, {
        ...state,
        pid: 0,
      });
    }
    const payload = {
      ok: true,
      action: "proxy.stop",
      running: false,
      stopped: stopped.stopped,
      state: stopped.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(stopped.stopped ? "Proxy daemon stopped.\n" : "Proxy daemon was not running.\n");
    }
    return 0;
  }

  throw new Error(`Usage: ${getUsage("proxy")}`);
}
