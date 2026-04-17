# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` provides the `codexm` CLI for managing multiple Codex ChatGPT login snapshots on one machine.

Use it when you regularly switch between multiple Codex accounts and want a simpler way to:

- save named account snapshots
- switch the active `~/.codex/auth.json`
- check quota usage across saved accounts
- export and import fully trusted share bundles without re-login
- automatically switch and restart when the current account is exhausted

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

- `Enter`: switch
- `f`: reload the current account or force-switch
- `p`: toggle whether the selected account can be chosen as an auto-switch target
- `o`: run `codex` in the current terminal, then return to the dashboard when it exits
- `O`: run `codex` with an isolated managed snapshot, then return to the dashboard when it exits
- `d`: open or focus Codex Desktop without leaving the dashboard
- `Shift+D`: relaunch Codex Desktop for the selected account; when an unmanaged Desktop instance is already running, confirm before forcing it closed

### 3. Keep working automatically

macOS + Codex Desktop:

```bash
codexm launch --watch
```

Linux / WSL + Codex CLI:

```bash
codexm watch
```

In another terminal:

```bash
codexm run -- --model o3
```

`codexm watch` monitors quota and can auto-switch accounts. `codexm run` wraps the `codex` CLI, survives repeated `~/.codex/auth.json` replacements, and auto-resumes the active interactive session after an account-triggered restart. If you end `codexm run` manually while a session is recoverable, it prints the resume command to use.

## Example output

Redacted `codexm list` example:

```text
$ codexm list
Current managed account: plus-main
Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, team x1
Available: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)
Usage 7d: in 182k/$0.42 | out 96k/$0.71 | total 278k/$1.13

  NAME         IDENTITY  PLAN  SCORE   ETA     USED      NEXT RESET
  -----------  --------  ----  -----  -----   5H   1W   ----------
* plus-main    ac1..123  plus    72%   2.1h   58%  41%  04-14 18:30
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
- `codexm list [--usage-window <today|7d|30d|all-time>] [--verbose]`: show saved accounts plus an embedded local usage summary
- `codexm list --json`: machine-readable output
- `codexm list --debug`: include diagnostic details about quota normalization and observed ratios
- `codexm tui [query]`: explicitly open the account dashboard, optionally with an initial filter
- `codexm usage [--window <today|7d|30d|all-time>] [--daily] [--json]`: summarize local token usage and estimated cost from session logs

### Switch and launch

- `codexm switch <name>`: switch to a saved account
- `codexm switch --auto --dry-run`: preview the best auto-switch candidate
- `codexm launch [name] [--auto] [--watch]`: launch Codex Desktop on macOS

### Watch and auto-restart

- `codexm watch`: watch quota changes and auto-switch on exhaustion
- `codexm watch --detach`: run the watcher in the background
- `codexm watch --status`: inspect detached watcher state
- `codexm watch --stop`: stop the detached watcher
- `codexm run [--account <name>] [-- ...codexArgs]`: run codex with global auth follow-restart or an isolated managed account snapshot
- `codexm overlay create <name>`: create an isolated CODEX_HOME overlay for another tool to use
<!-- GENERATED:CORE_COMMANDS:END -->

Use `codexm --help` for the full command reference. Share bundles are plain auth snapshots intended only for fully trusted recipients.

In a TTY, plain `codexm` opens the dashboard directly. Besides `Enter` / `f` / `p` / `o` / `O` / `d` / `Shift+D`, use `e` / `E` to export the selected or current auth, `i` to import a bundle, `x` to delete the selected account, and `u` to undo the latest import/export/delete. `p` toggles whether the selected account can be picked as an auto-switch target; it does not stop the current in-use account from being switched away later. `Esc` backs out of prompts; `q` quits from the main dashboard. When a managed Desktop switch has to wait for the active thread to finish, the dashboard status line now shows that wait progress instead of sitting on a generic busy label. When no detached `codexm watch` is already running and the current Desktop session is codexm-managed, the dashboard keeps a foreground watch active, avoids duplicating other live watch owners, and hands that watch off to a detached watcher when you quit.

## When should I use each command?

- `codexm list` is the best overview when choosing the next account.
- `codexm usage` is the best view for local token volume and estimated cost.
- `codexm watch` is the automation loop that reacts to quota exhaustion.
- `codexm run` is useful in CLI workflows where the running `codex` process should follow account switches.
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

The generated scripts dynamically complete saved account names by calling `codexm completion --accounts`.
<!-- GENERATED:SHELL_COMPLETION:END -->

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
