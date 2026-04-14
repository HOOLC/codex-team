# How to Manage Multiple Codex Accounts on One Machine

This guide shows how to use `codexm` to manage multiple Codex accounts on one machine without manually copying `~/.codex/auth.json` back and forth.

Chinese version: [如何在一台机器上管理多个 Codex 账号](./zh-CN/manage-multiple-codex-accounts.md)

## Problem

If you use more than one Codex account, the default workflow is awkward:

- only one `~/.codex/auth.json` can be active at a time
- switching accounts usually means manual file copying or re-login
- it is hard to remember which saved login belongs to which account

`codexm` solves this by saving named auth snapshots and making account switching a CLI operation.

## When to use this

Use this workflow if:

- you use separate personal, team, or backup Codex accounts
- you switch between Codex Desktop and Codex CLI
- you want stable names like `plus-main` or `team-backup` instead of raw auth files

## Quick setup

Save multiple accounts:

```bash
codexm add plus-main
codexm add team-backup
```

If you are already logged in and just want to save the current auth state:

```bash
codexm save plus-main
```

List saved accounts and see which one is active:

```bash
codexm list
```

Switch to another saved account:

```bash
codexm switch team-backup
```

## What you should expect

After you save a few accounts:

- each account has a stable name
- `codexm list` shows saved accounts in one place
- `codexm switch <name>` updates the active `~/.codex/auth.json`

That means "manage multiple Codex accounts" becomes a repeatable CLI workflow instead of a manual file-management task.

## Common mistakes

- Saving accounts with unclear names like `a1` and `a2`. Use names that describe role or quota state.
- Switching auth manually and forgetting to save it with `codexm save`.
- Treating `codexm list` as only a status command. It is also the best view for deciding which account to use next.

## Related guides

- [How to monitor Codex quota and auto-switch accounts](./monitor-codex-quota-and-auto-switch.md)
- [How to use codexm with Codex Desktop](./use-codexm-with-codex-desktop.md)
- [How to use codexm with Codex CLI](./use-codexm-with-codex-cli.md)
