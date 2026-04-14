# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` provides the `codexm` CLI for managing multiple Codex ChatGPT login snapshots on one machine.

It is built for people who regularly switch between multiple Codex accounts and want a simpler workflow for:

- saving named account snapshots
- switching the active `~/.codex/auth.json`
- checking quota usage across saved accounts
- automatically switching and restarting when the current account is exhausted

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

Typical flow:

- `codexm add <name>` opens the ChatGPT login flow and stores a named snapshot
- `codexm launch --watch` starts Codex Desktop and keeps a background watcher running
- when the active account is exhausted, the watcher can switch to the best saved account automatically

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

Typical flow:

- `codexm watch` monitors quota and can auto-switch accounts
- `codexm run` wraps the `codex` CLI and restarts it when `~/.codex/auth.json` changes
- this lets a long-running CLI session follow account switches automatically

## Core commands

### Manage accounts

- `codexm add <name>`: add a new managed account snapshot
- `codexm save <name>`: save the currently active auth as a named snapshot
- `codexm rename <old> <new>`: rename a saved snapshot
- `codexm remove <name> --yes`: remove a saved snapshot

### Inspect quota and status

- `codexm current [--refresh]`: show the current account and optionally refresh quota
- `codexm list [--verbose]`: show saved accounts, quota usage, score, ETA, and reset times
- `codexm list --json`: machine-readable output
- `codexm list --debug`: include diagnostic details about quota normalization and observed ratios

### Switch and launch

- `codexm switch <name>`: switch to a saved account
- `codexm switch --auto --dry-run`: preview the best auto-switch candidate
- `codexm launch [name] [--auto] [--watch]`: launch Codex Desktop on macOS

### Watch and auto-restart

- `codexm watch`: watch quota changes and auto-switch on exhaustion
- `codexm watch --detach`: run the watcher in the background
- `codexm watch --status`: inspect detached watcher state
- `codexm watch --stop`: stop the detached watcher
- `codexm run [-- ...codexArgs]`: restart the `codex` CLI automatically after auth changes

Use `codexm --help` for the full command reference.

## Notes

- `codexm list` is the best overview command when choosing which account to use next.
- `codexm watch` is the automation loop that reacts to quota exhaustion.
- `codexm run` is mainly useful for CLI workflows where you want the running `codex` process to follow account switches.
- Use `--json` for scripting and `--debug` for stderr diagnostics.

For ChatGPT auth snapshots, `codex-team` can save and switch different users under the same ChatGPT account or workspace as separate managed entries when the local login tokens distinguish them.

## Shell completion

Generate a shell completion script and install it with your shell's standard mechanism:

```bash
mkdir -p ~/.zsh/completions
codexm completion zsh > ~/.zsh/completions/_codexm

mkdir -p ~/.local/share/bash-completion/completions
codexm completion bash > ~/.local/share/bash-completion/completions/codexm
```

The generated scripts dynamically complete saved account names by calling `codexm completion --accounts`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
