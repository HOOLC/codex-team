import type { AccountStore } from "../account-store/index.js";
import type { CodexDesktopLauncher } from "../desktop/launcher.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import { AUTH_REFRESH_SWEEP_INTERVAL_MS, runAuthRefreshSweep } from "../auth-refresh.js";
import { startProxyServer } from "../proxy/server.js";
import {
  DEFAULT_PROXY_HOST,
  proxyBackendBaseUrl,
  proxyOpenAIBaseUrl,
  resolveProxyPort,
} from "../proxy/constants.js";
import { ensureSyntheticProxyRuntimeActive } from "../proxy/runtime.js";
import type { DaemonProcessManager } from "../daemon/process.js";
import {
  appendEventLog,
  appendProxyErrorLog,
  appendProxyRequestLog,
  buildEventPayload,
  shortenErrorMessage,
} from "../logging.js";
import { drainDaemonRequests } from "../daemon/requests.js";
import { defaultDaemonState } from "../daemon/state.js";
import { runManagedDesktopWatchSession } from "../watch/session.js";
import { refreshManagedDesktopAfterSwitch } from "../switching.js";

type DebugLogger = (message: string) => void;

interface CliStreams {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

function describeDaemonStatus(status: {
  running: boolean;
  state: Awaited<ReturnType<DaemonProcessManager["getStatus"]>>["state"];
}): string {
  const state = status.state;
  if (!state) {
    return "Daemon: not running";
  }

  const features = [
    state.stayalive ? "stayalive" : null,
    state.auto_switch ? "autoswitch" : null,
    state.proxy ? "proxy" : null,
  ].filter((value): value is string => value !== null);
  const lines = [
    `Daemon: ${status.running ? `running (pid ${state.pid})` : "stopped"}`,
    `Features: ${features.length > 0 ? features.join(", ") : "none"}`,
    `Log: ${state.log_path}`,
  ];
  if (state.proxy) {
    lines.push(`ChatGPT base URL: ${state.base_url}`);
    lines.push(`OpenAI base URL: ${state.openai_base_url}`);
  }
  return lines.join("\n");
}

async function appendAuthRefreshEvent(
  codexTeamDir: string,
  event:
    | { type: "start"; account: string; reason: string; expires_at: string | null }
    | { type: "complete"; account: string; expires_at: string | null }
    | { type: "failed"; account: string; error: string }
    | { type: "skipped"; account: string; reason: string; expires_at: string | null },
  trigger: "daemon" | "cli",
): Promise<void> {
  if (event.type === "skipped") {
    return;
  }

  await appendEventLog(codexTeamDir, buildEventPayload({
    component: "auth",
    event: event.type === "start"
      ? "auth.refresh.started"
      : event.type === "complete"
        ? "auth.refresh.completed"
        : "auth.refresh.failed",
    trigger,
    level: event.type === "failed" ? "error" : "info",
    fields: {
      account_name: event.account,
      ...(event.type === "start"
        ? { reason: event.reason, expires_at: event.expires_at }
        : event.type === "complete"
          ? { expires_at: event.expires_at }
          : { error: event.error }),
    },
  }));
}

async function runLoggedAuthRefreshSweep(options: {
  store: AccountStore;
  debugLog?: DebugLogger;
  signal?: AbortSignal;
  trigger: "daemon" | "cli";
}): Promise<Awaited<ReturnType<typeof runAuthRefreshSweep>>> {
  const codexTeamDir = options.store.paths.codexTeamDir;
  return await runAuthRefreshSweep({
    store: options.store,
    signal: options.signal,
    debugLog: options.debugLog,
    onEvent: async (event) => {
      await appendAuthRefreshEvent(codexTeamDir, event, options.trigger);
    },
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runDaemonProxyRuntimeLoop(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  signal: AbortSignal;
  debugLog: DebugLogger;
  intervalMs?: number;
}): Promise<void> {
  const intervalMs = options.intervalMs ?? 5_000;

  while (!options.signal.aborted) {
    try {
      const result = await ensureSyntheticProxyRuntimeActive(options.store);
      if (result.restored) {
        options.debugLog(
          `daemon: restored synthetic proxy runtime auth_was_synthetic=${result.authWasSynthetic} config_was_synthetic=${result.configWasSynthetic}`,
        );
        await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
          component: "proxy",
          event: "proxy.runtime.reapplied",
          trigger: "daemon",
          fields: {
            auth_was_synthetic: result.authWasSynthetic,
            config_was_synthetic: result.configWasSynthetic,
          },
        }));
        const warnings: string[] = [];
        await refreshManagedDesktopAfterSwitch(warnings, options.desktopLauncher, {
          signal: options.signal,
        });
        if (warnings.length > 0) {
          await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
            component: "proxy",
            event: "proxy.runtime.reapplied.desktop_warning",
            trigger: "daemon",
            level: "warn",
            fields: {
              warnings,
            },
          }));
        }
      }
    } catch (error) {
      await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
        component: "proxy",
        event: "proxy.runtime.reapply_failed",
        trigger: "daemon",
        level: "error",
        errorMessageShort: shortenErrorMessage((error as Error).message),
      }));
    }

    if (options.signal.aborted) {
      return;
    }
    await delay(intervalMs, options.signal);
  }
}

function buildDaemonStartConfig(options: {
  currentState: Awaited<ReturnType<DaemonProcessManager["getStatus"]>>["state"];
  codexTeamDir: string;
  portOverride?: string;
  debug: boolean;
}) {
  const currentState = options.currentState ?? defaultDaemonState(options.codexTeamDir);
  const host = currentState.host;
  const port = resolveProxyPort({
    env: process.env,
    cliValue: options.portOverride,
    fallback: currentState.port,
  });

  return {
    stayalive: true,
    watch: currentState.watch,
    auto_switch: currentState.watch ? currentState.auto_switch : false,
    proxy: currentState.proxy,
    host,
    port,
    debug: currentState.debug || options.debug,
    base_url: proxyBackendBaseUrl(host, port),
    openai_base_url: proxyOpenAIBaseUrl(host, port),
  };
}

async function runDaemonWatchLoop(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  streams: CliStreams;
  signal: AbortSignal;
  autoSwitch: boolean;
  debug: boolean;
  debugLog: DebugLogger;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
  watchQuotaMinReadIntervalMs: number;
  watchQuotaIdleReadIntervalMs: number;
}): Promise<void> {
  while (!options.signal.aborted) {
    let managedDesktopRunning = false;
    try {
      managedDesktopRunning = await options.desktopLauncher.isManagedDesktopRunning();
    } catch (error) {
      options.debugLog(`daemon: failed to inspect managed Desktop status: ${(error as Error).message}`);
    }

    if (!managedDesktopRunning) {
      await delay(15_000, options.signal);
      continue;
    }

    const exitCode = await runManagedDesktopWatchSession({
      store: options.store,
      desktopLauncher: options.desktopLauncher,
      streams: options.streams,
      interruptSignal: options.signal,
      autoSwitch: options.autoSwitch,
      debug: options.debug,
      debugLog: options.debugLog,
      managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
      managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
      watchQuotaMinReadIntervalMs: options.watchQuotaMinReadIntervalMs,
      watchQuotaIdleReadIntervalMs: options.watchQuotaIdleReadIntervalMs,
      onAutoSwitchEvent: async (event) => {
        await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
          component: "watch",
          event: event.type === "switched" ? "account.autoswitch.selected" : "account.autoswitch.skipped",
          trigger: "daemon",
          fields: event.type === "switched"
            ? {
                from_account: event.fromAccount,
                to_account: event.toAccount,
                warnings: event.warnings,
              }
            : {
                account: event.account,
                reason: event.reason,
              },
        }));
      },
    });

    if (options.signal.aborted) {
      return;
    }

    if (exitCode !== 0) {
      await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
        component: "watch",
        event: "daemon.feature_state_changed",
        trigger: "daemon",
        level: "warn",
        fields: {
          feature: "watch",
          exit_code: exitCode,
        },
      }));
    }
    await delay(5_000, options.signal);
  }
}

async function runDaemonRequestLoop(options: {
  store: AccountStore;
  signal: AbortSignal;
  debugLog: DebugLogger;
  runAuthRefreshSweepOnce: () => Promise<void>;
}): Promise<void> {
  while (!options.signal.aborted) {
    const requests = await drainDaemonRequests(options.store.paths.codexTeamDir);
    if (requests.some((request) => request.type === "auth-refresh-now")) {
      await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
        component: "auth",
        event: "daemon.feature_state_changed",
        trigger: "daemon",
        fields: {
          feature: "stayalive",
          request_count: requests.length,
          requested_sources: requests.map((request) => request.source),
        },
      }));
      await options.runAuthRefreshSweepOnce();
    }

    if (options.signal.aborted) {
      return;
    }
    await delay(1_000, options.signal);
  }
}

async function runDaemonAuthRefreshLoop(options: {
  signal: AbortSignal;
  intervalMs?: number;
  runAuthRefreshSweepOnce: () => Promise<void>;
}): Promise<void> {
  const intervalMs = options.intervalMs ?? AUTH_REFRESH_SWEEP_INTERVAL_MS;

  while (!options.signal.aborted) {
    await options.runAuthRefreshSweepOnce();
    if (options.signal.aborted) {
      return;
    }
    await delay(intervalMs, options.signal);
  }
}

async function runDaemonService(options: {
  store: AccountStore;
  desktopLauncher: CodexDesktopLauncher;
  streams: CliStreams;
  debug: boolean;
  debugLog?: DebugLogger;
  stayalive: boolean;
  watch: boolean;
  autoSwitch: boolean;
  proxy: boolean;
  host: string;
  port: number;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
  watchQuotaMinReadIntervalMs: number;
  watchQuotaIdleReadIntervalMs: number;
}): Promise<number> {
  const controller = new AbortController();
  const signal = controller.signal;
  const debugLog = options.debugLog ?? (() => undefined);
  const cleanupTasks: Array<() => Promise<void>> = [];
  const backgroundTasks: Promise<void>[] = [];
  const codexTeamDir = options.store.paths.codexTeamDir;

  const stop = () => {
    controller.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    let authRefreshInFlight: Promise<void> | null = null;
    const runSerializedAuthRefreshSweep = async () => {
      if (authRefreshInFlight) {
        await authRefreshInFlight;
        return;
      }

      authRefreshInFlight = (async () => {
        await runLoggedAuthRefreshSweep({
          store: options.store,
          signal,
          debugLog,
          trigger: "daemon",
        });
      })().finally(() => {
        authRefreshInFlight = null;
      });
      await authRefreshInFlight;
    };

    if (options.proxy) {
      const server = await startProxyServer({
        store: options.store,
        host: options.host,
        port: options.port,
        debugLog,
        requestLogger: async (payload) => {
          await appendProxyRequestLog(codexTeamDir, payload);
        },
        errorRequestLogger: async (payload) => {
          await appendProxyErrorLog(codexTeamDir, payload);
        },
      });
      cleanupTasks.push(async () => {
        await server.close();
      });
      await appendEventLog(codexTeamDir, buildEventPayload({
        component: "proxy",
        event: "proxy.bind.ready",
        trigger: "daemon",
        fields: {
          host: options.host,
          port: options.port,
          base_url: server.backendBaseUrl,
          openai_base_url: server.openaiBaseUrl,
        },
      }));
      backgroundTasks.push(runDaemonProxyRuntimeLoop({
        store: options.store,
        desktopLauncher: options.desktopLauncher,
        signal,
        debugLog,
      }));
    }

    if (options.stayalive) {
      backgroundTasks.push(runDaemonAuthRefreshLoop({
        signal,
        runAuthRefreshSweepOnce: runSerializedAuthRefreshSweep,
      }));
      backgroundTasks.push(runDaemonRequestLoop({
        store: options.store,
        signal,
        debugLog,
        runAuthRefreshSweepOnce: runSerializedAuthRefreshSweep,
      }));
    }

    if (options.watch) {
      backgroundTasks.push(runDaemonWatchLoop({
        store: options.store,
        desktopLauncher: options.desktopLauncher,
        streams: options.streams,
        signal,
        autoSwitch: options.autoSwitch,
        debug: options.debug,
        debugLog,
        managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
        managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
        watchQuotaMinReadIntervalMs: options.watchQuotaMinReadIntervalMs,
        watchQuotaIdleReadIntervalMs: options.watchQuotaIdleReadIntervalMs,
      }));
    }

    const abortPromise = new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (backgroundTasks.length === 0) {
      await abortPromise;
      return 0;
    }

    await Promise.race([Promise.all(backgroundTasks), abortPromise]);
    return 0;
  } catch (error) {
    await appendEventLog(codexTeamDir, buildEventPayload({
      component: "daemon",
      event: "daemon.crash",
      trigger: "daemon",
      level: "error",
      errorMessageShort: shortenErrorMessage((error as Error).message),
    }));
    throw error;
  } finally {
    controller.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    for (const cleanup of cleanupTasks.reverse()) {
      try {
        await cleanup();
      } catch {
        // Best-effort shutdown.
      }
    }
  }
}

export async function handleDaemonCommand(options: {
  store: AccountStore;
  positionals: string[];
  optionValues: Map<string, string>;
  stdout: NodeJS.WriteStream;
  debug: boolean;
  json: boolean;
  daemonProcessManager: DaemonProcessManager;
  desktopLauncher: CodexDesktopLauncher;
  streams: CliStreams;
  debugLog?: DebugLogger;
  managedDesktopWaitStatusDelayMs: number;
  managedDesktopWaitStatusIntervalMs: number;
  watchQuotaMinReadIntervalMs: number;
  watchQuotaIdleReadIntervalMs: number;
}): Promise<number> {
  const subcommand = options.positionals[0];
  if (!subcommand) {
    throw new Error(`Usage: ${getUsage("daemon")}`);
  }

  if (subcommand === "status") {
    const status = await options.daemonProcessManager.getStatus();
    const payload = {
      ok: true,
      action: "daemon.status",
      running: status.running,
      state: status.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(`${describeDaemonStatus(status)}\n`);
    }
    return 0;
  }

  if (subcommand === "start") {
    const currentState = (await options.daemonProcessManager.getStatus()).state;
    const result = await options.daemonProcessManager.ensureConfig(buildDaemonStartConfig({
      currentState,
      codexTeamDir: options.store.paths.codexTeamDir,
      portOverride: options.optionValues.get("--port"),
      debug: options.debug,
    }));
    const payload = {
      ok: true,
      action: "daemon.start",
      result: result.action,
      running: true,
      state: result.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      const verb = result.action === "reused"
        ? "Daemon already running"
        : result.action === "restarted"
          ? "Restarted daemon"
          : "Started daemon";
      options.stdout.write(`${verb} (pid ${result.state.pid}).\n`);
    }
    return 0;
  }

  if (subcommand === "restart") {
    const status = await options.daemonProcessManager.getStatus();
    if (status.running) {
      await options.daemonProcessManager.stop();
    }
    const result = await options.daemonProcessManager.ensureConfig(buildDaemonStartConfig({
      currentState: status.state,
      codexTeamDir: options.store.paths.codexTeamDir,
      portOverride: options.optionValues.get("--port"),
      debug: options.debug,
    }));
    const payload = {
      ok: true,
      action: "daemon.restart",
      result: result.action,
      running: true,
      state: result.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      const verb = result.action === "reused"
        ? "Daemon already running"
        : result.action === "started"
          ? "Started daemon"
          : "Restarted daemon";
      options.stdout.write(`${verb} (pid ${result.state.pid}).\n`);
    }
    return 0;
  }

  if (subcommand === "stop") {
    const result = await options.daemonProcessManager.stop();
    const payload = {
      ok: true,
      action: "daemon.stop",
      stopped: result.stopped,
      state: result.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(
        result.stopped && result.state
          ? `Stopped daemon (pid ${result.state.pid}).\n`
          : "Daemon: not running\n",
      );
    }
    return 0;
  }

  if (subcommand === "refresh-auth-once") {
    const result = await runLoggedAuthRefreshSweep({
      store: options.store,
      debugLog: options.debugLog,
      trigger: "cli",
    });
    if (options.json) {
      writeJson(options.stdout, {
        ok: true,
        action: "daemon.refresh-auth-once",
        ...result,
      });
    }
    return result.failed.length === 0 ? 0 : 1;
  }

  if (subcommand === "serve") {
    const features = new Set(options.positionals.slice(1));
    const host = options.optionValues.get("--host") ?? DEFAULT_PROXY_HOST;
    const port = resolveProxyPort({
      cliValue: options.optionValues.get("--port"),
    });
    return await runDaemonService({
      store: options.store,
      desktopLauncher: options.desktopLauncher,
      streams: options.streams,
      debug: options.debug,
      debugLog: options.debugLog,
      stayalive: features.has("stayalive"),
      watch: features.has("watch"),
      autoSwitch: features.has("auto-switch"),
      proxy: features.has("proxy"),
      host,
      port,
      managedDesktopWaitStatusDelayMs: options.managedDesktopWaitStatusDelayMs,
      managedDesktopWaitStatusIntervalMs: options.managedDesktopWaitStatusIntervalMs,
      watchQuotaMinReadIntervalMs: options.watchQuotaMinReadIntervalMs,
      watchQuotaIdleReadIntervalMs: options.watchQuotaIdleReadIntervalMs,
    });
  }

  throw new Error(`Usage: ${getUsage("daemon")}`);
}
