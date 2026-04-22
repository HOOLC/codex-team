# Minimal Real Self-Test Suite

This suite defines the smallest durable set of replayable cases that covers the main `codexm` operator surfaces. Run the smallest relevant subset before pushing or updating a PR; run the full `core` suite for cross-cutting UX or runtime changes.

Use the built artifact:

```bash
pnpm build
CODEXM_BIN="node $(pwd)/dist/cli.cjs"
```

If the temp store has fewer than two managed accounts, bootstrap aliases in the temp runtime before running the suite:

```bash
$CODEXM_BIN save selftest-main --force
$CODEXM_BIN save selftest-peer --force
```

If both aliases point at the same auth, that is still acceptable for structural flows such as rename, protect, switch, export/import, overlay, proxy wiring, and TUI navigation.

## Coverage Map

| ID | Tier | Surface | Feature coverage | Run when | Cost |
| --- | --- | --- | --- | --- | --- |
| `CLI-READ-01` | core | CLI | `current`, `list`, `usage`, `doctor`, `completion` | inspection output, list layout, usage summary, help/completion changes | low |
| `CLI-ACCOUNT-01` | core | CLI | `save`, `update`, `rename`, `protect`, `unprotect`, `export`, `inspect`, `import`, `remove` | account lifecycle, share bundle, account flags, JSON output changes | medium |
| `CLI-RUNTIME-01` | core | CLI | `switch`, `switch --auto --dry-run`, `overlay create/delete/gc`, `run --account` | switching, isolated runtime, overlay, resume/run wrapper changes | medium |
| `CLI-DAEMON-01` | core | CLI | `daemon`, `autoswitch`, `watch --no-auto-switch`, `proxy`, `run --proxy` | daemon/proxy/watch/autoswitch changes, runtime wiring, log-path changes | medium |
| `TUI-READ-01` | core | TUI | open dashboard, filter seed, arrow-key navigation, row markers, detail pane, selection styling, quit | list-display parity, layout, selection, status-line, narrow-width changes | medium |
| `TUI-ACTION-01` | core | TUI | `Enter`, `a`, `p`, `f`, `e`, `E`, `i`, `x`, `u`, `Esc`, `q`, proxy-row toggle | dashboard mutations, prompts, undo/export/import/delete flows | high |
| `CLI-AUTH-01` | extension | CLI | `add --device-auth`, `add --with-api-key` | login capture, provider detection, auth snapshot serialization | high, live auth |
| `TUI-RUN-01` | extension | TUI | `o`, `O` | dashboard-to-CLI runtime handoff changes | high |
| `DESKTOP-01` | extension | CLI + TUI | `launch`, `d`, `Shift+D`, managed relaunch warning | managed Desktop lifecycle, Desktop routing, proxy route warning changes | high, macOS |

## Core Cases

### `CLI-READ-01` Read-Only Status Surfaces

- `Surface`: CLI
- `Platform`: all
- `Setup`: temp runtime with current auth; copy `~/.codex-team/accounts` if you want non-empty `list` output
- `Operation path`:
  1. `"$CODEXM_BIN" current`
  2. `"$CODEXM_BIN" current --json`
  3. `"$CODEXM_BIN" list --json`
  4. `"$CODEXM_BIN" usage --window 7d --json`
  5. `"$CODEXM_BIN" doctor --json`
  6. `"$CODEXM_BIN" completion zsh > "$TMP_ROOT/_codexm"`
  7. `"$CODEXM_BIN" completion --accounts`
- `Validation points`:
  - every command exits `0`
  - `current` and `list` identify the same effective current account when the temp store has a managed current account
  - `list --json` includes stable row metadata and does not drop the synthetic `proxy` row unexpectedly
  - `usage --json` is structurally valid even when the temp runtime has no session logs
  - `doctor --json` reports clear status rather than crashing on missing optional runtime pieces
  - completion output includes dynamic account lookup and shell-specific subcommands
- `Cleanup`: remove `"$TMP_ROOT/_codexm"` and the temp runtime
- `Automation overlap`: `tests/cli-read-commands.test.ts`, quota/list presentation tests

### `CLI-ACCOUNT-01` Snapshot Lifecycle And Share Bundle Flow

- `Surface`: CLI
- `Platform`: all
- `Setup`: temp runtime with at least one valid current auth and no copied managed account snapshots for that same identity
- `Operation path`:
  1. `"$CODEXM_BIN" save selftest-main --force --json`
  2. `"$CODEXM_BIN" update --json`
  3. `"$CODEXM_BIN" rename selftest-main selftest-main-renamed --json`
  4. `"$CODEXM_BIN" protect selftest-main-renamed --json`
  5. `"$CODEXM_BIN" unprotect selftest-main-renamed --json`
  6. `"$CODEXM_BIN" export selftest-main-renamed --output "$TMP_ROOT/share.json" --force --json`
  7. `"$CODEXM_BIN" inspect "$TMP_ROOT/share.json" --json`
  8. `"$CODEXM_BIN" remove selftest-main-renamed --yes --json`
  9. `"$CODEXM_BIN" import "$TMP_ROOT/share.json" --name selftest-imported --force --json`
  10. `"$CODEXM_BIN" remove selftest-imported --yes --json`
- `Validation points`:
  - exported bundle is readable and inspectable before import
  - removing the original snapshot before import avoids the expected duplicate-identity rejection
  - import saves the named account but does not silently change the current direct auth
  - protect and unprotect visibly change eligibility state
  - remove deletes only the target snapshot from the temp store
- `Cleanup`: remove imported aliases and `"$TMP_ROOT/share.json"`
- `Automation overlap`: account-management tests, share-bundle tests

### `CLI-RUNTIME-01` Switching, Overlay, And Isolated Run

- `Surface`: CLI
- `Platform`: all
- `Setup`: temp runtime with at least two managed aliases plus a usable `codex` binary on `PATH`; if needed create `selftest-main` and `selftest-peer`. If the cloned current auth is synthetic `proxy`, switch to a direct managed alias first.
- `Operation path`:
  1. `"$CODEXM_BIN" switch selftest-main --json`
  2. `"$CODEXM_BIN" switch --auto --dry-run --json`
  3. `"$CODEXM_BIN" overlay create selftest-main --owner-pid 999999 --json`
  4. `"$CODEXM_BIN" overlay gc --json`
  5. `"$CODEXM_BIN" overlay create selftest-main --owner-pid $$ --json`
  6. `"$CODEXM_BIN" run --account selftest-main -- --version`
  7. `"$CODEXM_BIN" overlay delete <live-overlay-path-or-run-id> --json`
- `Validation points`:
  - `switch` updates current direct auth inside the temp runtime only
  - dry-run auto-switch prints a deterministic selection or clear no-op reason
  - stale-owner overlay gc removes the temp overlay created for the dead owner pid
  - live overlay create returns an isolated `CODEX_HOME` path under `.codex-team/run-overlays`
  - `run --account` executes against the isolated overlay rather than the live temp `CODEX_HOME`
  - overlay delete removes the live overlay and leaves no stale metadata behind
- `Cleanup`: delete remaining overlays under the temp runtime
- `Automation overlap`: `tests/overlay-commands.test.ts`, switching tests, CLI read-command run tests

### `CLI-DAEMON-01` Daemon, Watch, Proxy, And Proxy Run

- `Surface`: CLI
- `Platform`: all
- `Setup`: temp runtime with current auth and managed accounts; set `CODEXM_PROXY_PORT` to a non-default temp port
- `Operation path`:
  1. `"$CODEXM_BIN" daemon start --json`
  2. `"$CODEXM_BIN" autoswitch enable --json`
  3. `"$CODEXM_BIN" autoswitch status --json`
  4. start `"$CODEXM_BIN" watch --no-auto-switch` in a TTY, wait for steady state, then interrupt it cleanly
  5. `"$CODEXM_BIN" proxy enable --force --json`
  6. `"$CODEXM_BIN" proxy status --json`
  7. `"$CODEXM_BIN" run --proxy -- --version`
  8. `"$CODEXM_BIN" proxy disable --force --json`
  9. `"$CODEXM_BIN" proxy stop --json`
  10. `"$CODEXM_BIN" autoswitch disable --json`
  11. `"$CODEXM_BIN" daemon stop --json`
- `Validation points`:
  - daemon start/status/stop operate on the temp runtime only
  - watch enters a readable steady state and exits promptly on interrupt; on macOS without a managed Desktop session, `No managed Codex Desktop session — entering CLI watch mode` is an acceptable steady-state message
  - proxy enable rewrites temp auth/config and proxy disable restores direct runtime wiring
  - proxy disable does not falsely claim the listener stopped; `proxy stop` or `daemon stop` is what tears it down
  - `run --proxy` uses an isolated proxy overlay and exits successfully
  - temp logs and sockets stay inside the temp runtime
- `Cleanup`: confirm no temp daemon/watch/proxy pid remains and remove temp logs
- `Automation overlap`: proxy tests, daemon tests, watch tests

### `TUI-READ-01` Dashboard Render, Markers, And Navigation

- `Surface`: TUI
- `Platform`: all
- `Setup`: temp runtime with at least one managed account; run inside a PTY
- `Operation path`:
  1. launch `"$CODEXM_BIN"` or `"$CODEXM_BIN" tui`
  2. verify initial rows and status line
  3. move selection with `Down` and `Up`
  4. relaunch with an initial query, for example `"$CODEXM_BIN" tui plus`
  5. quit with `q`
- `Validation points`:
  - selection highlight stays visually consistent across direct, protected, and `proxy` rows
  - row markers such as `*`, `@`, `[P]`, and `[stale]` match CLI semantics when applicable
  - detail pane and footer update when the selected row changes
  - quitting restores the terminal from raw mode and alt-screen cleanly
- `Cleanup`: ensure the PTY session closes and the terminal state is restored
- `Automation overlap`: `tests/tui.test.ts`, list/TUI display tests

### `TUI-ACTION-01` Dashboard Mutation Flow

- `Surface`: TUI
- `Platform`: all
- `Setup`: temp runtime with at least two managed accounts plus one exported bundle path for import
- `Operation path`:
  1. on a direct row, press `p`, then press `p` again to restore state
  2. press `a` to toggle autoswitch and press `a` again to restore state
  3. press `f` on the current row and confirm the status text is meaningful
  4. press `e` or `E` to export, then `i` to import the bundle
  5. press `x` to delete the imported row, then `u` to undo
  6. move to the `proxy` row, press `Enter` to enable proxy, then press `Enter` again to disable it
  7. use `Esc` to back out of prompts and `q` to quit
- `Validation points`:
  - each action updates the visible row state, detail pane, or status line without desynchronizing the list
  - export/import/delete/undo operate only on the temp runtime
  - `proxy` row stays visible before, during, and after proxy toggles
  - autoswitch and protection toggles use the same semantics as the CLI
- `Cleanup`: remove temp bundle files and confirm proxy/autoswitch are back to their starting state
- `Automation overlap`: `tests/tui.test.ts`, share-bundle tests, proxy tests

## Extension Cases

### `CLI-AUTH-01` Login Capture Flows

- `Surface`: CLI
- `Platform`: all
- `Setup`: temp runtime, live auth path available, human operator ready to complete login or paste an API key
- `Operation path`:
  1. `"$CODEXM_BIN" add selftest-device --device-auth`
  2. `"$CODEXM_BIN" add selftest-key --with-api-key`
- `Validation points`:
  - new snapshots are saved under the expected local names
  - provider identity, account id, and plan metadata are captured correctly
  - no live runtime files outside the temp root are touched
- `Cleanup`: remove temp snapshots and revoke any temporary key used for the test
- `Automation overlap`: account-management command tests cover non-interactive logic only

### `TUI-RUN-01` Dashboard Runtime Handoff

- `Surface`: TUI
- `Platform`: all where `codex` is installed
- `Setup`: temp runtime, PTY, and a usable `codex` binary on `PATH`
- `Operation path`:
  1. open the dashboard
  2. press `o` and verify the direct runtime handoff starts, then return to the dashboard
  3. press `O` and verify the isolated-account handoff starts, then return to the dashboard
- `Validation points`:
  - the dashboard restores cleanly after each handoff
  - isolated runs do not pollute the temp direct runtime with overlay-specific state
  - exit and interrupt paths return control to the dashboard instead of hanging the terminal
- `Cleanup`: remove any temp overlays created by the test
- `Automation overlap`: runner and overlay tests cover most logic but not the interactive dashboard handoff

### `DESKTOP-01` Managed Desktop Lifecycle

- `Surface`: CLI + TUI
- `Platform`: macOS
- `Setup`: temp runtime plus a safe environment for launching or relaunching Codex Desktop
- `Operation path`:
  1. `"$CODEXM_BIN" launch`
  2. enable proxy or disable proxy and confirm the relaunch warning is context-correct
  3. open the dashboard and exercise `d` and `Shift+D`
- `Validation points`:
  - managed Desktop state is written under the temp runtime
  - Desktop route warnings reflect the actual launch-time backend route instead of stale state
  - relaunch waits or warns in the right situations and leaves the temp runtime consistent
- `Cleanup`: stop temp daemon state and close the managed Desktop instance if it was started only for the test
- `Automation overlap`: Desktop launcher and switching tests cover the programmatic pieces, not the end-to-end operator flow
