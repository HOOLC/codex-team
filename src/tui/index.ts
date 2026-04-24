import {
  StaleDaemonProcessError,
  type StaleDaemonPortConflict,
} from "../daemon/process.js";
import {
  ANSI,
  createInitialAccountDashboardState,
  createPlaceholderSnapshot,
  getFilteredAccounts,
  renderAccountDashboardScreen,
  resolvePreferredSelection,
  updateSnapshotCurrentIndicator,
  updateSnapshotProxyRouting,
} from "./render.js";
export {
  createInitialAccountDashboardState,
  renderAccountDashboardScreen,
} from "./render.js";
import type {
  AccountDashboardActionResult,
  AccountDashboardDetailOverride,
  AccountDashboardExitResult,
  AccountDashboardExportSource,
  AccountDashboardExternalUpdate,
  AccountDashboardImportPreview,
  AccountDashboardSnapshot,
  AccountDashboardState,
  AccountDashboardUndoAction,
  ExitAction,
  RunAccountDashboardTuiOptions,
} from "./types.js";
export type {
  AccountDashboardActionResult,
  AccountDashboardDetailOverride,
  AccountDashboardExitResult,
  AccountDashboardExportSource,
  AccountDashboardExternalUpdate,
  AccountDashboardImportPreview,
  AccountDashboardSnapshot,
  AccountDashboardState,
  AccountDashboardUndoAction,
  RunAccountDashboardTuiOptions,
} from "./types.js";

const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 75_000;
const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

interface InputEvent {
  value: string;
  name: string;
  ctrl?: boolean;
}

type PromptState =
  | {
      kind: "export";
      label: string;
      value: string;
      cursor: number;
      source: AccountDashboardExportSource;
    }
  | {
      kind: "import-path";
      label: string;
      value: string;
      cursor: number;
    }
  | {
      kind: "import-name";
      label: string;
      value: string;
      cursor: number;
      bundlePath: string;
      preview: AccountDashboardImportPreview;
    };

type ConfirmState = {
  kind: "delete";
  accountName: string;
} | {
  kind: "desktop-relaunch";
  accountName: string;
} | {
  kind: "cleanup-stale-daemon";
  accountName: string;
  conflict: StaleDaemonPortConflict;
  retry: {
    force: boolean;
    after: ExitAction | "desktop" | "desktop-force" | null;
  };
};

function buildDefaultExportPath(source: AccountDashboardExportSource): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
  const base = source.type === "managed" && source.name ? source.name : "current";
  return `./codexm-share-${base}-${timestamp}.json`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function color(value: string, tone: "green" | "yellow" | "red" | "cyan" | "dim"): string {
  const code =
    tone === "green"
      ? ANSI.green
      : tone === "yellow"
        ? ANSI.yellow
        : tone === "red"
          ? ANSI.red
          : tone === "cyan"
            ? ANSI.cyan
            : ANSI.dim;
  return `${code}${value}${ANSI.reset}`;
}

function formatInteractiveQuery(query: string, cursor: number, active: boolean): string {
  if (!active) {
    return query;
  }
  const safeCursor = clamp(cursor, 0, query.length);
  return `${query.slice(0, safeCursor)}_${query.slice(safeCursor)}`;
}

function insertTextAtCursor(state: AccountDashboardState, value: string): AccountDashboardState {
  return {
    ...state,
    query: `${state.query.slice(0, state.cursor)}${value}${state.query.slice(state.cursor)}`,
    cursor: state.cursor + value.length,
    selected: 0,
    scrollTop: 0,
  };
}

function deleteTextBeforeCursor(state: AccountDashboardState): AccountDashboardState {
  if (state.cursor === 0) {
    return state;
  }

  return {
    ...state,
    query: `${state.query.slice(0, state.cursor - 1)}${state.query.slice(state.cursor)}`,
    cursor: state.cursor - 1,
    selected: 0,
    scrollTop: 0,
  };
}

function isPrintableInput(value: string): boolean {
  return value.length === 1 && value >= " " && value !== "\u007f";
}

function isImmediateBrowseEvent(event: InputEvent): boolean {
  return event.name === "up"
    || event.name === "down"
    || event.name === "home"
    || event.name === "end"
    || event.value === "j"
    || event.value === "k"
    || event.value === "g"
    || event.value === "G";
}

function consumeInputBuffer(buffer: string): { events: InputEvent[]; rest: string } {
  const events: InputEvent[] = [];
  let index = 0;

  while (index < buffer.length) {
    const char = buffer[index];
    if (!char) {
      break;
    }

    if (char === "\u001b") {
      const sequence = buffer.slice(index, index + 3);
      if (sequence.startsWith("\u001b[")) {
        if (sequence.length < 3) {
          break;
        }
        const code = sequence[2];
        if (code === "A") {
          events.push({ value: sequence, name: "up" });
        } else if (code === "B") {
          events.push({ value: sequence, name: "down" });
        } else if (code === "C") {
          events.push({ value: sequence, name: "right" });
        } else if (code === "D") {
          events.push({ value: sequence, name: "left" });
        } else if (code === "H") {
          events.push({ value: sequence, name: "home" });
        } else if (code === "F") {
          events.push({ value: sequence, name: "end" });
        }
        index += 3;
        continue;
      }

      events.push({ value: char, name: "escape" });
      index += 1;
      continue;
    }

    if (char === "\u0003") {
      events.push({ value: char, name: "c", ctrl: true });
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      events.push({ value: char, name: "enter" });
      index += 1;
      if (char === "\r" && buffer[index] === "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "\u007f") {
      events.push({ value: char, name: "backspace" });
      index += 1;
      continue;
    }

    events.push({ value: char, name: char });
    index += 1;
  }

  return {
    events,
    rest: buffer.slice(index),
  };
}

export async function runAccountDashboardTui(
  options: RunAccountDashboardTuiOptions,
): Promise<AccountDashboardExitResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signalSource = options.signalSource ?? process;
  const autoRefreshIntervalMs = options.autoRefreshIntervalMs ?? DEFAULT_AUTO_REFRESH_INTERVAL_MS;
  let snapshot = options.initialSnapshot ?? createPlaceholderSnapshot();
  let state = createInitialAccountDashboardState(options.initialQuery ?? "");
  let refreshing = false;
  let busyMessage: string | null = null;
  let startupWarningBanner: string | null = null;
  let cleanedUp = false;
  let resolved = false;
  let actionQueue = Promise.resolve();
  let inputBuffer = "";
  let refreshPromise: Promise<void> | null = null;
  let refreshQueued = false;
  let refreshPreferredName: string | null = null;
  let refreshAttemptCount = 0;
  let autoRefreshTimer: NodeJS.Timeout | null = null;
  let activeOperation: { controller: AbortController; label: string } | null = null;
  let promptState: PromptState | null = null;
  let confirmState: ConfirmState | null = null;
  let detailOverride: AccountDashboardDetailOverride | null = null;
  let undoAction: AccountDashboardUndoAction | null = null;
  let forceExitRequested = false;
  let unsubscribeExternalUpdates: (() => void) | null = null;
  const previousRawMode = stdin.isRaw === true;

  let resolveExit: ((result: AccountDashboardExitResult) => void) | null = null;
  const exitPromise = new Promise<AccountDashboardExitResult>((resolve) => {
    resolveExit = resolve;
  });

  const render = () => {
    if (cleanedUp) {
      return;
    }

    const footerOverride = promptState
      ? `${promptState.label} ${formatInteractiveQuery(promptState.value, promptState.cursor, true)}`
      : confirmState
        ? confirmState.kind === "delete"
          ? `confirm: Delete account "${confirmState.accountName}"? [y/N]`
          : confirmState.kind === "desktop-relaunch"
            ? `confirm: Relaunch Desktop for "${confirmState.accountName}"? May force-close non-codexm app. [y/N]`
            : `confirm: Stop stale codexm ${confirmState.conflict.kind} pid ${confirmState.conflict.pid} on ${confirmState.conflict.host}:${confirmState.conflict.port} and continue? [y/N]`
        : null;
    const hintOverride = promptState
      ? color("Enter confirm | Esc back | Ctrl-U clear | Ctrl-C quit", "dim")
      : confirmState
        ? color("y confirm | n cancel | Esc back | q quit", "dim")
        : null;
    const statusOverride = state.statusMessage
      ? null
      : promptState
        ? promptState.kind === "import-name"
          ? "Choose the local managed account name. Enter confirms; Esc goes back."
          : promptState.kind === "import-path"
            ? "Enter a bundle path to preview it. Enter confirms; Esc goes back."
            : "Enter an output path for the share bundle. Enter confirms; Esc goes back."
        : confirmState
          ? confirmState.kind === "delete"
            ? `Delete account "${confirmState.accountName}"? Press y to confirm.`
            : confirmState.kind === "desktop-relaunch"
              ? `Relaunch Desktop for "${confirmState.accountName}"? Press y to confirm.`
              : `Stop stale codexm ${confirmState.conflict.kind} process ${confirmState.conflict.pid} on ${confirmState.conflict.host}:${confirmState.conflict.port}? Press y to confirm.`
          : null;

    stdout.write(
      `${ANSI.clear}${ANSI.home}${renderAccountDashboardScreen({
        snapshot,
        state,
        width: stdout.columns ?? 80,
        height: stdout.rows ?? 24,
        busyMessage,
        refreshing,
        bannerMessage: startupWarningBanner,
        detailOverride,
        footerOverride,
        hintOverride,
        statusOverride,
      })}`,
    );
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (unsubscribeExternalUpdates) {
      unsubscribeExternalUpdates();
      unsubscribeExternalUpdates = null;
    }
    stdin.off("data", onData);
    stdout.off?.("resize", onResize);
    for (const { signal, handler } of signalHandlers) {
      signalSource.off(signal, handler);
    }
    void undoAction?.discard?.().catch(() => undefined);
    stdin.setRawMode?.(previousRawMode);
    stdin.pause();
    stdout.write(`${ANSI.showCursor}${ANSI.altOff}`);
  };

  const finish = (
    action: ExitAction,
    optionsForFinish: { preferredName?: string | null } = {},
  ) => {
    if (resolved) {
      return;
    }
    resolved = true;
    cleanup();
    resolveExit?.({
      code: 0,
      action,
      preferredName: optionsForFinish.preferredName,
    });
  };

  const handleProcessSignal = (_signal: NodeJS.Signals) => {
    forceExitRequested = true;
    activeOperation?.controller.abort();
    finish("quit");
  };

  const signalHandlers = EXIT_SIGNALS.map((signal) => {
    const handler = () => {
      handleProcessSignal(signal);
    };
    signalSource.on(signal, handler);
    return { signal, handler };
  });

  const requestRefresh = (preferredName: string | null = null) => {
    refreshQueued = true;
    if (preferredName) {
      refreshPreferredName = preferredName;
    }

    if (activeOperation || refreshPromise) {
      render();
      return;
    }

    refreshPromise = (async () => {
      while (refreshQueued && !cleanedUp) {
        refreshQueued = false;
        const preferred = refreshPreferredName;
        refreshPreferredName = null;
        const isInitialRefresh = refreshAttemptCount === 0;
        refreshAttemptCount += 1;
        refreshing = true;
        render();

        try {
          const nextSnapshot = await options.loadSnapshot();
          if (cleanedUp) {
            return;
          }

          const priorStatus = state.statusMessage;
          snapshot = nextSnapshot;
          startupWarningBanner = null;
          state = resolvePreferredSelection(snapshot, state, preferred);
          if (priorStatus?.startsWith("Refresh failed:")) {
            state.statusMessage = null;
          }
        } catch (error) {
          if (!cleanedUp) {
            const message = (error as Error).message;
            if (isInitialRefresh && options.initialSnapshot) {
              startupWarningBanner = `Initial refresh failed: ${message}`;
            } else {
              state = {
                ...state,
                statusMessage: `Refresh failed: ${message}`,
              };
            }
          }
        } finally {
          refreshing = false;
          if (cleanedUp) {
            refreshPromise = null;
          }
          render();
        }
      }

      refreshPromise = null;
    })().catch((error) => {
      refreshing = false;
      refreshPromise = null;
      if (!cleanedUp) {
        state = {
          ...state,
          statusMessage: `Refresh failed: ${(error as Error).message}`,
        };
        render();
      }
    });
  };

  const setUndoAction = (nextUndo: AccountDashboardUndoAction | undefined) => {
    if (undoAction && undoAction !== nextUndo) {
      void undoAction.discard?.().catch(() => undefined);
    }
    undoAction = nextUndo ?? null;
  };

  const applyExternalUpdate = (update: AccountDashboardExternalUpdate) => {
    if (cleanedUp) {
      return;
    }

    if (typeof update.statusMessage === "string" && update.statusMessage !== "") {
      state = {
        ...state,
        statusMessage: update.statusMessage,
      };
    }

    if ("preferredName" in update) {
      requestRefresh(update.preferredName ?? null);
      return;
    }

    if (update.refresh) {
      requestRefresh();
      return;
    }

    render();
  };

  const resolveActionStatus = (result: AccountDashboardActionResult, fallback: string): string => {
    const base = result.statusMessage ?? fallback;
    const withWarning = result.warningMessages?.length
      ? `${base} Warning: ${result.warningMessages[0]}`
      : base;
    return result.undo ? `${withWarning} Press u to undo.` : withWarning;
  };

  const runSimpleAction = async (
    label: string,
    run: () => Promise<AccountDashboardActionResult>,
    options?: {
      busyLabel?: string;
    },
  ) => {
    busyMessage = options?.busyLabel ?? label;
    render();

    try {
      const result = await run();
      setUndoAction(result.undo);
      state = {
        ...state,
        statusMessage: resolveActionStatus(result, label),
      };
      if (typeof result.preferredName === "string") {
        requestRefresh(result.preferredName);
      } else if (result.preferredName === null) {
        requestRefresh();
      }
    } catch (error) {
      state = {
        ...state,
        statusMessage: `${label} failed: ${(error as Error).message}`,
      };
    } finally {
      busyMessage = null;
      render();
    }
  };

  const moveSelection = (delta: number) => {
    const filtered = getFilteredAccounts(snapshot, state.query);
    if (filtered.length === 0) {
      return;
    }
    state = {
      ...state,
      selected: clamp(state.selected + delta, 0, filtered.length - 1),
    };
  };

  const onResize = () => {
    render();
  };

  const handleFilterKeypress = async (event: InputEvent) => {
    if (event.name === "escape") {
      state = {
        ...state,
        filterActive: false,
      };
      render();
      return;
    }
    if (event.name === "enter") {
      state = {
        ...state,
        filterActive: false,
      };
      render();
      return;
    }
    if (event.name === "backspace") {
      state = deleteTextBeforeCursor(state);
      render();
      return;
    }
    if (event.ctrl && event.name === "u") {
      state = {
        ...state,
        query: "",
        cursor: 0,
        selected: 0,
        scrollTop: 0,
      };
      render();
      return;
    }
    if (event.name === "left") {
      state = {
        ...state,
        cursor: clamp(state.cursor - 1, 0, state.query.length),
      };
      render();
      return;
    }
    if (event.name === "right") {
      state = {
        ...state,
        cursor: clamp(state.cursor + 1, 0, state.query.length),
      };
      render();
      return;
    }
    if (isPrintableInput(event.value)) {
      state = insertTextAtCursor(state, event.value);
      render();
    }
  };

  const withOperationStatus = (
    accountName: string,
    result: { statusMessage?: string; warningMessages?: string[] },
    baseOverride?: string,
  ): string => {
    const base = baseOverride ?? result.statusMessage ?? `Switched to "${accountName}".`;
    return result.warningMessages?.length
      ? `${base} Warning: ${result.warningMessages[0]}`
      : base;
  };

  const runDesktopAction = async (
    name: string,
    optionsForAction: { forceRelaunch?: boolean } = {},
  ) => {
    if (!options.openDesktop) {
      state = {
        ...state,
        statusMessage: "Desktop open is unavailable in this session.",
      };
      render();
      return;
    }

    busyMessage = optionsForAction.forceRelaunch
      ? `Relaunching Codex Desktop for "${name}"...`
      : `Opening Codex Desktop for "${name}"...`;
    render();

    const result = await options.openDesktop(name, optionsForAction);
    state = {
      ...state,
      statusMessage: withOperationStatus(name, result),
    };
    render();
  };

  const runSwitchAction = async (optionsForAction: {
    force: boolean;
    after: ExitAction | "desktop" | "desktop-force" | null;
  }) => {
    const filtered = getFilteredAccounts(snapshot, state.query);
    const selected = filtered[state.selected] ?? null;
    if (!selected) {
      return;
    }

    const reloadingCurrentAccount =
      selected.current && optionsForAction.force && optionsForAction.after === null;
    const togglingProxy =
      selected.authModeLabel === "proxy" && optionsForAction.after === null && !reloadingCurrentAccount;

    if (selected.current && !reloadingCurrentAccount && !togglingProxy) {
      if (optionsForAction.after === "open-codex") {
        finish("open-codex", {
          preferredName: selected.name,
        });
        return;
      }
      if (optionsForAction.after === "open-isolated-codex") {
        finish("open-isolated-codex", {
          preferredName: selected.name,
        });
        return;
      }
      if (optionsForAction.after === "desktop") {
        await runDesktopAction(selected.name);
        requestRefresh(selected.name);
        return;
      }
      if (optionsForAction.after === "desktop-force") {
        await runDesktopAction(selected.name, { forceRelaunch: true });
        requestRefresh(selected.name);
        return;
      }

      state = {
        ...state,
        statusMessage: `"${selected.name}" is already current. Press f to reload it.`,
      };
      render();
      return;
    }

    const controller = new AbortController();
    activeOperation = {
      controller,
      label: reloadingCurrentAccount
        ? `reloading "${selected.name}"`
        : togglingProxy
          ? selected.current
            ? "disabling proxy"
            : "enabling proxy"
        : optionsForAction.after === "open-codex"
        ? `opening Codex TUI for "${selected.name}"`
        : optionsForAction.after === "open-isolated-codex"
          ? `opening isolated Codex TUI for "${selected.name}"`
        : optionsForAction.after === "desktop"
          ? `opening Codex Desktop for "${selected.name}"`
        : optionsForAction.after === "desktop-force"
          ? `relaunching Codex Desktop for "${selected.name}"`
          : `switching "${selected.name}"`,
    };
    busyMessage = reloadingCurrentAccount
      ? `Reloading "${selected.name}"...`
      : togglingProxy
        ? selected.current
          ? "Disabling proxy..."
          : "Enabling proxy..."
      : optionsForAction.after === "open-codex"
      ? `Switching to "${selected.name}" and opening Codex TUI...`
      : optionsForAction.after === "open-isolated-codex"
        ? `Switching to "${selected.name}" and opening isolated Codex TUI...`
      : optionsForAction.after === "desktop"
        ? `Switching to "${selected.name}" and opening Codex Desktop...`
      : optionsForAction.after === "desktop-force"
        ? `Switching to "${selected.name}" and relaunching Codex Desktop...`
        : optionsForAction.force
          ? `Force-switching to "${selected.name}"...`
          : `Switching to "${selected.name}"...`;
    render();

    try {
      const result = await options.switchAccount(selected.name, {
        force: optionsForAction.force,
        signal: controller.signal,
        onStatusMessage: (message) => {
          busyMessage = message;
          render();
        },
      });

      state = {
        ...state,
        statusMessage: withOperationStatus(
          selected.name,
          result,
          reloadingCurrentAccount ? `Reloaded "${selected.name}".` : undefined,
        ),
      };
      const currentName = result.currentName ?? selected.name;
      snapshot = updateSnapshotCurrentIndicator(snapshot, currentName);
      snapshot = updateSnapshotProxyRouting(snapshot, {
        proxyUpstreamName: result.proxyUpstreamName,
        proxyLastUpstreamLabel: result.proxyLastUpstreamLabel,
      });
      state = resolvePreferredSelection(snapshot, state, selected.name);

      if (optionsForAction.after === "open-codex") {
        render();
        finish("open-codex", {
          preferredName: selected.name,
        });
        return;
      }

      if (optionsForAction.after === "open-isolated-codex") {
        render();
        finish("open-isolated-codex", {
          preferredName: selected.name,
        });
        return;
      }

      if (optionsForAction.after === "desktop") {
        await runDesktopAction(selected.name);
        requestRefresh(selected.name);
        return;
      }
      if (optionsForAction.after === "desktop-force") {
        await runDesktopAction(selected.name, { forceRelaunch: true });
        requestRefresh(selected.name);
        return;
      }

      requestRefresh(selected.name);
    } catch (error) {
      if (
        error instanceof StaleDaemonProcessError
        && options.cleanupStaleDaemonProcess
      ) {
        confirmState = {
          kind: "cleanup-stale-daemon",
          accountName: selected.name,
          conflict: error.conflict,
          retry: optionsForAction,
        };
        state = {
          ...state,
          statusMessage: null,
        };
        return;
      }

      state = {
        ...state,
        statusMessage: optionsForAction.after === "desktop" || optionsForAction.after === "desktop-force"
          ? `Desktop open failed: ${(error as Error).message}`
          : optionsForAction.after === "open-codex"
            ? `Codex TUI open failed: ${(error as Error).message}`
            : optionsForAction.after === "open-isolated-codex"
              ? `Isolated Codex TUI open failed: ${(error as Error).message}`
            : reloadingCurrentAccount
              ? `Reload failed: ${(error as Error).message}`
            : `Switch failed: ${(error as Error).message}`,
      };
    } finally {
      busyMessage = null;
      activeOperation = null;
      render();
      if (refreshQueued && !refreshPromise && !cleanedUp) {
        requestRefresh();
      }
    }
  };

  const beginExportPrompt = (source: AccountDashboardExportSource) => {
    if (!options.exportAccount) {
      state = {
        ...state,
        statusMessage: "Export is unavailable in this session.",
      };
      render();
      return;
    }

    detailOverride = null;
    promptState = {
      kind: "export",
      label: "Export to file:",
      value: buildDefaultExportPath(source),
      cursor: buildDefaultExportPath(source).length,
      source,
    };
    render();
  };

  const beginImportPrompt = () => {
    if (!options.inspectImportBundle || !options.importBundle) {
      state = {
        ...state,
        statusMessage: "Import is unavailable in this session.",
      };
      render();
      return;
    }

    promptState = {
      kind: "import-path",
      label: "Bundle path:",
      value: "",
      cursor: 0,
    };
    detailOverride = null;
    render();
  };

  const beginDeleteConfirm = () => {
    if (!options.deleteAccount) {
      state = {
        ...state,
        statusMessage: "Delete is unavailable in this session.",
      };
      render();
      return;
    }

    const filtered = getFilteredAccounts(snapshot, state.query);
    const selected = filtered[state.selected] ?? null;
    if (!selected) {
      return;
    }

    confirmState = {
      kind: "delete",
      accountName: selected.name,
    };
    detailOverride = null;
    render();
  };

  const beginDesktopRelaunchConfirm = () => {
    if (!options.openDesktop) {
      state = {
        ...state,
        statusMessage: "Desktop open is unavailable in this session.",
      };
      render();
      return;
    }

    const filtered = getFilteredAccounts(snapshot, state.query);
    const selected = filtered[state.selected] ?? null;
    if (!selected) {
      return;
    }

    confirmState = {
      kind: "desktop-relaunch",
      accountName: selected.name,
    };
    detailOverride = null;
    render();
  };

  const handlePromptKeypress = async (event: InputEvent): Promise<void> => {
    if (!promptState) {
      return;
    }

    if (event.name === "escape") {
      if (promptState.kind === "import-name") {
        promptState = {
          kind: "import-path",
          label: "Bundle path:",
          value: promptState.bundlePath,
          cursor: promptState.bundlePath.length,
        };
      } else {
        promptState = null;
        detailOverride = null;
      }
      render();
      return;
    }

    if (event.name === "enter") {
      if (promptState.kind === "export") {
        const { source, value } = promptState;
        if (!value.trim()) {
          state = {
            ...state,
            statusMessage: "Output path is required.",
          };
          render();
          return;
        }
        promptState = null;
        await runSimpleAction(
          "Export",
          async () => await options.exportAccount!(source, value),
          {
            busyLabel: "Exporting share bundle...",
          },
        );
        return;
      }

      if (promptState.kind === "import-path") {
        const bundlePath = promptState.value.trim();
        if (!bundlePath) {
          state = {
            ...state,
            statusMessage: "Bundle path is required.",
          };
          render();
          return;
        }

        try {
          const preview = await options.inspectImportBundle!(bundlePath);
          detailOverride = {
            title: preview.title,
            lines: preview.lines,
          };
          promptState = {
            kind: "import-name",
            label: "Save as name:",
            value: "",
            cursor: 0,
            bundlePath,
            preview,
          };
        } catch (error) {
          state = {
            ...state,
            statusMessage: `Preview failed: ${(error as Error).message}`,
          };
        }
        render();
        return;
      }

      const localName = promptState.value.trim();
      if (!localName) {
        state = {
          ...state,
          statusMessage: "Local account name is required.",
        };
        render();
        return;
      }

      const bundlePath = promptState.bundlePath;
      promptState = null;
      await runSimpleAction(
        "Import",
        async () => await options.importBundle!(bundlePath, localName),
        {
          busyLabel: "Importing share bundle...",
        },
      );
      detailOverride = null;
      return;
    }

    if (event.name === "backspace") {
      promptState = {
        ...promptState,
        value: `${promptState.value.slice(0, Math.max(0, promptState.cursor - 1))}${promptState.value.slice(promptState.cursor)}`,
        cursor: Math.max(0, promptState.cursor - 1),
      };
      render();
      return;
    }

    if (event.ctrl && event.name === "u") {
      promptState = {
        ...promptState,
        value: "",
        cursor: 0,
      };
      render();
      return;
    }

    if (event.name === "left") {
      promptState = {
        ...promptState,
        cursor: clamp(promptState.cursor - 1, 0, promptState.value.length),
      };
      render();
      return;
    }

    if (event.name === "right") {
      promptState = {
        ...promptState,
        cursor: clamp(promptState.cursor + 1, 0, promptState.value.length),
      };
      render();
      return;
    }

    if (isPrintableInput(event.value)) {
      promptState = {
        ...promptState,
        value: `${promptState.value.slice(0, promptState.cursor)}${event.value}${promptState.value.slice(promptState.cursor)}`,
        cursor: promptState.cursor + event.value.length,
      };
      render();
    }
  };

  const handleConfirmKeypress = async (event: InputEvent): Promise<void> => {
    if (!confirmState) {
      return;
    }

    if (event.name === "escape" || event.name === "n" || event.name === "enter") {
      confirmState = null;
      render();
      return;
    }

    if (event.name === "q" || (event.ctrl && event.name === "c")) {
      finish("quit");
      return;
    }

    if (event.name !== "y") {
      return;
    }

    const activeConfirm = confirmState;
    const accountName = activeConfirm.accountName;
    const confirmKind = activeConfirm.kind;
    confirmState = null;
    if (confirmKind === "delete") {
      await runSimpleAction(
        "Delete",
        async () => await options.deleteAccount!(accountName),
        {
          busyLabel: `Deleting "${accountName}"...`,
        },
      );
      return;
    }

    if (confirmKind === "cleanup-stale-daemon") {
      if (!options.cleanupStaleDaemonProcess) {
        state = {
          ...state,
          statusMessage: "Stale daemon cleanup is unavailable in this session.",
        };
        render();
        return;
      }

      busyMessage =
        `Stopping stale codexm ${activeConfirm.conflict.kind} process ${activeConfirm.conflict.pid}...`;
      render();

      try {
        await options.cleanupStaleDaemonProcess(activeConfirm.conflict);
        state = {
          ...state,
          statusMessage:
            `Stopped stale codexm ${activeConfirm.conflict.kind} process ${activeConfirm.conflict.pid}. Retrying...`,
        };
        render();
        await runSwitchAction(activeConfirm.retry);
      } catch (error) {
        busyMessage = null;
        state = {
          ...state,
          statusMessage: `Cleanup failed: ${(error as Error).message}`,
        };
        render();
      }
      return;
    }

    const filtered = getFilteredAccounts(snapshot, state.query);
    const selectedIndex = filtered.findIndex((account) => account.name === accountName);
    if (selectedIndex >= 0) {
      state = {
        ...state,
        selected: selectedIndex,
      };
    }
    await runSwitchAction({
      force: false,
      after: "desktop-force",
    });
  };

  const handleActiveOperationKeypress = (event: InputEvent): boolean => {
    if (!activeOperation) {
      return false;
    }

    if ((event.ctrl && event.name === "c") || event.name === "escape") {
      activeOperation.controller.abort();
      state = {
        ...state,
        statusMessage: `Cancelling ${activeOperation.label}...`,
      };
      render();
      return true;
    }

    if (event.name === "up" || event.name === "k") {
      moveSelection(-1);
      render();
      return true;
    }
    if (event.name === "down" || event.name === "j") {
      moveSelection(1);
      render();
      return true;
    }
    if (event.name === "home" || event.value === "g") {
      state = {
        ...state,
        selected: 0,
        scrollTop: 0,
      };
      render();
      return true;
    }
    if (event.name === "end" || event.value === "G") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      state = {
        ...state,
        selected: Math.max(0, filtered.length - 1),
      };
      render();
      return true;
    }

    if (event.name === "q") {
      state = {
        ...state,
        statusMessage: `Busy. Press Esc or Ctrl-C to cancel ${activeOperation.label}.`,
      };
      render();
      return true;
    }

    return true;
  };

  const handleBrowseKeypress = async (event: InputEvent): Promise<void> => {
    if (handleActiveOperationKeypress(event)) {
      return;
    }

    if ((event.ctrl && event.name === "c") || event.name === "q") {
      finish("quit");
      return;
    }
    if (event.name === "escape") {
      detailOverride = null;
      render();
      return;
    }
    if (event.name === "up" || event.name === "k") {
      moveSelection(-1);
      render();
      return;
    }
    if (event.name === "down" || event.name === "j") {
      moveSelection(1);
      render();
      return;
    }
    if (event.name === "home" || event.value === "g") {
      state = {
        ...state,
        selected: 0,
        scrollTop: 0,
      };
      render();
      return;
    }
    if (event.name === "end" || event.value === "G") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      state = {
        ...state,
        selected: Math.max(0, filtered.length - 1),
      };
      render();
      return;
    }
    if (event.value === "/") {
      state = {
        ...state,
        filterActive: true,
        cursor: state.query.length,
      };
      render();
      return;
    }
    if (event.value === "r") {
      void options.triggerBackgroundRefresh?.({
        ensureDaemon: true,
        source: "tui-manual-refresh",
      }).catch(() => undefined);
      requestRefresh();
      return;
    }
    if (event.value === "a") {
      if (!options.toggleAutoswitch) {
        state = {
          ...state,
          statusMessage: "Autoswitch toggle is unavailable in this session.",
        };
        render();
        return;
      }

      await runSimpleAction(
        "Autoswitch",
        async () => await options.toggleAutoswitch!(),
        {
          busyLabel: "Updating autoswitch mode...",
        },
      );
      return;
    }
    if (event.value === "e") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      const selected = filtered[state.selected] ?? null;
      if (!selected) {
        return;
      }
      if (selected.authModeLabel === "proxy") {
        state = {
          ...state,
          statusMessage: "Proxy export is unavailable.",
        };
        render();
        return;
      }
      beginExportPrompt({
        type: "managed",
        name: selected.name,
      });
      return;
    }
    if (event.value === "i") {
      beginImportPrompt();
      return;
    }
    if (event.value === "x") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      const selected = filtered[state.selected] ?? null;
      if (selected?.authModeLabel === "proxy") {
        state = {
          ...state,
          statusMessage: "Proxy delete is unavailable.",
        };
        render();
        return;
      }
      beginDeleteConfirm();
      return;
    }
    if (event.value === "u") {
      if (!undoAction) {
        state = {
          ...state,
          statusMessage: "Nothing to undo.",
        };
        render();
        return;
      }

      const currentUndo = undoAction;
      undoAction = null;
      await runSimpleAction("Undo", async () => await currentUndo.run(), {
        busyLabel: "Undoing last action...",
      });
      return;
    }
    if (event.value === "p") {
      if (!options.toggleAutoSwitchProtection) {
        state = {
          ...state,
          statusMessage: "Protection toggle is unavailable in this session.",
        };
        render();
        return;
      }

      const filtered = getFilteredAccounts(snapshot, state.query);
      const selected = filtered[state.selected] ?? null;
      if (!selected) {
        return;
      }
      if (selected.authModeLabel === "proxy") {
        state = {
          ...state,
          statusMessage: "Proxy protection toggle is unavailable.",
        };
        render();
        return;
      }

      await runSimpleAction(
        "Protection",
        async () =>
          await options.toggleAutoSwitchProtection!(
            selected.name,
            !selected.autoSwitchEligible,
          ),
        {
          busyLabel: `Updating auto-switch protection for "${selected.name}"...`,
        },
      );
      return;
    }
    if (event.value === "f") {
      await runSwitchAction({
        force: true,
        after: null,
      });
      return;
    }
    if (event.value === "o") {
      await runSwitchAction({
        force: false,
        after: "open-codex",
      });
      return;
    }
    if (event.value === "O") {
      await runSwitchAction({
        force: false,
        after: "open-isolated-codex",
      });
      return;
    }
    if (event.value === "d") {
      await runSwitchAction({
        force: false,
        after: "desktop",
      });
      return;
    }
    if (event.value === "D") {
      beginDesktopRelaunchConfirm();
      return;
    }
    if (event.name === "enter") {
      await runSwitchAction({
        force: false,
        after: null,
      });
    }
  };

  const onData = (chunk: Buffer | string) => {
    inputBuffer += chunk.toString();
    const { events, rest } = consumeInputBuffer(inputBuffer);
    inputBuffer = rest;

    for (const event of events) {
      if (!promptState && !confirmState && !state.filterActive && activeOperation) {
        handleActiveOperationKeypress(event);
        continue;
      }

      if (!promptState && !confirmState && !state.filterActive && isImmediateBrowseEvent(event)) {
        void handleBrowseKeypress(event).catch((error) => {
          busyMessage = null;
          activeOperation = null;
          state = {
            ...state,
            statusMessage: `TUI error: ${(error as Error).message}`,
          };
          render();
        });
        continue;
      }

      actionQueue = actionQueue
        .then(async () => {
          if (cleanedUp) {
            return;
          }

          if (promptState) {
            await handlePromptKeypress(event);
            return;
          }

          if (confirmState) {
            await handleConfirmKeypress(event);
            return;
          }

          if (state.filterActive) {
            await handleFilterKeypress(event);
            return;
          }

          await handleBrowseKeypress(event);
        })
        .catch((error) => {
          busyMessage = null;
          activeOperation = null;
          state = {
            ...state,
            statusMessage: `TUI error: ${(error as Error).message}`,
          };
          render();
        });
    }
  };

  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(`${ANSI.altOn}${ANSI.hideCursor}`);
  stdout.on?.("resize", onResize);
  stdin.on("data", onData);
  if (options.subscribeExternalUpdates) {
    unsubscribeExternalUpdates = options.subscribeExternalUpdates((update) => {
      actionQueue = actionQueue
        .then(async () => {
          applyExternalUpdate(update);
        })
        .catch((error) => {
          busyMessage = null;
          activeOperation = null;
          state = {
            ...state,
            statusMessage: `TUI error: ${(error as Error).message}`,
          };
          render();
        });
    });
  }

  if (typeof autoRefreshIntervalMs === "number" && autoRefreshIntervalMs > 0) {
    autoRefreshTimer = setInterval(() => {
      if (cleanedUp || activeOperation) {
        return;
      }
      requestRefresh();
    }, autoRefreshIntervalMs);
  }

  render();
  requestRefresh();

  const settlePendingWork = async () => {
    await actionQueue.catch(() => undefined);
    while (refreshPromise) {
      const pendingRefresh = refreshPromise;
      await pendingRefresh.catch(() => undefined);
      if (refreshPromise === pendingRefresh) {
        break;
      }
    }
  };

  let exitResult: AccountDashboardExitResult;
  try {
    exitResult = await exitPromise;
  } finally {
    cleanup();
    if (!forceExitRequested) {
      await settlePendingWork();
    }
  }

  return exitResult;
}
