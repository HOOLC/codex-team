# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` provides the `codexm` CLI for managing multiple Codex ChatGPT login snapshots on one machine.

Use it when you regularly switch between multiple Codex accounts and want a simpler way to:

- save named account snapshots
- switch the active `~/.codex/auth.json`
- check quota usage across saved accounts
- export and import fully trusted share bundles without re-login
- automatically switch and restart when the current account is exhausted
- expose a local proxy account for Codex and OpenAI-compatible tools

## Platform support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS    | ✅ Full | Desktop launch, watch, and all CLI commands |
| Linux    | ✅ Full | CLI-only mode; Desktop commands gracefully degrade |
| WSL      | ✅ Full | WSL-aware browser opening; CLI-only mode |

## Install

```bash
npm install -g codex-team
```

After install, use the `codexm` command.

## Optional Agent Skill

This repo also maintains an optional agent skill for coding agents that can install `SKILL.md` bundles from GitHub. The skill is not required to run `codexm`; the npm package ships only the CLI runtime and library entrypoints.

Any compatible coding agent can install the same `skills/codexm-usage` path from GitHub. If you are using Codex's built-in GitHub skill installer, pin the skill to the same release tag as the CLI you installed:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo HOOLC/codex-team \
  --path skills/codexm-usage \
  --ref v0.0.20
```

Replace `--ref` with the release tag that matches your installed CLI version. Restart or reload your coding agent after installing the skill if it caches available skills.

## Quick start

### 1. Save a couple of accounts and inspect them

```bash
codexm add plus1
codexm add team1
codexm list
codexm usage
```

Use `codexm list` for the account overview and `codexm usage` for local token usage plus estimated cost from session logs.

### 2. Open the dashboard

```bash
codexm
```

Inside the dashboard:

- `Enter`: switch the selected direct account, or toggle proxy on/off when the `proxy` row is selected
- `a`: enable or disable daemon-backed autoswitch
- `f`: reload the current account or force-switch
- `p`: toggle whether the selected account can be chosen as an auto-switch target
- `o`: run `codex` in the current terminal, then return to the dashboard when it exits
- `O`: run `codex` with an isolated managed snapshot, then return to the dashboard when it exits
- `d`: open or focus Codex Desktop without leaving the dashboard
- `Shift+D`: relaunch Codex Desktop for the selected account; when an unmanaged Desktop instance is already running, confirm before forcing it closed

### 3. Keep working automatically

macOS + Codex Desktop:

```bash
codexm launch
codexm autoswitch enable
```

Linux / WSL + Codex CLI:

```bash
codexm watch
```

In another terminal:

```bash
codexm run -- --model o3
```

`codexm launch` starts Desktop and ensures the shared baseline daemon is running. `codexm autoswitch enable` turns on daemon-backed background auto-switching for managed Desktop and proxy flows. `codexm watch` remains the foreground quota monitor, and `codexm run` wraps the `codex` CLI, survives repeated `~/.codex/auth.json` replacements, and auto-resumes the active interactive session after an account-triggered restart. If you end `codexm run` manually while a session is recoverable, it prints the resume command to use.

### 4. Use the local proxy account

```bash
codexm proxy enable
codexm proxy status
codexm run --proxy -- --model o3
codexm proxy disable
```

`codexm proxy enable` starts a local daemon on `127.0.0.1`, installs a synthetic ChatGPT auth (`proxy@codexm.local`), and points local auth/config at the proxy. The live config now keeps the built-in provider identity and only rewrites transport URLs, so proxy and non-proxy sessions continue sharing the same live thread history. The dashboard and `codexm list` always show a `proxy` row whose quota is aggregated from non-protected, auto-switch-eligible accounts that still have quota snapshots, including exhausted accounts so a fully drained pool still shows `0%` instead of disappearing; protected accounts are excluded. Managed Codex Desktop usage/account reads now stay on the same synthetic proxy account surface, so Desktop quota UI no longer needs to follow whichever real upstream account served the latest request. Its `5H`, `1W`, and `ETA` use that real pooled remaining capacity, while the burn rate still comes from the user's global watch history. Enabling proxy mode makes that synthetic account current in the default `CODEX_HOME`. Proxy routing now follows the saved direct/current upstream instead of re-ranking on every message: `codexm switch <name>` immediately becomes the proxy's current upstream while proxy stays enabled, and a later daemon autoswitch event can still move that upstream after a quota-exhausted signal. When daemon autoswitch is on, the proxy can now replay one `/v1/responses` websocket turn or one buffered REST request (`/v1/responses` with `stream: false`, `/v1/chat/completions`, `/v1/completions`, plus API-key-backed non-stream equivalents) after a retryable quota-exhausted failure, as long as no downstream output has been emitted yet; once output has started, the original failure is preserved. While proxy mode is enabled, the configured real upstream row gets an `@` marker in both `codexm list` and the dashboard, even before a fresh proxy request is sent. Recent real proxy traffic still shows up separately as `Proxy last upstream: ...` in `codexm list` and `Last upstream: ...` in the dashboard detail pane when known. The same daemon also exposes an OpenAI-compatible `/v1` surface for common tools, including Responses, Chat Completions, legacy Completions, Models, and API-key-backed Embeddings.

For managed proxy-aware entrypoints, `codexm proxy enable` now rewrites `chatgpt_base_url` and `openai_base_url` without changing the live provider identity, while `codexm run --proxy` still uses an isolated custom provider inside its overlay. That means live proxy-backed CLI/Desktop sessions keep shared history, and isolated proxy runs still force Responses websocket turns as well as REST traffic through the local proxy. The guarantee is still scoped to `codexm`-managed entrypoints; bare `codex` or Desktop launches outside `codexm` are not forced through the local proxy.

`codexm daemon start`, `codexm daemon restart`, `codexm autoswitch enable`, and `codexm proxy enable` all operate on the same shared background daemon. Use `codexm daemon status` to inspect enabled features. `codexm daemon stop` now stops the process but preserves the last daemon feature state, so a later `codexm daemon start` or `codexm daemon restart` brings back the previous `autoswitch` and `proxy` settings. For a codexm-managed Desktop session, `codexm switch <name>` refreshes the Desktop account surface by restarting the Codex app server after the active thread has finished, unless `--force` skips that wait. Proxy route changes are different: managed Desktop `/backend-api/*` fetches use the `CODEX_API_BASE_URL` chosen when `codexm launch` starts the app, so turning proxy on or off while that Desktop instance is already running prints a relaunch warning instead of pretending a hot refresh worked. Rerun `codexm launch` to apply the new Desktop proxy or direct backend route. `codexm switch <name>` no longer disables proxy implicitly: it updates the saved direct account, and when proxy stays enabled that account becomes the proxy's current upstream until a later autoswitch event changes it after an exhaustion signal. Use `codexm proxy disable` when you explicitly want to restore direct auth/config and clear proxy wiring. The daemon writes a human-readable `daemon.log`, structured daily event logs, and daily proxy request metadata logs under `~/.codex-team/logs/`.

Non-200 proxy requests also write a separate `proxy-errors-YYYY-MM-DD.jsonl` file with request/response diagnostics. Structured JSONL logs always include `codexm_version`; set `CODEXM_LOG_BUILD_META=1` to also record local build metadata such as `codexm_git_sha` when debugging daemon and proxy runs.

Set `CODEXM_PROXY_PORT=<port>` when you need the shared proxy/daemon to bind somewhere other than the default `14555`. That environment override is respected by `codexm daemon start`, `codexm autoswitch enable`, `codexm launch`, `codexm proxy enable`, and `codexm run --proxy`; an explicit `--port` still wins over the environment.

## Example output

Redacted `codexm list` example:

```text
$ codexm list
Current managed account: plus-main
Daemon: off | Proxy: off | Autoswitch: off
Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, team x1
Available: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)
Usage 7d: in 182k/$0.42 | out 96k/$0.71 | total 278k/$1.13

   NAME         IDENTITY  PLAN  SCORE   ETA     USED      NEXT RESET
   -----------  --------  ----  -----  -----   5H   1W   ----------
*  plus-main    ac1..123  plus    72%   2.1h   58%  41%  04-14 18:30
   team-backup  ac9..987  team    64%   1.7h   61%  39%  04-14 19:10
   plus-old     ac4..456  plus     0%      -   43% 100%  04-16 09:00
```

This is the main command to use when deciding which account to switch to next.

## Core commands

<!-- GENERATED:CORE_COMMANDS:START -->
### Manage accounts

- `codexm add <name>`: add a new managed account snapshot
- `codexm save <name>`: save the currently active auth as a named snapshot
- `codexm update`: refresh the saved snapshot for the current managed account
- `codexm rename <old> <new>`: rename a saved snapshot
- `codexm protect <name>`: exclude a saved snapshot from automatic switch target selection
- `codexm unprotect <name>`: restore a saved snapshot to automatic switch target selection
- `codexm remove <name> --yes`: remove a saved snapshot
- `codexm export [name] [--output <file>]`: export the current auth or a saved snapshot as a share bundle
- `codexm import <file> --name <local-name>`: import a share bundle as a named managed account
- `codexm inspect <file>`: preview bundle metadata before importing

### Inspect quota and status

- `codexm`: open the interactive account dashboard when running in a TTY
- `codexm current [--refresh]`: show the current account and optionally refresh quota
- `codexm doctor`: diagnose local auth, runtime probes, and managed Desktop consistency
- `codexm list [--refresh] [--usage-window <today|7d|30d|all-time>] [--verbose]`: show saved accounts plus an embedded local usage summary
- `codexm list --json`: machine-readable output, including proxy current-upstream metadata and last-upstream metadata when available
- `codexm list --debug`: include diagnostic details about quota normalization and observed ratios
- `codexm proxy status`: inspect the local proxy daemon and synthetic auth mode
- `codexm daemon status`: inspect the shared background daemon, enabled features, and log path
- `codexm autoswitch status`: inspect whether daemon-backed auto-switching is enabled
- `codexm tui [query]`: explicitly open the account dashboard, optionally with an initial filter; Enter on the proxy row toggles proxy on or off
- `codexm usage [--window <today|7d|30d|all-time>] [--daily] [--json]`: summarize local token usage and estimated cost from session logs

### Switch and launch

- `codexm switch <name>`: switch to a saved direct account; with proxy enabled, this immediately becomes the proxy's current upstream until a later autoswitch event changes it
- `codexm switch --auto --dry-run`: preview the best auto-switch candidate
- `codexm launch [name] [--auto]`: launch Codex Desktop on macOS and ensure the shared daemon is running

### Watch and auto-restart

- `codexm watch`: watch quota changes and auto-switch on exhaustion
- `codexm autoswitch enable`: enable daemon-backed auto-switching, including proxy replay before user-visible output starts on quota exhaustion
- `codexm autoswitch disable`: disable auto-switching while keeping the baseline daemon alive
- `codexm daemon start`: start the shared background daemon without enabling extra features
- `codexm daemon stop`: stop the shared background daemon while preserving the last daemon feature state
- `codexm run [--account <name>] [-- ...codexArgs]`: run codex with global auth follow-restart or an isolated managed account snapshot
- `codexm run --proxy [-- ...codexArgs]`: run codex in an isolated CODEX_HOME through the local proxy
- `codexm proxy enable`: enable global synthetic ChatGPT auth backed by the local proxy, with one replay before user-visible output starts on proxy quota exhaustion
- `codexm proxy disable`: restore the previous direct auth/config backup and stop the proxy daemon
- `codexm overlay create <name>`: create an isolated CODEX_HOME overlay for another tool to use
<!-- GENERATED:CORE_COMMANDS:END -->

Use `codexm --help` for the full command reference. Share bundles are plain auth snapshots intended only for fully trusted recipients.

In a TTY, plain `codexm` opens the dashboard directly. Besides `Enter` / `a` / `f` / `p` / `o` / `O` / `d` / `Shift+D`, use `e` / `E` to export the selected or current auth, `i` to import a bundle, `x` to delete the selected account, and `u` to undo the latest import/export/delete. `Enter` on the synthetic `proxy` row toggles proxy on or off; `f` on the current proxy row reapplies proxy and refreshes managed Desktop. `a` toggles daemon-backed autoswitch, while `p` toggles whether the selected account can be picked as an auto-switch target; protection does not stop the current in-use account from being switched away later. `Esc` backs out of prompts; `q` quits from the main dashboard. The dashboard list now uses the same `Next reset` formatting as `codexm list`, including the colored minute countdown inside the last hour, and the detail pane shows both `5H reset` and `1W reset`. If a quota refresh fails, `codexm list` and the dashboard reuse that account's last good quota snapshot for up to 7 days and mark the row as `[stale]`. The synthetic `proxy` row stays visible even when proxy mode is off; while proxy mode is enabled, `@` marks the configured real upstream row, and `Last upstream: ...` only appears when a recent real proxy hit is known. The `[autoswitch:on|off]` status tag still reflects the daemon/watch feature flag, not proxy-internal upstream routing. When a managed Desktop switch has to wait for the active thread to finish, the dashboard status line now shows that wait progress instead of sitting on a generic busy label. When no other live watch owner is present and the current Desktop session is codexm-managed, the dashboard keeps a foreground watch active; that foreground watch follows the current autoswitch setting and stops when you quit.

## When should I use each command?

- `codexm list` is the best overview when choosing the next account.
- `codexm usage` is the best view for local token volume and estimated cost.
- `codexm autoswitch enable` is the background daemon feature for managed Desktop and proxy auto-switching.
- `codexm watch` is the foreground quota-monitoring loop that reacts to quota exhaustion.
- `codexm daemon start` starts the shared baseline daemon without enabling autoswitch or proxy.
- `codexm daemon status` is the place to inspect the shared background daemon and log paths.
- `codexm run` is useful in CLI workflows where the running `codex` process should follow account switches.
- `codexm proxy enable` is useful when Codex or another tool should keep one stable local API/auth while `codexm` rotates the real upstream account internally.
- `codexm run --proxy` is the safer one-off mode when you want proxy behavior without writing sessions or auth/config into the live `CODEX_HOME`.
- Set `CODEXM_PROXY_PORT` when the shared proxy/daemon must avoid the default `14555`; `--port` still overrides it for `codexm proxy enable`.
- Use `--json` for scripting and `--debug` for diagnostics.

For ChatGPT auth snapshots, `codex-team` can save and switch different users under the same ChatGPT account or workspace as separate managed entries when the local login tokens distinguish them.

## Shell completion

<!-- GENERATED:SHELL_COMPLETION:START -->
Generate a completion script and install it with your shell's standard mechanism:

```bash
mkdir -p ~/.zsh/completions
codexm completion zsh > ~/.zsh/completions/_codexm

mkdir -p ~/.local/share/bash-completion/completions
codexm completion bash > ~/.local/share/bash-completion/completions/codexm
```

The generated scripts complete commands, known subcommands, flags when the current word starts with `-`, and saved account names by calling `codexm completion --accounts`.
<!-- GENERATED:SHELL_COMPLETION:END -->

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Real self-tests may call live ChatGPT/OpenAI services when needed, but must use a temp `HOME`, isolated `CODEX_HOME`, or codexm overlay so local threads, sessions, auth/config, sockets, and live CLI/TUI/Desktop instances are not modified.

## License

MIT
