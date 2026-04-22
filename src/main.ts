import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from "node:process";
import packageJson from "../package.json";

import {
  maskAccountId,
} from "./auth-snapshot.js";
import {
  AccountStore,
  createAccountStore,
  ensureAccountName,
} from "./account-store/index.js";
import { type CodexDesktopLauncher } from "./desktop/launcher.js";
import {
  createWatchProcessManager,
  type WatchProcessManager,
} from "./watch/process.js";
import {
  createDaemonProcessManager,
  type DaemonProcessManager,
} from "./daemon/process.js";
import {
  createProxyProcessManager,
  type ProxyProcessManager,
} from "./proxy/process.js";
import { readProxyState } from "./proxy/state.js";
import { DEFAULT_PROXY_HOST, PROXY_ACCOUNT_NAME, resolveProxyPort } from "./proxy/constants.js";
import {
  createCodexLoginProvider,
  type CodexLoginProvider,
} from "./codex-login.js";
import {
  CliUsageError,
  parseArgs,
  type ParsedArgs,
  validateParsedArgs,
} from "./cli/args.js";
import {
  printHelp,
} from "./cli/help.js";
import { getUsage } from "./cli/spec.js";
import {
  describeAutoSwitchNoop,
  describeAutoSwitchSelection,
  toCliQuotaSummary,
} from "./cli/quota.js";
import { writeJson } from "./cli/output.js";
import {
  handleAddCommand,
  handleProtectCommand,
  handleRemoveCommand,
  handleRenameCommand,
  handleSaveCommand,
  handleUnprotectCommand,
  handleUpdateCommand,
} from "./commands/account-management.js";
import {
  handleExportCommand,
  handleImportCommand,
  handleInspectBundleCommand,
} from "./commands/share-bundle.js";
import { handleCompletionCommand } from "./commands/completion.js";
import {
  handleCurrentCommand,
  handleDoctorCommand,
  handleListCommand,
} from "./commands/inspection.js";
import { handleAutoswitchCommand } from "./commands/autoswitch.js";
import { handleUsageCommand } from "./commands/usage.js";
import { performManualSwitch } from "./commands/switch.js";
import { handleTuiCommand } from "./commands/tui.js";
import {
  handleLaunchCommand,
  handleWatchCommand,
} from "./commands/desktop.js";
import { handleOverlayCommand } from "./commands/overlay.js";
import {
  describeBusySwitchLock,
  performAutoSwitch,
  tryAcquireSwitchLock,
} from "./switching.js";

import {
  type RunnerResult,
  runCodexWithAutoRestart,
} from "./codex-cli-runner.js";
import {
  startIsolatedQuotaHistorySampler,
} from "./run/isolated-runtime.js";
import {
  runDirectCodexSession,
  runIsolatedAccountCodexSession,
  runIsolatedProxyCodexSession,
} from "./run/codex-session.js";
import {
  createPlatformDesktopLauncher,
} from "./platform-desktop-adapter.js";
import { handleProxyCommand } from "./commands/proxy.js";
import { handleDaemonCommand } from "./commands/daemon.js";
export { rankAutoSwitchCandidates } from "./cli/quota.js";

interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

interface RunCliOptions extends Partial<CliStreams> {
  store?: AccountStore;
  desktopLauncher?: CodexDesktopLauncher;
  authLogin?: CodexLoginProvider;
  daemonProcessManager?: DaemonProcessManager;
  watchProcessManager?: WatchProcessManager;
  proxyProcessManager?: ProxyProcessManager;
  runCodexCli?: (options: Parameters<typeof runCodexWithAutoRestart>[0]) => Promise<RunnerResult>;
  interruptSignal?: AbortSignal;
  managedDesktopWaitStatusDelayMs?: number;
  managedDesktopWaitStatusIntervalMs?: number;
  watchQuotaMinReadIntervalMs?: number;
  watchQuotaIdleReadIntervalMs?: number;
  startIsolatedQuotaHistorySamplerImpl?: typeof startIsolatedQuotaHistorySampler;
}
function createDebugLogger(
  stream: NodeJS.WriteStream,
  enabled: boolean,
): (message: string) => void {
  if (!enabled) {
    return () => undefined;
  }

  return (message: string) => {
    stream.write(`[debug] ${message}\n`);
  };
}

const DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS = 1_000;
const DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_QUOTA_MIN_READ_INTERVAL_MS = 30_000;
const DEFAULT_WATCH_QUOTA_IDLE_READ_INTERVAL_MS = 120_000;

export async function runCli(
  argv: string[],
  options: RunCliOptions = {},
): Promise<number> {
  const streams: CliStreams = {
    stdin: options.stdin ?? defaultStdin,
    stdout: options.stdout ?? defaultStdout,
    stderr: options.stderr ?? defaultStderr,
  };
  const store = options.store ?? createAccountStore();
  const desktopLauncher = options.desktopLauncher ?? await createPlatformDesktopLauncher();
  const authLogin = options.authLogin ?? createCodexLoginProvider();
  const daemonProcessManager =
    options.daemonProcessManager ?? createDaemonProcessManager(store.paths.codexTeamDir);
  const watchProcessManager =
    options.watchProcessManager ?? createWatchProcessManager(store.paths.codexTeamDir);
  const proxyProcessManager =
    options.proxyProcessManager ?? createProxyProcessManager(store.paths.codexTeamDir);
  const runCodexCli = options.runCodexCli ?? runCodexWithAutoRestart;
  const startIsolatedQuotaHistorySamplerImpl =
    options.startIsolatedQuotaHistorySamplerImpl ?? startIsolatedQuotaHistorySampler;
  const interruptSignal = options.interruptSignal;
  const managedDesktopWaitStatusDelayMs =
    options.managedDesktopWaitStatusDelayMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_DELAY_MS;
  const managedDesktopWaitStatusIntervalMs =
    options.managedDesktopWaitStatusIntervalMs ?? DEFAULT_MANAGED_DESKTOP_WAIT_STATUS_INTERVAL_MS;
  const watchQuotaMinReadIntervalMs =
    options.watchQuotaMinReadIntervalMs ?? DEFAULT_WATCH_QUOTA_MIN_READ_INTERVAL_MS;
  const watchQuotaIdleReadIntervalMs =
    options.watchQuotaIdleReadIntervalMs ?? DEFAULT_WATCH_QUOTA_IDLE_READ_INTERVAL_MS;
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("--json");
  const debug = parsed.flags.has("--debug");
  const debugLog = createDebugLogger(streams.stderr, debug);

  try {
    validateParsedArgs(parsed);

    if (parsed.flags.has("--version")) {
      streams.stdout.write(`${packageJson.version}\n`);
      return 0;
    }

    if (
      !parsed.command &&
      !parsed.flags.has("--help") &&
      streams.stdin.isTTY &&
      streams.stdout.isTTY
    ) {
        return await handleTuiCommand({
          positionals: [],
          store,
          desktopLauncher,
          daemonProcessManager,
          watchProcessManager,
          proxyProcessManager,
          streams,
          runCodexCli,
          debugLog,
        interruptSignal,
        managedDesktopWaitStatusDelayMs,
        managedDesktopWaitStatusIntervalMs,
      });
    }

    if (!parsed.command || parsed.flags.has("--help")) {
      printHelp(streams.stdout);
      return 0;
    }

    switch (parsed.command) {
      case "completion": {
        return await handleCompletionCommand({
          store,
          positionals: parsed.positionals,
          flags: parsed.flags,
          stdout: streams.stdout,
        });
      }

      case "current": {
        return await handleCurrentCommand({
          store,
          desktopLauncher,
          stdout: streams.stdout,
          debugLog,
          json,
          refresh: parsed.flags.has("--refresh"),
        });
      }

      case "doctor": {
        return await handleDoctorCommand({
          store,
          desktopLauncher,
          stdout: streams.stdout,
          debugLog,
          json,
        });
      }

      case "list": {
        return await handleListCommand({
          store,
          daemonProcessManager,
          stdout: streams.stdout,
          debugLog,
          debug,
          json,
          refresh: parsed.flags.has("--refresh"),
          targetName: parsed.positionals[0],
          usageWindow: parsed.optionValues.get("--usage-window"),
          verbose: parsed.flags.has("--verbose"),
        });
      }

      case "usage": {
        return await handleUsageCommand({
          positionals: parsed.positionals,
          window: parsed.optionValues.get("--window"),
          daily: parsed.flags.has("--daily"),
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "add": {
        return await handleAddCommand({
          name: parsed.positionals[0],
          positionals: parsed.positionals,
          deviceAuth: parsed.flags.has("--device-auth"),
          withApiKey: parsed.flags.has("--with-api-key"),
          force: parsed.flags.has("--force"),
          json,
          store,
          authLogin,
          streams,
          debugLog,
        });
      }

      case "save": {
        return await handleSaveCommand({
          name: parsed.positionals[0],
          json,
          force: parsed.flags.has("--force"),
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "update": {
        return await handleUpdateCommand({
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "switch": {
        const auto = parsed.flags.has("--auto");
        const dryRun = parsed.flags.has("--dry-run");
        const force = parsed.flags.has("--force");
        const name = parsed.positionals[0];

        if (dryRun && !auto) {
          throw new Error(`Usage: ${getUsage("switch", "auto")}`);
        }

        if (auto) {
          if (name) {
            throw new Error(`Usage: ${getUsage("switch", "auto")}`);
          }

          const autoSwitch = dryRun
            ? await performAutoSwitch(store, desktopLauncher, {
                dryRun,
                force,
                signal: interruptSignal,
                statusStream: streams.stderr,
                statusDelayMs: managedDesktopWaitStatusDelayMs,
                statusIntervalMs: managedDesktopWaitStatusIntervalMs,
                debugLog,
              })
            : await (async () => {
                const autoSwitchCommand = "switch --auto";
                const lock = await tryAcquireSwitchLock(store, autoSwitchCommand);
                if (!lock.acquired) {
                  throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
                }

                try {
                  return await performAutoSwitch(store, desktopLauncher, {
                    dryRun,
                    force,
                    signal: interruptSignal,
                    statusStream: streams.stderr,
                    statusDelayMs: managedDesktopWaitStatusDelayMs,
                    statusIntervalMs: managedDesktopWaitStatusIntervalMs,
                    debugLog,
                  });
                } finally {
                  await lock.release();
                }
              })();
          const {
            refreshResult,
            selected,
            candidates,
            quota: selectedQuota,
            skipped,
            result,
            warnings,
          } = autoSwitch;

          if (dryRun) {
            const payload = {
              ok: true,
              action: "switch",
              mode: "auto",
              dry_run: true,
              selected,
              candidates,
              warnings,
            };

            if (json) {
              writeJson(streams.stdout, payload);
            } else {
              streams.stdout.write(
                `${describeAutoSwitchSelection(selected, true, null, warnings)}\n`,
              );
            }
            return refreshResult.failures.length === 0 ? 0 : 1;
          }

          if (skipped) {
            const payload = {
              ok: true,
              action: "switch",
              mode: "auto",
              skipped: true,
              reason: "already_current_best",
              account: {
                name: selected.name,
                account_id: selected.account_id,
                identity: selected.identity,
              },
              selected,
              candidates,
              quota: selectedQuota,
              warnings,
            };

            if (json) {
              writeJson(streams.stdout, payload);
            } else {
              streams.stdout.write(`${describeAutoSwitchNoop(selected, warnings)}\n`);
            }
            return refreshResult.failures.length === 0 ? 0 : 1;
          }
          if (!result) {
            throw new Error("Auto switch completed without a target account result.");
          }

          const payload = {
            ok: true,
            action: "switch",
            mode: "auto",
            account: {
              name: result.account.name,
              account_id: result.account.account_id,
              user_id: result.account.user_id ?? null,
              identity: result.account.identity,
              auth_mode: result.account.auth_mode,
            },
            selected,
            candidates,
            quota: selectedQuota,
            backup_path: result.backup_path,
            warnings: result.warnings,
          };

          if (json) {
            writeJson(streams.stdout, payload);
          } else {
            streams.stdout.write(
              `${describeAutoSwitchSelection(selected, false, result.backup_path, result.warnings)}\n`,
            );
          }
          return refreshResult.failures.length === 0 ? 0 : 1;
        }

        if (!name) {
          throw new Error(`Usage: ${getUsage("switch")}`);
        }
        if (name === PROXY_ACCOUNT_NAME) {
          throw new Error(
            'Use "codexm proxy enable" or the dashboard proxy row to enable proxy mode.',
          );
        }
        ensureAccountName(name);
        const { result, quota, desktopForceWarning, proxyRetained } = await performManualSwitch({
          name,
          force,
          store,
          desktopLauncher,
          stderr: streams.stderr,
          debugLog,
          interruptSignal,
          managedDesktopWaitStatusDelayMs,
          managedDesktopWaitStatusIntervalMs,
        });
        if (desktopForceWarning) {
          streams.stderr.write(`${desktopForceWarning}\n`);
        }
        const payload = {
          ok: true,
          action: "switch",
          account: {
            name: result.account.name,
            account_id: result.account.account_id,
            user_id: result.account.user_id ?? null,
            identity: result.account.identity,
            auth_mode: result.account.auth_mode,
          },
          quota,
          backup_path: result.backup_path,
          proxy_retained: proxyRetained,
          effective_current_account_name: proxyRetained ? PROXY_ACCOUNT_NAME : result.account.name,
          warnings: result.warnings,
        };

        if (json) {
          writeJson(streams.stdout, payload);
        } else {
          if (proxyRetained) {
            streams.stdout.write(
              `Updated proxy upstream to "${result.account.name}" (${maskAccountId(result.account.identity)}) while proxy remains enabled.\n`,
            );
          } else {
            streams.stdout.write(
              `Switched to "${result.account.name}" (${maskAccountId(result.account.identity)}).\n`,
            );
          }
          if (result.backup_path) {
            streams.stdout.write(`Backup: ${result.backup_path}\n`);
          }
          for (const warning of result.warnings) {
            streams.stdout.write(`Warning: ${warning}\n`);
          }
        }
        return 0;
      }

      case "launch": {
        return await handleLaunchCommand({
          parsed,
          json,
          debug,
          store,
          desktopLauncher,
          daemonProcessManager,
          streams,
          debugLog,
        });
      }

      case "watch": {
        return await handleWatchCommand({
          parsed,
          store,
          desktopLauncher,
          streams,
          interruptSignal,
          debug,
          debugLog,
          managedDesktopWaitStatusDelayMs,
          managedDesktopWaitStatusIntervalMs,
          watchQuotaMinReadIntervalMs,
          watchQuotaIdleReadIntervalMs,
        });
      }

      case "daemon": {
        return await handleDaemonCommand({
          store,
          positionals: parsed.positionals,
          optionValues: parsed.optionValues,
          stdout: streams.stdout,
          debug,
          json,
          daemonProcessManager,
          desktopLauncher,
          streams,
          debugLog,
          managedDesktopWaitStatusDelayMs,
          managedDesktopWaitStatusIntervalMs,
          watchQuotaMinReadIntervalMs,
          watchQuotaIdleReadIntervalMs,
        });
      }

      case "autoswitch": {
        return await handleAutoswitchCommand({
          store,
          positionals: parsed.positionals,
          daemonProcessManager,
          stdout: streams.stdout,
          debug,
          json,
        });
      }

      case "proxy": {
        return await handleProxyCommand({
          store,
          positionals: parsed.positionals,
          optionValues: parsed.optionValues,
          flags: parsed.flags,
          stdout: streams.stdout,
          stderr: streams.stderr,
          debug,
          json,
          proxyProcessManager,
          desktopLauncher,
          interruptSignal,
          debugLog,
          managedDesktopWaitStatusDelayMs,
          managedDesktopWaitStatusIntervalMs,
        });
      }

      case "protect": {
        return await handleProtectCommand({
          name: parsed.positionals[0],
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "unprotect": {
        return await handleUnprotectCommand({
          name: parsed.positionals[0],
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "overlay": {
        return await handleOverlayCommand({
          positionals: parsed.positionals,
          ownerPid: parsed.optionValues.get("--owner-pid"),
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "export": {
        return await handleExportCommand({
          positionals: parsed.positionals,
          outputPath: parsed.optionValues.get("--output"),
          force: parsed.flags.has("--force"),
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "import": {
        return await handleImportCommand({
          positionals: parsed.positionals,
          localName: parsed.optionValues.get("--name"),
          force: parsed.flags.has("--force"),
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "inspect": {
        return await handleInspectBundleCommand({
          positionals: parsed.positionals,
          json,
          stdout: streams.stdout,
          debugLog,
        });
      }

      case "tui": {
        return await handleTuiCommand({
          positionals: parsed.positionals,
          store,
          desktopLauncher,
          daemonProcessManager,
          watchProcessManager,
          proxyProcessManager,
          streams,
          runCodexCli,
          debugLog,
          interruptSignal,
          managedDesktopWaitStatusDelayMs,
          managedDesktopWaitStatusIntervalMs,
        });
      }

      case "run": {
        // `codexm run [-- ...codexArgs]` wraps `codex` and auto-restarts
        // when the auth file changes (e.g. after `codexm switch`).
        if (parsed.positionals.length > 0) {
          throw new Error(`Usage: ${getUsage("run")}`);
        }
        const isolatedAccountName = parsed.optionValues.get("--account") ?? null;
        const proxyMode = parsed.flags.has("--proxy");
        if (proxyMode && isolatedAccountName) {
          throw new Error(`Usage: ${getUsage("run")}`);
        }
        if (isolatedAccountName) {
          ensureAccountName(isolatedAccountName);
        }
        const codexArgs = parsed.passthrough;
        if (proxyMode) {
          const [savedProxyState, proxyStatus] = await Promise.all([
            readProxyState(store.paths.codexTeamDir),
            proxyProcessManager.getStatus(),
          ]);
          const proxyState =
            savedProxyState?.enabled === true
              ? proxyStatus.running && proxyStatus.state
                ? proxyStatus.state
                : await proxyProcessManager.startDetached({
                    host: savedProxyState.host,
                    port: savedProxyState.port,
                    debug: savedProxyState.debug || debug,
                  })
              : await proxyProcessManager.startDetached({
                  host: DEFAULT_PROXY_HOST,
                  port: resolveProxyPort(),
                  debug,
                });
          streams.stderr.write(
            `[codexm run] Starting codex in isolated proxy mode through ${proxyState.base_url}...\n`,
          );
          if (codexArgs.length > 0) {
            streams.stderr.write(
              `[codexm run] codex args: ${codexArgs.join(" ")}\n`,
            );
          }
          streams.stderr.write(
            `[codexm run] CODEX_HOME is isolated for this process. It will not write local threads into the live runtime.\n\n`,
          );
          const result = await runIsolatedProxyCodexSession({
            backendBaseUrl: proxyState.base_url,
            openAIBaseUrl: proxyState.openai_base_url,
            store,
            runCodexCli,
            codexArgs,
            debugLog,
            stderr: streams.stderr,
            signal: interruptSignal,
          });
          return result.exitCode;
        }
        if (!isolatedAccountName) {
          streams.stderr.write(
            `[codexm run] Starting codex with auto-restart on auth changes...
`,
          );
          if (codexArgs.length > 0) {
            streams.stderr.write(
              `[codexm run] codex args: ${codexArgs.join(" ")}
`,
            );
          }
          streams.stderr.write(
            `[codexm run] Use "codexm switch <account>" in another terminal to hot-switch accounts.

`,
          );

          const result = await runDirectCodexSession({
            store,
            runCodexCli,
            codexArgs,
            debugLog,
            stderr: streams.stderr,
            signal: interruptSignal,
          });

          if (result.restartCount > 0) {
            streams.stderr.write(
              `
[codexm run] Session ended. Restarted ${result.restartCount} time(s) due to auth changes.
`,
            );
          }
          return result.exitCode;
        }

        streams.stderr.write(
          `[codexm run] Starting codex in isolated mode with saved snapshot "${isolatedAccountName}"...
`,
        );
        if (codexArgs.length > 0) {
          streams.stderr.write(
            `[codexm run] codex args: ${codexArgs.join(" ")}
`,
          );
        }
        streams.stderr.write(
          `[codexm run] CODEX_HOME is isolated for this process. It will not follow codexm switch/watch restarts.

`,
        );

        const result = await runIsolatedAccountCodexSession({
          accountName: isolatedAccountName,
          store,
          runCodexCli,
          codexArgs,
          debugLog,
          stderr: streams.stderr,
          signal: interruptSignal,
          pollIntervalMs: watchQuotaMinReadIntervalMs,
          startIsolatedQuotaHistorySamplerImpl,
        });
        return result.exitCode;
      }


      case "remove": {
        return await handleRemoveCommand({
          name: parsed.positionals[0],
          json,
          yes: parsed.flags.has("--yes"),
          store,
          streams,
          debugLog,
        });
      }

      case "rename": {
        return await handleRenameCommand({
          oldName: parsed.positionals[0],
          newName: parsed.positionals[1],
          json,
          store,
          stdout: streams.stdout,
          debugLog,
        });
      }

      default:
        throw new CliUsageError(`Unknown command "${parsed.command}".`);
    }
  } catch (error) {
    const message = (error as Error).message;
    const suggestion = error instanceof CliUsageError ? error.suggestion : null;
    if (json) {
      writeJson(streams.stderr, {
        ok: false,
        error: message,
        ...(suggestion ? { suggestion } : {}),
      });
    } else {
      streams.stderr.write(`Error: ${message}\n`);
      if (suggestion) {
        streams.stderr.write(`Did you mean "${suggestion}"?\n`);
      }
    }
    return 1;
  }
}
