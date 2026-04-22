import type { AccountStore } from "../account-store/index.js";
import type { CodexDesktopLauncher } from "../desktop/launcher.js";
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
import { readProxyState, writeProxyState, type ProxyProcessState, type ProxyStatus } from "../proxy/state.js";
import {
  appendEventLog,
  appendProxyErrorLog,
  appendProxyRequestLog,
  buildEventPayload,
  shortenErrorMessage,
} from "../logging.js";
import {
  describeBusySwitchLock,
  refreshManagedDesktopAfterSwitch,
  tryAcquireSwitchLock,
} from "../switching.js";

type DebugLogger = (message: string) => void;

const PROXY_FORCE_WARNING =
  "Warning: --force is only meaningful with a managed Desktop session.";

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
  listener: ProxyStatus;
}> {
  const state = await readProxyState(options.store.paths.codexTeamDir);
  const restored = await restoreDirectRuntime({
    store: options.store,
    state,
  });
  const listener = await options.proxyProcessManager.getStatus();
  const disabledState = listener.state ?? state;
  if (disabledState) {
    await writeProxyState(options.store.paths.codexTeamDir, {
      ...disabledState,
      pid: listener.running ? disabledState.pid : 0,
      enabled: false,
    });
  }
  await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
    component: "proxy",
    event: "proxy.disable.completed",
    trigger: "cli",
    fields: {
      pid: listener.state?.pid ?? null,
      auth_restored: restored.auth_restored,
      config_restored: restored.config_restored,
      daemon_running: listener.running,
    },
  }));
  return {
    state,
    restored,
    listener,
  };
}

export async function enableProxyModeWithDesktopRefresh(options: {
  store: AccountStore;
  proxyProcessManager: ProxyProcessManager;
  desktopLauncher: CodexDesktopLauncher;
  force: boolean;
  debug: boolean;
  host?: string;
  port?: number;
  signal?: AbortSignal;
  statusStream?: NodeJS.WriteStream;
  onStatusMessage?: (message: string) => void;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
}): Promise<{
  state: ProxyProcessState;
  warnings: string[];
  desktopForceWarning: string | null;
}> {
  const warnings: string[] = [];
  const state = await enableProxyMode({
    store: options.store,
    proxyProcessManager: options.proxyProcessManager,
    host: options.host,
    port: options.port,
    debug: options.debug,
  });
  const refreshOutcome = await refreshManagedDesktopAfterSwitch(
    warnings,
    options.desktopLauncher,
    {
      force: options.force,
      desiredDesktopApiBaseUrl: state.base_url,
      signal: options.signal,
      statusStream: options.statusStream,
      onStatusMessage: options.onStatusMessage,
      statusDelayMs: options.managedDesktopWaitStatusDelayMs,
      statusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
    },
  );

  return {
    state,
    warnings,
    desktopForceWarning: options.force && refreshOutcome === "none"
      ? PROXY_FORCE_WARNING
      : null,
  };
}

export async function disableProxyModeWithDesktopRefresh(options: {
  store: AccountStore;
  proxyProcessManager: ProxyProcessManager;
  desktopLauncher: CodexDesktopLauncher;
  force: boolean;
  signal?: AbortSignal;
  statusStream?: NodeJS.WriteStream;
  onStatusMessage?: (message: string) => void;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
}): Promise<{
  restored: { auth_restored: boolean; config_restored: boolean };
  listener: ProxyStatus;
  warnings: string[];
  desktopForceWarning: string | null;
}> {
  const warnings: string[] = [];
  const { restored, listener } = await disableProxyMode({
    store: options.store,
    proxyProcessManager: options.proxyProcessManager,
  });
  const refreshOutcome = await refreshManagedDesktopAfterSwitch(
    warnings,
    options.desktopLauncher,
    {
      force: options.force,
      desiredDesktopApiBaseUrl: null,
      signal: options.signal,
      statusStream: options.statusStream,
      onStatusMessage: options.onStatusMessage,
      statusDelayMs: options.managedDesktopWaitStatusDelayMs,
      statusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
    },
  );

  return {
    restored,
    listener,
    warnings,
    desktopForceWarning: options.force && refreshOutcome === "none"
      ? PROXY_FORCE_WARNING
      : null,
  };
}

export async function handleProxyCommand(options: {
  store: AccountStore;
  positionals: string[];
  optionValues: Map<string, string>;
  flags: Set<string>;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  debug: boolean;
  json: boolean;
  proxyProcessManager: ProxyProcessManager;
  desktopLauncher: CodexDesktopLauncher;
  interruptSignal?: AbortSignal;
  debugLog?: DebugLogger;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
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
      errorRequestLogger: async (payload) => {
        await appendProxyErrorLog(options.store.paths.codexTeamDir, payload);
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
    const force = options.flags.has("--force");
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

    const lock = await tryAcquireSwitchLock(options.store, "proxy enable");
    if (!lock.acquired) {
      throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
    }

    let enabledState: ProxyProcessState;
    let warnings: string[] = [];
    let desktopForceWarning: string | null = null;
    try {
      const enabled = await enableProxyModeWithDesktopRefresh({
        store: options.store,
        proxyProcessManager: options.proxyProcessManager,
        desktopLauncher: options.desktopLauncher,
        force,
        host,
        port,
        debug: options.debug,
        signal: options.interruptSignal,
        statusStream: options.stderr,
        managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
        managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
      });
      enabledState = enabled.state;
      warnings = enabled.warnings;
      desktopForceWarning = enabled.desktopForceWarning;
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
    } finally {
      await lock.release();
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
      warnings,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(`Proxy enabled: ${enabledState.base_url}\n`);
      options.stdout.write(`OpenAI API: ${enabledState.openai_base_url}\n`);
      for (const warning of warnings) {
        options.stdout.write(`Warning: ${warning}\n`);
      }
    }
    if (desktopForceWarning) {
      options.stderr.write(`${desktopForceWarning}\n`);
    }
    return 0;
  }

  if (subcommand === "disable") {
    const force = options.flags.has("--force");
    const lock = await tryAcquireSwitchLock(options.store, "proxy disable");
    if (!lock.acquired) {
      throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
    }

    let restored: { auth_restored: boolean; config_restored: boolean };
    let listener: ProxyStatus;
    let warnings: string[] = [];
    let desktopForceWarning: string | null = null;
    try {
      const disabled = await disableProxyModeWithDesktopRefresh({
        store: options.store,
        proxyProcessManager: options.proxyProcessManager,
        desktopLauncher: options.desktopLauncher,
        force,
        signal: options.interruptSignal,
        statusStream: options.stderr,
        managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
        managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
      });
      restored = disabled.restored;
      listener = disabled.listener;
      warnings = disabled.warnings;
      desktopForceWarning = disabled.desktopForceWarning;
    } finally {
      await lock.release();
    }
    const payload = {
      ok: true,
      action: "proxy.disable",
      enabled: false,
      running: listener.running,
      base_url: listener.state?.base_url ?? null,
      openai_base_url: listener.state?.openai_base_url ?? null,
      auth_restored: restored.auth_restored,
      config_restored: restored.config_restored,
      warnings,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(
        "Proxy disabled for the local runtime. Restored previous direct auth/config and removed proxy config when possible.\n",
      );
      if (listener.running && listener.state) {
        options.stdout.write(`Proxy daemon is still listening at ${listener.state.base_url}.\n`);
      }
      for (const warning of warnings) {
        options.stdout.write(`Warning: ${warning}\n`);
      }
    }
    if (desktopForceWarning) {
      options.stderr.write(`${desktopForceWarning}\n`);
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
