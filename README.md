# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

Manage multiple Codex accounts on one machine with `codexm`.

`codexm` is a CLI for people who use multiple Codex accounts across Codex Desktop and Codex CLI and want a faster way to switch accounts, monitor quota usage, and keep long-running sessions moving.

Use it when you want to:

- save named auth snapshots for multiple Codex accounts
- switch the active `~/.codex/auth.json` without manual file juggling
- see which account has usable quota right now
- auto-switch and restart when the current account is exhausted

This repository is especially useful if you have searched for things like:

- how to manage multiple Codex accounts
- how to switch Codex accounts on one machine
- how to monitor Codex quota from the command line
- how to auto-switch Codex accounts when quota is exhausted

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

## Use cases

- You use multiple Codex accounts and do not want to keep copying `auth.json` by hand.
- Your current Codex account runs out of quota during a long session and you want to switch quickly.
- You use Codex Desktop on macOS and want a managed launch flow.
- You use Codex CLI on Linux or WSL and want the running CLI to follow account switches automatically.

## Guides

- [How to manage multiple Codex accounts](./docs/manage-multiple-codex-accounts.md)
- [How to monitor Codex quota and auto-switch accounts](./docs/monitor-codex-quota-and-auto-switch.md)
- [How to use codexm with Codex Desktop](./docs/use-codexm-with-codex-desktop.md)
- [How to use codexm with Codex CLI](./docs/use-codexm-with-codex-cli.md)

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

`codexm watch` monitors quota and can auto-switch accounts. `codexm run` wraps the `codex` CLI and restarts it when `~/.codex/auth.json` changes, so a long-running CLI session can follow account switches automatically.

If you mainly want to answer "which account should I use next?", start with `codexm list`.

## Example output

Redacted `codexm list` example:

```text
$ codexm list
Current managed account: plus-main
Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, team x1
Total: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)

  NAME         IDENTITY   PLAN  SCORE  ETA   5H USED  1W USED  NEXT RESET
* plus-main    acct...123 plus  72%    2.1h  58%      41%      04-14 18:30
  team-backup  acct...987 team  64%    1.7h  61%      39%      04-14 19:10
  plus-old     acct...456 plus  0%     -     43%      100%     04-16 09:00
```

This is the main command to use when deciding which account to switch to next.

## Core commands

<!-- GENERATED:CORE_COMMANDS:START -->
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
- `codexm run [-- ...codexArgs]`: restart the codex CLI automatically after auth changes
<!-- GENERATED:CORE_COMMANDS:END -->

Use `codexm --help` for the full command reference.

## When should I use each command?

- `codexm list` is the best overview when choosing the next account.
- `codexm watch` is the automation loop that reacts to quota exhaustion.
- `codexm run` is useful in CLI workflows where the running `codex` process should follow account switches.
- Use `--json` for scripting and `--debug` for diagnostics.

For ChatGPT auth snapshots, `codex-team` can save and switch different users under the same ChatGPT account or workspace as separate managed entries when the local login tokens distinguish them.

## More docs

- [中文文档索引](./docs/zh-CN/manage-multiple-codex-accounts.md)
- [Manage multiple Codex accounts](./docs/manage-multiple-codex-accounts.md)
- [Monitor Codex quota and auto-switch](./docs/monitor-codex-quota-and-auto-switch.md)
- [Use codexm with Codex Desktop](./docs/use-codexm-with-codex-desktop.md)
- [Use codexm with Codex CLI](./docs/use-codexm-with-codex-cli.md)

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
