import type { AccountStore } from "../account-store/index.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import type { DaemonProcessManager } from "../daemon/process.js";
import { defaultDaemonState } from "../daemon/state.js";
import { appendEventLog, buildEventPayload } from "../logging.js";
import { proxyBackendBaseUrl, proxyOpenAIBaseUrl, resolveProxyPort } from "../proxy/constants.js";

function describeStatus(status: {
  enabled: boolean;
  running: boolean;
  pid: number | null;
  logPath: string | null;
}): string {
  const lines = [
    `Autoswitch: ${status.enabled ? "enabled" : "disabled"}`,
    `Daemon: ${status.running ? `running (pid ${status.pid ?? "-"})` : "stopped"}`,
  ];
  if (status.logPath) {
    lines.push(`Log: ${status.logPath}`);
  }
  return lines.join("\n");
}

export async function readAutoswitchStatus(options: {
  daemonProcessManager: DaemonProcessManager;
}): Promise<{
  enabled: boolean;
  running: boolean;
  state: Awaited<ReturnType<DaemonProcessManager["getStatus"]>>["state"];
}> {
  const status = await options.daemonProcessManager.getStatus();
  return {
    enabled: Boolean(status.running && status.state?.auto_switch),
    running: status.running,
    state: status.state,
  };
}

export async function enableAutoswitchMode(options: {
  store: AccountStore;
  daemonProcessManager: DaemonProcessManager;
  debug: boolean;
}): Promise<Awaited<ReturnType<DaemonProcessManager["ensureConfig"]>>> {
  const currentState = (await options.daemonProcessManager.getStatus()).state
    ?? defaultDaemonState(options.store.paths.codexTeamDir);
  const host = currentState.host;
  const port = resolveProxyPort({
    env: process.env,
    fallback: currentState.port,
  });
  const result = await options.daemonProcessManager.ensureConfig({
    stayalive: true,
    watch: true,
    auto_switch: true,
    proxy: currentState.proxy,
    host,
    port,
    debug: currentState.debug || options.debug,
    base_url: proxyBackendBaseUrl(host, port),
    openai_base_url: proxyOpenAIBaseUrl(host, port),
  });
  await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
    component: "watch",
    event: "daemon.feature_state_changed",
    trigger: "cli",
    fields: {
      feature: "autoswitch",
      enabled: true,
      action: result.action,
    },
  }));
  return result;
}

export async function disableAutoswitchMode(options: {
  store: AccountStore;
  daemonProcessManager: DaemonProcessManager;
}): Promise<Awaited<ReturnType<DaemonProcessManager["ensureConfig"]>> | null> {
  const status = await options.daemonProcessManager.getStatus();
  if (!status.state) {
    return null;
  }

  const result = await options.daemonProcessManager.ensureConfig({
    stayalive: true,
    watch: false,
    auto_switch: false,
    proxy: status.state.proxy,
    host: status.state.host,
    port: status.state.port,
    debug: status.state.debug,
    base_url: status.state.base_url,
    openai_base_url: status.state.openai_base_url,
  });
  await appendEventLog(options.store.paths.codexTeamDir, buildEventPayload({
    component: "watch",
    event: "daemon.feature_state_changed",
    trigger: "cli",
    fields: {
      feature: "autoswitch",
      enabled: false,
      action: result.action,
    },
  }));
  return result;
}

export async function handleAutoswitchCommand(options: {
  store: AccountStore;
  positionals: string[];
  daemonProcessManager: DaemonProcessManager;
  stdout: NodeJS.WriteStream;
  debug: boolean;
  json: boolean;
}): Promise<number> {
  const subcommand = options.positionals[0];
  if (!subcommand) {
    throw new Error(`Usage: ${getUsage("autoswitch")}`);
  }

  if (subcommand === "status") {
    const status = await readAutoswitchStatus({
      daemonProcessManager: options.daemonProcessManager,
    });
    const payload = {
      ok: true,
      action: "autoswitch.status",
      enabled: status.enabled,
      running: status.running,
      state: status.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write(`${describeStatus({
        enabled: status.enabled,
        running: status.running,
        pid: status.state?.pid ?? null,
        logPath: status.state?.log_path ?? null,
      })}\n`);
    }
    return 0;
  }

  if (subcommand === "enable") {
    const result = await enableAutoswitchMode({
      store: options.store,
      daemonProcessManager: options.daemonProcessManager,
      debug: options.debug,
    });
    const payload = {
      ok: true,
      action: "autoswitch.enable",
      enabled: true,
      result: result.action,
      state: result.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      const verb = result.action === "reused"
        ? "Autoswitch already enabled"
        : result.action === "restarted"
          ? "Restarted daemon with autoswitch enabled"
          : "Enabled autoswitch";
      options.stdout.write(`${verb}.\n`);
    }
    return 0;
  }

  if (subcommand === "disable") {
    const result = await disableAutoswitchMode({
      store: options.store,
      daemonProcessManager: options.daemonProcessManager,
    });
    if (!result) {
      if (options.json) {
        writeJson(options.stdout, {
          ok: true,
          action: "autoswitch.disable",
          enabled: false,
          running: false,
          state: null,
        });
      } else {
        options.stdout.write("Autoswitch already disabled.\n");
      }
      return 0;
    }
    const payload = {
      ok: true,
      action: "autoswitch.disable",
      enabled: false,
      result: result.action,
      state: result.state,
    };
    if (options.json) {
      writeJson(options.stdout, payload);
    } else {
      options.stdout.write("Disabled autoswitch.\n");
    }
    return 0;
  }

  throw new Error(`Usage: ${getUsage("autoswitch")}`);
}
