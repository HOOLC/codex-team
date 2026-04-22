# Minimal Live-Run Suite

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
| `CLI-DAEMON-01` | core | CLI | `daemon`, `daemon restart`, `autoswitch`, `watch --no-auto-switch`, `proxy`, `run --proxy` | daemon/proxy/watch/autoswitch changes, runtime wiring, log-path changes | medium |
| `TUI-READ-01` | core | TUI | open dashboard, filter seed, arrow-key navigation, row markers, detail pane, selection styling, quit | list-display parity, layout, selection, status-line, narrow-width changes | medium |
| `TUI-ACTION-01` | core | TUI | `Enter`, `a`, `p`, `f`, `e`, `i`, `x`, `u`, `Esc`, `q`, proxy-row toggle | dashboard mutations, prompts, undo/export/import/delete flows | high |
| `CLI-AUTH-01` | extension | CLI | `add --device-auth`, `add --with-api-key` | login capture, provider detection, auth snapshot serialization | high, live auth |
| `RUN-RESUME-01` | extension | CLI | `run`, restart-and-resume wrapper, printed resume command | `codexm run` restart/resume or recoverable-session changes | high |
| `PROXY-API-01` | extension | CLI + proxy | synthetic auth wiring, `/backend-api/*`, OpenAI-compatible `/v1/*`, request logs | proxy routing, synthetic surface, unknown-route passthrough, request-log schema | high |
| `PROXY-REPLAY-01` | extension | CLI + proxy | one replay before output on retryable quota exhaustion | proxy replay lock rules, autoswitch handoff, replay diagnostics | high |
| `WATCH-EXHAUSTION-01` | extension | CLI | watch-triggered exhaustion handling and autoswitch/no-auto-switch split | watch exhaustion behavior, daemon/watch ownership, quota-signal handling | high |
| `TUI-RUN-01` | extension | TUI | `o`, `O` | dashboard-to-CLI runtime handoff changes | high |
| `DESKTOP-01` | extension | CLI + TUI | `launch`, `d`, `Shift+D`, managed relaunch warning | managed Desktop lifecycle, Desktop routing, proxy route warning changes | high, macOS |
| `DESKTOP-PROXY-SURFACE-01` | extension | CLI + Desktop | managed Desktop synthetic proxy account/quota/usage surface | Desktop proxy account-info and usage/quota surface changes | high, macOS |

## README And Usage Coverage

Use this map to decide whether a README or `skills/codexm-usage` claim needs a core case expansion or an extension case run. Keep the `core` suite minimal; add new operator promises here first, then promote only the truly cross-cutting ones into `core`.

| Claim surface | Cases |
| --- | --- |
| `current`, `current --refresh`, `list`, `list --refresh`, `list --verbose`, `usage`, `doctor`, `completion` | `CLI-READ-01` |
| account save/update/rename/protect/export/import/remove bundle flow | `CLI-ACCOUNT-01` |
| `switch`, `switch --auto --dry-run`, overlay lifecycle, isolated `run --account` | `CLI-RUNTIME-01` |
| shared daemon lifecycle, persisted feature state, `daemon restart`, `autoswitch`, `watch --no-auto-switch`, `proxy enable/disable/status/stop`, isolated `run --proxy` | `CLI-DAEMON-01` |
| dashboard list rendering, row markers (`*`, `@`, `[P]`, `[stale]`), narrow/wide layout parity, detail pane reset lines, quit/terminal restore | `TUI-READ-01` |
| dashboard mutation keys, prompts, export/import/delete/undo, proxy-row toggle and reload semantics | `TUI-ACTION-01` |
| interactive login capture and provider detection | `CLI-AUTH-01` |
| `codexm run` restart-and-resume behavior, recoverable-session resume hint | `RUN-RESUME-01` |
| proxy synthetic auth wiring, synthetic quota/account reads, `/backend-api/*`, `/v1/*`, and request-log coverage | `PROXY-API-01` |
| proxy retry-before-output on retryable quota exhaustion, replay skip/lock diagnostics | `PROXY-REPLAY-01` |
| foreground watch exhaustion response and autoswitch/no-auto-switch split | `WATCH-EXHAUSTION-01` |
| dashboard `o`/`O` runtime handoff | `TUI-RUN-01` |
| managed Desktop launch/relaunch and dashboard `d` / `Shift+D` flow | `DESKTOP-01` |
| managed Desktop synthetic proxy account/quota/usage surface and proxy-route relaunch behavior | `DESKTOP-PROXY-SURFACE-01` |

## Core Cases

### `CLI-READ-01` Read-Only Status Surfaces

- `Surface`: CLI
- `Platform`: all
- `Setup`: temp runtime with current auth; copy `~/.codex-team/accounts` if you want non-empty `list` output
- `Operation path`:
  1. `"$CODEXM_BIN" current`
  2. `"$CODEXM_BIN" current --refresh`
  3. `"$CODEXM_BIN" current --json`
  4. `"$CODEXM_BIN" list --refresh`
  5. `"$CODEXM_BIN" list --verbose`
  6. `"$CODEXM_BIN" list --json`
  7. `"$CODEXM_BIN" usage --window 7d --json`
  8. `"$CODEXM_BIN" doctor --json`
  9. `"$CODEXM_BIN" completion zsh > "$TMP_ROOT/_codexm"`
  10. `"$CODEXM_BIN" completion --accounts`
- `Validation points`:
  - every command exits `0`
  - `current`, `current --refresh`, and `list` identify the same effective current account when the temp store has a managed current account
  - `list --refresh` does not regress the normal `list` rendering contract while still queuing the background auth refresh path
  - `list --verbose` exposes the score-breakdown columns described in README/usage without corrupting the base list ordering
  - `list --json` includes stable row metadata and does not drop the synthetic `proxy` row unexpectedly
  - `usage --json` is structurally valid even when the temp runtime has no session logs; when the temp runtime has fixture logs, verify the totals are non-empty and plausible
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
  4. `"$CODEXM_BIN" daemon restart --json`
  5. start `"$CODEXM_BIN" watch --no-auto-switch` in a TTY, wait for steady state, then interrupt it cleanly
  6. `"$CODEXM_BIN" proxy enable --force --json`
  7. `"$CODEXM_BIN" proxy status --json`
  8. `"$CODEXM_BIN" run --proxy -- --version`
  9. `"$CODEXM_BIN" proxy disable --force --json`
  10. `"$CODEXM_BIN" proxy stop --json`
  11. `"$CODEXM_BIN" autoswitch disable --json`
  12. `"$CODEXM_BIN" daemon stop --json`
- `Validation points`:
  - daemon start/status/stop operate on the temp runtime only
  - `daemon restart` preserves the previous proxy/autoswitch feature state instead of clearing it
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
  - the list keeps `score`, `5H`, and `1W` visible in compact mode before dropping lower-priority columns
  - `Next reset` formatting stays aligned with `codexm list`, including the colored minute countdown inside the last hour when present
  - the detail pane shows both `5H reset` and `1W reset`, and the footer/hint text expands on wider terminals
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
  4. press `e` to export, then `i` to import the bundle
  5. press `x` to delete the imported row, then `u` to undo
  6. move to the `proxy` row, press `Enter` to enable proxy, then press `Enter` again to disable it
  7. use `Esc` to back out of prompts and `q` to quit
- `Validation points`:
  - each action updates the visible row state, detail pane, or status line without desynchronizing the list
  - export/import/delete/undo operate only on the temp runtime
  - `Esc` backs out of prompts while `q` only quits from the main list
  - current-row `f` matches the documented reload/reapply semantics for direct and proxy rows
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

### `RUN-RESUME-01` Restart-And-Resume Wrapper

- `Surface`: CLI
- `Platform`: all where `codex` is installed
- `Setup`: temp runtime with a usable `codex` binary on `PATH`; use a cloned temp `HOME` and a controllable auth replacement trigger so no live session data is touched
- `Operation path`:
  1. start `"$CODEXM_BIN" run -- --model <safe-model>` in an interactive temp session
  2. trigger one managed-account auth replacement while the wrapped CLI is active
  3. wait for the wrapper to restart the child CLI and restore the same interactive session
  4. end the wrapped session while it is still recoverable and capture the printed resume command
- `Validation points`:
  - the wrapper survives the auth replacement without losing the active interactive session
  - session/log/socket state stays inside the temp runtime and no live `~/.codex` threads are written
  - the printed resume command is present only when the session is actually recoverable
- `Cleanup`: stop the wrapped CLI and remove the temp runtime
- `Automation overlap`: unit tests cover discovery helpers, not the real restart/resume operator flow

### `PROXY-API-01` Synthetic Proxy API Surface

- `Surface`: CLI + proxy
- `Platform`: all
- `Setup`: temp runtime, shared daemon on a temp port, and either a temp upstream fixture or a safely isolated real upstream account pool
- `Operation path`:
  1. `"$CODEXM_BIN" proxy enable --force --json`
  2. query the synthetic auth/account surface through the local proxy: `/backend-api/wham/usage`, `/backend-api/wham/accounts/check`, and any account-info path currently documented for Desktop
  3. query the OpenAI-compatible surface: `/v1/models`, one buffered `/v1/responses`, and one representative `/v1/chat/completions` request
  4. send one unknown-but-supported passthrough path through the proxy and confirm the upstream response is preserved
  5. inspect the daily proxy request log and proxy error log outputs
- `Validation points`:
  - the synthetic auth/account surface stays on `proxy@codexm.local` rather than drifting to the last real upstream account
  - `/backend-api/*` and `/v1/*` requests are both routed through the proxy and authenticated as the selected upstream
  - unknown transparent passthrough routes are forwarded instead of being rejected by codexm-specific routing
  - request logs capture request metadata such as route, status, selected upstream, and `service_tier`
- `Cleanup`: disable proxy, stop the shared daemon if it was started only for the test, and remove temp logs
- `Automation overlap`: proxy/unit tests cover route handlers individually, not the end-to-end synthetic surface

### `PROXY-REPLAY-01` Proxy Replay Before Output

- `Surface`: CLI + proxy
- `Platform`: all
- `Setup`: temp runtime plus a temp upstream fixture that can force a retryable quota-exhausted failure before downstream output begins
- `Operation path`:
  1. start the shared daemon with autoswitch enabled and proxy enabled
  2. send one websocket `/v1/responses` turn or one buffered REST request that fails once with retryable quota exhaustion on the current upstream
  3. allow autoswitch to move the upstream and verify the proxy replays the request exactly once
  4. repeat with a side-effectful or already-emitting request and confirm replay is skipped instead of replaying mid-output
  5. inspect the proxy request log for replay diagnostics
- `Validation points`:
  - replay happens only before downstream output starts
  - exactly one retry occurs on the replacement upstream
  - replay skip diagnostics explain why a request stayed failed (`replay_locked`, `no_replay_candidate`, and similar)
- `Cleanup`: disable proxy/autoswitch and stop the temp daemon
- `Automation overlap`: proxy tests cover handler logic, not the operator-facing replay/autoswitch/logging loop

### `WATCH-EXHAUSTION-01` Foreground Watch Exhaustion Handling

- `Surface`: CLI
- `Platform`: all
- `Setup`: temp runtime with at least two managed accounts and a deterministic quota-exhaustion trigger for the watched current account
- `Operation path`:
  1. start `"$CODEXM_BIN" watch` in a PTY with autoswitch enabled
  2. trigger one terminal quota-exhaustion signal for the watched account
  3. verify the watch loop reports the signal and switches to the fallback account
  4. repeat with `"$CODEXM_BIN" watch --no-auto-switch"` and verify the signal is reported without switching
- `Validation points`:
  - foreground watch reacts only to actual quota-exhaustion signals, not every message
  - autoswitch-enabled watch changes the current account and reports the new target clearly
  - `--no-auto-switch` keeps observation-only behavior while still surfacing the exhaustion reason
- `Cleanup`: stop the watch PTY cleanly and remove the temp runtime
- `Automation overlap`: watch unit tests cover history math and basic process management, not the real exhaustion operator flow

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

### `DESKTOP-PROXY-SURFACE-01` Managed Desktop Synthetic Proxy Surface

- `Surface`: CLI + Desktop
- `Platform`: macOS
- `Setup`: temp runtime, managed Desktop launch through `codexm launch`, and safe inspection access through the Desktop bridge or DevTools without editing the real app bundle
- `Operation path`:
  1. enable proxy on the temp runtime and run `"$CODEXM_BIN" launch`
  2. verify the managed Desktop account surface, quota surface, and usage surface from the running app
  3. switch the saved direct/current upstream while proxy stays enabled and verify Desktop still shows the same synthetic proxy account surface
  4. toggle proxy off or on again and confirm the relaunch warning is shown when the running Desktop route no longer matches the saved route
- `Validation points`:
  - Desktop account/quota/usage reads stay on the synthetic proxy account instead of following the last real upstream account
  - the synthetic surface updates after `switch`-driven account refreshes without mutating live thread history
  - proxy route changes warn for relaunch instead of pretending a hot route swap already happened
- `Cleanup`: close the managed Desktop instance and remove temp managed state
- `Automation overlap`: launcher/bridge tests cover the programmatic pieces, not the real managed Desktop operator loop
