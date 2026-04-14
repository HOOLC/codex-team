# How to Use codexm with Codex Desktop

This guide covers the Codex Desktop workflow on macOS: launching the app through `codexm`, keeping the session managed, and combining launch with quota watching.

Chinese version: [如何把 codexm 用在 Codex Desktop](./zh-CN/use-codexm-with-codex-desktop.md)

## When this workflow fits

Use this path if:

- you run Codex Desktop on macOS
- you want account switching to cooperate with the Desktop session
- you want `codexm` to launch Desktop with the selected auth

## Launch Desktop with codexm

Launch Codex Desktop with the current auth:

```bash
codexm launch
```

Launch Desktop with a specific saved account:

```bash
codexm launch plus-main
```

Launch Desktop and start background quota watching:

```bash
codexm launch --watch
```

## Why this helps

For Desktop users, `codexm launch` gives you a cleaner path than opening the app manually and then trying to reconcile auth state afterward.

It is the recommended workflow if your question is closer to:

- how to use multiple Codex accounts with Codex Desktop
- how to launch Codex Desktop with a selected account
- how to keep Desktop switching aligned with quota automation

## Common mistakes

- Launching Desktop manually, then expecting the session to behave like a managed `codexm` launch
- Using `switch` without understanding whether the current Desktop session is managed
- Running `codexm launch` from inside Codex Desktop instead of an external terminal

## Related guides

- [How to manage multiple Codex accounts on one machine](./manage-multiple-codex-accounts.md)
- [How to monitor Codex quota and auto-switch accounts](./monitor-codex-quota-and-auto-switch.md)
- [How to use codexm with Codex CLI](./use-codexm-with-codex-cli.md)
