# How to Use codexm with Codex CLI

This guide covers the Codex CLI workflow on Linux, WSL, and general terminal-first setups where you want the running CLI session to follow account switches.

Chinese version: [如何把 codexm 用在 Codex CLI](./zh-CN/use-codexm-with-codex-cli.md)

## When this workflow fits

Use this path if:

- you mainly use Codex from a terminal
- you want to keep a long-running Codex CLI session alive across account switches
- you use Linux or WSL and do not need the Desktop launch flow

## Recommended workflow

Save a few accounts first:

```bash
codexm add plus-main
codexm add team-backup
```

Start quota monitoring:

```bash
codexm watch
```

In another terminal, run Codex through the wrapper:

```bash
codexm run -- --model o3
```

## Why this helps

`codexm run` wraps the `codex` CLI and restarts it when the active auth changes. That makes it useful for:

- long-running Codex CLI sessions
- account switching driven by `codexm watch`
- Linux and WSL setups where the CLI path matters more than Desktop integration

## Common mistakes

- Starting `codex` directly instead of `codexm run`
- Expecting `watch` alone to restart your running CLI session
- Forgetting to use a second terminal for the wrapped CLI session

## Related guides

- [How to manage multiple Codex accounts on one machine](./manage-multiple-codex-accounts.md)
- [How to monitor Codex quota and auto-switch accounts](./monitor-codex-quota-and-auto-switch.md)
- [How to use codexm with Codex Desktop](./use-codexm-with-codex-desktop.md)
