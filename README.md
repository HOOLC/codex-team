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

### macOS with Codex Desktop

```bash
codexm add plus1
codexm add team1
codexm launch --watch
```

This adds a couple of named snapshots, launches Codex Desktop, and keeps a watcher running in the background.

### Linux / WSL with Codex CLI

```bash
codexm add plus1
codexm add team1
codexm watch
```

In another terminal, start Codex through the wrapper:

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
Total: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)

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
- `codexm rename <old> <new>`: rename a saved snapshot
- `codexm remove <name> --yes`: remove a saved snapshot
- `codexm export [name] [--output <file>]`: export the current auth or a saved snapshot as a share bundle
- `codexm import <file> --name <local-name>`: import a share bundle as a named managed account
- `codexm inspect <file>`: preview bundle metadata before importing

### Inspect quota and status

- `codexm`: open the interactive account dashboard when running in a TTY
- `codexm current [--refresh]`: show the current account and optionally refresh quota
- `codexm list [--verbose]`: show saved accounts, quota usage, score, ETA, and reset times
- `codexm list --json`: machine-readable output
- `codexm list --debug`: include diagnostic details about quota normalization and observed ratios
- `codexm tui [query]`: explicitly open the account dashboard, optionally with an initial filter

### Switch and launch

- `codexm switch <name>`: switch to a saved account
- `codexm switch --auto --dry-run`: preview the best auto-switch candidate
- `codexm launch [name] [--auto] [--watch]`: launch Codex Desktop on macOS

### Watch and auto-restart

- `codexm watch`: watch quota changes and auto-switch on exhaustion
- `codexm watch --detach`: run the watcher in the background
- `codexm watch --status`: inspect detached watcher state
- `codexm watch --stop`: stop the detached watcher
- `codexm run [-- ...codexArgs]`: restart the codex CLI automatically after auth changes
<!-- GENERATED:CORE_COMMANDS:END -->

Use `codexm --help` for the full command reference. Share bundles are plain auth snapshots intended only for fully trusted recipients.

In a TTY, plain `codexm` opens the dashboard directly. Inside the dashboard, use `Enter` to switch, `f` to force-switch or reload the current account, `o` to switch and open `codex`, `d` to switch and open or focus Codex Desktop, `e` / `E` to export the selected or current auth, `i` to import a bundle, `x` to delete the selected account, and `u` to undo the latest import/export/delete. `Esc` backs out of prompts; `q` quits from the main dashboard.

## When should I use each command?

- `codexm list` is the best overview when choosing the next account.
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
