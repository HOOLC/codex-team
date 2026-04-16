const ANSI = {
  altOn: "\u001B[?1049h",
  altOff: "\u001B[?1049l",
  bold: "\u001B[1m",
  clear: "\u001B[2J",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  hideCursor: "\u001B[?25l",
  home: "\u001B[H",
  inverse: "\u001B[7m",
  red: "\u001B[31m",
  reset: "\u001B[0m",
  showCursor: "\u001B[?25h",
  yellow: "\u001B[33m",
} as const;

const PANEL_MIN_WIDTH = 56;
const PANEL_MIN_HEIGHT = 16;
const WIDE_LAYOUT_MIN_WIDTH = 90;
const PANE_GAP = " | ";

export interface AccountDashboardAccount {
  name: string;
  planLabel: string;
  identityLabel: string;
  availabilityLabel: string;
  current: boolean;
  score: number | null;
  scoreLabel: string;
  etaLabel: string;
  nextResetLabel: string;
  fiveHourLabel: string;
  oneWeekLabel: string;
  detailLines: string[];
}

export interface AccountDashboardSnapshot {
  currentStatusLine: string;
  summaryLine: string;
  poolLine: string;
  warnings: string[];
  failures: Array<{ name: string; error: string }>;
  accounts: AccountDashboardAccount[];
}

export interface AccountDashboardState {
  selected: number;
  scrollTop: number;
  query: string;
  filterActive: boolean;
  cursor: number;
  statusMessage: string | null;
}

export interface RenderAccountDashboardScreenOptions {
  snapshot: AccountDashboardSnapshot;
  state: AccountDashboardState;
  width: number;
  height: number;
  busyMessage?: string | null;
}

export interface RunAccountDashboardTuiOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  initialQuery?: string;
  loadSnapshot: () => Promise<AccountDashboardSnapshot>;
  switchAccount: (name: string) => Promise<{
    statusMessage?: string;
    warningMessages?: string[];
  }>;
}

interface PanelFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DashboardLayout {
  frame: PanelFrame;
  innerWidth: number;
  innerHeight: number;
  bodyHeight: number;
  wide: boolean;
  listWidth: number;
  detailWidth: number;
  listRows: number;
  detailRows: number;
}

interface FilteredAccounts {
  all: AccountDashboardAccount[];
  selected: AccountDashboardAccount | null;
}

interface InputEvent {
  value: string;
  name: string;
  ctrl?: boolean;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

function repeat(char: string, width: number): string {
  return Array.from({ length: Math.max(0, width) }, () => char).join("");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width <= 2) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 2)}..`;
}

function padEndVisible(value: string, width: number): string {
  return `${value}${repeat(" ", Math.max(0, width - visibleWidth(value)))}`;
}

function padStartVisible(value: string, width: number): string {
  return `${repeat(" ", Math.max(0, width - visibleWidth(value)))}${value}`;
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

function emphasize(value: string): string {
  return `${ANSI.bold}${value}${ANSI.reset}`;
}

function invert(value: string): string {
  return `${ANSI.inverse}${value}${ANSI.reset}`;
}

function formatStatusLine(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  filteredCount: number,
  busyMessage: string | null | undefined,
): string {
  if (busyMessage) {
    return busyMessage;
  }
  if (state.statusMessage) {
    return state.statusMessage;
  }
  if (snapshot.failures.length > 0) {
    const failure = snapshot.failures[0];
    return `Failure: ${failure.name}: ${failure.error}`;
  }
  if (snapshot.warnings.length > 0) {
    return `Warning: ${snapshot.warnings[0]}`;
  }
  if (snapshot.accounts.length === 0) {
    return "Ready to add or save an account.";
  }
  return `Showing ${filteredCount}/${snapshot.accounts.length} accounts.`;
}

function computePanelFrame(width: number, height: number): PanelFrame {
  let horizontalMargin = width >= 120 ? 2 : width >= 96 ? 1 : 0;
  let verticalMargin = height >= 28 ? 1 : 0;

  while (width - (horizontalMargin * 2) < PANEL_MIN_WIDTH && horizontalMargin > 0) {
    horizontalMargin -= 1;
  }
  while (height - (verticalMargin * 2) < PANEL_MIN_HEIGHT && verticalMargin > 0) {
    verticalMargin -= 1;
  }

  return {
    x: horizontalMargin,
    y: verticalMargin,
    width: Math.max(PANEL_MIN_WIDTH, width - (horizontalMargin * 2)),
    height: Math.max(PANEL_MIN_HEIGHT, height - (verticalMargin * 2)),
  };
}

function getLayout(width: number, height: number, accountCount: number): DashboardLayout {
  const frame = computePanelFrame(width, height);
  const innerWidth = Math.max(1, frame.width - 2);
  const innerHeight = Math.max(1, frame.height - 2);
  const bodyHeight = Math.max(4, innerHeight - 9);
  const wide = innerWidth >= WIDE_LAYOUT_MIN_WIDTH;

  if (wide) {
    const availableWidth = Math.max(1, innerWidth - PANE_GAP.length);
    const listWidth = Math.max(34, Math.min(Math.floor(availableWidth * 0.48), availableWidth - 28));
    const detailWidth = Math.max(20, innerWidth - listWidth - PANE_GAP.length);
    return {
      frame,
      innerWidth,
      innerHeight,
      bodyHeight,
      wide,
      listWidth,
      detailWidth,
      listRows: bodyHeight,
      detailRows: bodyHeight,
    };
  }

  const listRows = Math.max(5, Math.min(Math.max(5, accountCount + 1), Math.floor(bodyHeight * 0.45)));
  return {
    frame,
    innerWidth,
    innerHeight,
    bodyHeight,
    wide,
    listWidth: innerWidth,
    detailWidth: innerWidth,
    listRows,
    detailRows: Math.max(3, bodyHeight - listRows),
  };
}

function fitLines(lines: string[], height: number): string[] {
  const trimmed = lines.slice(0, Math.max(0, height));
  while (trimmed.length < height) {
    trimmed.push("");
  }
  return trimmed;
}

function renderFramedScreen(width: number, height: number, layout: DashboardLayout, lines: string[]): string {
  const topBorder = `+${repeat("-", layout.innerWidth)}+`;
  const framed = [
    topBorder,
    ...fitLines(lines, layout.innerHeight).map((line) => `|${padEndVisible(truncate(line, layout.innerWidth), layout.innerWidth)}|`),
    topBorder,
  ];
  return [
    ...Array.from({ length: layout.frame.y }, () => ""),
    ...framed.map((line) => `${repeat(" ", layout.frame.x)}${line}`),
  ].slice(0, height).join("\n");
}

function getFilteredAccounts(snapshot: AccountDashboardSnapshot, query: string): AccountDashboardAccount[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === "") {
    return snapshot.accounts;
  }

  return snapshot.accounts.filter((account) => {
    const haystacks = [
      account.name,
      account.planLabel,
      account.identityLabel,
      account.availabilityLabel,
      ...account.detailLines,
    ].map((value) => value.toLowerCase());
    return haystacks.some((value) => value.includes(normalizedQuery));
  });
}

function formatInteractiveQuery(query: string, cursor: number, active: boolean): string {
  if (!active) {
    return query;
  }
  const safeCursor = clamp(cursor, 0, query.length);
  return `${query.slice(0, safeCursor)}_${query.slice(safeCursor)}`;
}

function normalizeStateForViewport(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  width: number,
  height: number,
): { state: AccountDashboardState; filtered: FilteredAccounts } {
  const filteredAccounts = getFilteredAccounts(snapshot, state.query);
  const layout = getLayout(width, height, filteredAccounts.length);
  const visibleRows = Math.max(1, layout.listRows - 1);
  const nextState = {
    ...state,
    cursor: clamp(state.cursor, 0, state.query.length),
  };

  if (filteredAccounts.length === 0) {
    nextState.selected = 0;
    nextState.scrollTop = 0;
  } else {
    nextState.selected = clamp(nextState.selected, 0, filteredAccounts.length - 1);
    const maxScrollTop = Math.max(0, filteredAccounts.length - visibleRows);
    nextState.scrollTop = clamp(nextState.scrollTop, 0, maxScrollTop);
    if (nextState.selected < nextState.scrollTop) {
      nextState.scrollTop = nextState.selected;
    }
    if (nextState.selected >= nextState.scrollTop + visibleRows) {
      nextState.scrollTop = nextState.selected - visibleRows + 1;
    }
  }

  return {
    state: nextState,
    filtered: {
      all: filteredAccounts,
      selected: filteredAccounts[nextState.selected] ?? null,
    },
  };
}

function renderListHeader(width: number): string {
  const fixedWidth = 2 + 1 + 1 + 1 + 6 + 1 + 5 + 1 + 6 + 1 + 11;
  const nameWidth = Math.max(8, width - fixedWidth);
  return [
    "  ",
    padEndVisible("NAME", nameWidth),
    " ",
    padEndVisible("PLAN", 6),
    " ",
    padStartVisible("SCORE", 5),
    " ",
    padStartVisible("ETA", 6),
    " ",
    padEndVisible("RESET", 11),
  ].join("");
}

function renderListRow(account: AccountDashboardAccount, selected: boolean, width: number): string {
  const fixedWidth = 2 + 1 + 1 + 1 + 6 + 1 + 5 + 1 + 6 + 1 + 11;
  const nameWidth = Math.max(8, width - fixedWidth);
  const line = [
    selected ? ">" : " ",
    account.current ? "*" : " ",
    " ",
    padEndVisible(truncate(account.name, nameWidth), nameWidth),
    " ",
    padEndVisible(truncate(account.planLabel, 6), 6),
    " ",
    padStartVisible(account.scoreLabel, 5),
    " ",
    padStartVisible(account.etaLabel, 6),
    " ",
    padEndVisible(truncate(account.nextResetLabel, 11), 11),
  ].join("");

  if (selected) {
    return invert(line);
  }
  if (account.availabilityLabel === "unavailable") {
    return color(line, "red");
  }
  if (account.current) {
    return color(line, "green");
  }
  return line;
}

function renderListLines(
  filteredAccounts: AccountDashboardAccount[],
  state: AccountDashboardState,
  width: number,
  height: number,
): string[] {
  if (filteredAccounts.length === 0) {
    return fitLines([renderListHeader(width)], height);
  }

  const visibleRows = Math.max(1, height - 1);
  const start = clamp(state.scrollTop, 0, Math.max(0, filteredAccounts.length - visibleRows));
  const visibleAccounts = filteredAccounts.slice(start, start + visibleRows);
  return fitLines(
    [
      renderListHeader(width),
      ...visibleAccounts.map((account, index) =>
        renderListRow(account, start + index === state.selected, width),
      ),
    ],
    height,
  );
}

function renderDetailLines(
  snapshot: AccountDashboardSnapshot,
  selectedAccount: AccountDashboardAccount | null,
  width: number,
  height: number,
): string[] {
  if (!selectedAccount) {
    const lines = snapshot.accounts.length === 0
      ? [
          "No saved accounts.",
          "",
          'Use "codexm add <name>" or "codexm save <name>" to create one.',
        ]
      : [
          "No accounts match current filter.",
          "",
          "Adjust the filter or press Esc to leave filter mode.",
        ];
    return fitLines(lines, height);
  }

  const lines = [
    emphasize(selectedAccount.current ? `* ${selectedAccount.name}` : selectedAccount.name),
    `Identity: ${selectedAccount.identityLabel}`,
    `Plan: ${selectedAccount.planLabel}`,
    `Availability: ${selectedAccount.availabilityLabel}`,
    `Score: ${selectedAccount.scoreLabel}`,
    `ETA: ${selectedAccount.etaLabel}`,
    `5H used: ${selectedAccount.fiveHourLabel}`,
    `1W used: ${selectedAccount.oneWeekLabel}`,
    `Next reset: ${selectedAccount.nextResetLabel}`,
  ];

  if (snapshot.failures.length > 0) {
    lines.push("", emphasize("Refresh failures"));
    for (const failure of snapshot.failures.slice(0, 2)) {
      lines.push(truncate(`${failure.name}: ${failure.error}`, width));
    }
  }

  if (snapshot.warnings.length > 0) {
    lines.push("", emphasize("Warnings"));
    for (const warning of snapshot.warnings.slice(0, 2)) {
      lines.push(truncate(warning, width));
    }
  }

  return fitLines(lines.map((line) => truncate(line, width)), height);
}

function renderBodyLines(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  width: number,
  height: number,
): string[] {
  const normalized = normalizeStateForViewport(snapshot, state, width, height + 9);
  const layout = getLayout(width, height + 9, normalized.filtered.all.length);

  if (layout.wide) {
    const listLines = renderListLines(normalized.filtered.all, normalized.state, layout.listWidth, layout.listRows);
    const detailLines = renderDetailLines(snapshot, normalized.filtered.selected, layout.detailWidth, layout.detailRows);
    return fitLines(
      Array.from({ length: layout.bodyHeight }, (_, index) =>
        `${padEndVisible(listLines[index] ?? "", layout.listWidth)}${PANE_GAP}${padEndVisible(detailLines[index] ?? "", layout.detailWidth)}`,
      ),
      height,
    );
  }

  const listLines = renderListLines(normalized.filtered.all, normalized.state, layout.listWidth, layout.listRows);
  const detailLines = renderDetailLines(snapshot, normalized.filtered.selected, layout.detailWidth, layout.detailRows);
  return fitLines([...listLines, ...detailLines], height);
}

function renderDivider(width: number): string {
  return repeat("-", width);
}

function renderHintBar(width: number): string {
  const hint = "j/k move  / filter  Enter switch  r refresh  q quit";
  return truncate(color(hint, "dim"), width);
}

function renderFilterLine(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  filteredCount: number,
  width: number,
): string {
  const query = state.query === "" && !state.filterActive
    ? "(press / to filter)"
    : formatInteractiveQuery(state.query, state.cursor, state.filterActive);
  return truncate(`filter: ${query} | showing ${filteredCount}/${snapshot.accounts.length}`, width);
}

export function createInitialAccountDashboardState(initialQuery = ""): AccountDashboardState {
  return {
    selected: 0,
    scrollTop: 0,
    query: initialQuery,
    filterActive: false,
    cursor: initialQuery.length,
    statusMessage: null,
  };
}

export function renderAccountDashboardScreen(
  options: RenderAccountDashboardScreenOptions,
): string {
  const layout = getLayout(options.width, options.height, options.snapshot.accounts.length);
  const normalized = normalizeStateForViewport(
    options.snapshot,
    options.state,
    options.width,
    options.height,
  );
  const filteredCount = normalized.filtered.all.length;
  const lines = [
    `${emphasize(color("codexm", "cyan"))}  ${color("account dashboard", "dim")}`,
    truncate(options.snapshot.currentStatusLine, layout.innerWidth),
    truncate(options.snapshot.summaryLine, layout.innerWidth),
    truncate(options.snapshot.poolLine, layout.innerWidth),
    renderDivider(layout.innerWidth),
    ...renderBodyLines(options.snapshot, normalized.state, layout.innerWidth, layout.bodyHeight),
    renderDivider(layout.innerWidth),
    renderFilterLine(options.snapshot, normalized.state, filteredCount, layout.innerWidth),
    truncate(
      formatStatusLine(options.snapshot, normalized.state, filteredCount, options.busyMessage),
      layout.innerWidth,
    ),
    renderHintBar(layout.innerWidth),
  ];

  return renderFramedScreen(options.width, options.height, layout, lines);
}

function resolvePreferredSelection(
  snapshot: AccountDashboardSnapshot,
  state: AccountDashboardState,
  preferredName: string | null,
): AccountDashboardState {
  const filteredAccounts = getFilteredAccounts(snapshot, state.query);
  if (filteredAccounts.length === 0) {
    return {
      ...state,
      selected: 0,
      scrollTop: 0,
    };
  }

  const selectedName = preferredName
    ?? filteredAccounts[state.selected]?.name
    ?? filteredAccounts.find((account) => account.current)?.name
    ?? filteredAccounts[0]?.name
    ?? null;
  const selectedIndex = selectedName
    ? filteredAccounts.findIndex((account) => account.name === selectedName)
    : 0;

  return {
    ...state,
    selected: selectedIndex >= 0 ? selectedIndex : 0,
  };
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
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  let snapshot: AccountDashboardSnapshot = {
    currentStatusLine: "Current auth: missing",
    summaryLine: "Accounts: 0/0 usable | blocked: 1W 0, 5H 0",
    poolLine: "Available: bottleneck - | 5H->1W - | 1W - (plus 1W)",
    warnings: [],
    failures: [],
    accounts: [],
  };
  let state = createInitialAccountDashboardState(options.initialQuery ?? "");
  let busyMessage: string | null = "Refreshing accounts...";
  let cleanedUp = false;
  let actionQueue = Promise.resolve();
  let inputBuffer = "";
  const previousRawMode = stdin.isRaw === true;

  const render = () => {
    stdout.write(
      `${ANSI.clear}${ANSI.home}${renderAccountDashboardScreen({
        snapshot,
        state,
        width: stdout.columns ?? 80,
        height: stdout.rows ?? 24,
        busyMessage,
      })}`,
    );
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    stdin.off("data", onData);
    stdout.off?.("resize", onResize);
    stdin.setRawMode?.(previousRawMode);
    stdin.pause();
    stdout.write(`${ANSI.showCursor}${ANSI.altOff}`);
  };

  const refreshSnapshot = async (preferredName: string | null = null, preserveStatus = false) => {
    busyMessage = "Refreshing accounts...";
    render();
    const priorStatus = state.statusMessage;
    try {
      snapshot = await options.loadSnapshot();
      state = resolvePreferredSelection(snapshot, state, preferredName);
      if (!preserveStatus) {
        state.statusMessage = null;
      } else {
        state.statusMessage = priorStatus;
      }
    } catch (error) {
      state.statusMessage = `Refresh failed: ${(error as Error).message}`;
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

  const handleBrowseKeypress = async (event: InputEvent): Promise<boolean> => {
    if ((event.ctrl && event.name === "c") || event.name === "escape" || event.name === "q") {
      return true;
    }
    if (event.name === "up" || event.name === "k") {
      moveSelection(-1);
      render();
      return false;
    }
    if (event.name === "down" || event.name === "j") {
      moveSelection(1);
      render();
      return false;
    }
    if (event.name === "home" || event.value === "g") {
      state = {
        ...state,
        selected: 0,
        scrollTop: 0,
      };
      render();
      return false;
    }
    if (event.name === "end" || event.value === "G") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      state = {
        ...state,
        selected: Math.max(0, filtered.length - 1),
      };
      render();
      return false;
    }
    if (event.value === "/") {
      state = {
        ...state,
        filterActive: true,
        cursor: state.query.length,
      };
      render();
      return false;
    }
    if (event.value === "r") {
      await refreshSnapshot();
      return false;
    }
    if (event.name === "enter") {
      const filtered = getFilteredAccounts(snapshot, state.query);
      const selected = filtered[state.selected] ?? null;
      if (!selected) {
        return false;
      }
      if (selected.current) {
        state = {
          ...state,
          statusMessage: `"${selected.name}" is already current.`,
        };
        render();
        return false;
      }
      busyMessage = `Switching to "${selected.name}"...`;
      render();
      try {
        const result = await options.switchAccount(selected.name);
        state = {
          ...state,
          statusMessage: result.warningMessages?.length
            ? `${result.statusMessage ?? `Switched to "${selected.name}".`} Warning: ${result.warningMessages[0]}`
            : (result.statusMessage ?? `Switched to "${selected.name}".`),
        };
        await refreshSnapshot(selected.name, true);
      } catch (error) {
        busyMessage = null;
        state = {
          ...state,
          statusMessage: `Switch failed: ${(error as Error).message}`,
        };
        render();
      }
      return false;
    }
    return false;
  };

  const onData = (chunk: Buffer | string) => {
    inputBuffer += chunk.toString();
    const { events, rest } = consumeInputBuffer(inputBuffer);
    inputBuffer = rest;
    for (const event of events) {
      actionQueue = actionQueue
        .then(async () => {
          if (cleanedUp) {
            return;
          }
          const shouldExit = state.filterActive
            ? await (async () => {
                await handleFilterKeypress(event);
                return false;
              })()
            : await handleBrowseKeypress(event);
          if (shouldExit) {
            cleanup();
          }
        })
        .catch((error) => {
          busyMessage = null;
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

  render();

  try {
    await refreshSnapshot();
    return await new Promise<number>((resolve) => {
      const poll = () => {
        if (cleanedUp) {
          resolve(0);
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
  } finally {
    cleanup();
  }
}
