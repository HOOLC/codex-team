# How to Monitor Codex Quota and Auto-Switch Accounts

This guide explains how to use `codexm` to monitor Codex quota usage, see which account is still usable, and auto-switch when the current account is exhausted.

Chinese version: [如何监控 Codex quota 并自动切号](./zh-CN/monitor-codex-quota-and-auto-switch.md)

## Problem

When you use multiple Codex accounts, the hard part is not saving them. The hard part is knowing:

- which account still has quota
- when the current account will become unavailable
- which account is the best next target

`codexm` gives you a quota-oriented workflow for this.

## Start with `codexm list`

The main command for quota monitoring is:

```bash
codexm list
```

This view helps answer:

- which account is active
- which accounts are still usable
- how much 5-hour and 1-week quota has been used
- which account should be used next

If you want a single-account view:

```bash
codexm current --refresh
```

## Auto-switch on exhaustion

To keep watching quota and switch accounts automatically:

```bash
codexm watch
```

On macOS, you can combine watch with a managed Desktop launch:

```bash
codexm launch --watch
```

If you only want to preview the next automatic choice:

```bash
codexm switch --auto --dry-run
```

## What you should expect

With this workflow:

- `codexm list` becomes your quota dashboard
- `codexm watch` becomes your automation loop
- `codexm switch --auto --dry-run` becomes your decision preview

This is the fastest path if your real search intent is "monitor Codex quota" or "switch accounts when quota is exhausted".

## Common mistakes

- Using `switch` alone without first checking `list`
- Looking only at one quota window instead of the overall score and ETA
- Forgetting that `watch` is the long-running automation loop, not just a one-shot check

## Related guides

- [How to manage multiple Codex accounts on one machine](./manage-multiple-codex-accounts.md)
- [How to use codexm with Codex Desktop](./use-codexm-with-codex-desktop.md)
- [How to use codexm with Codex CLI](./use-codexm-with-codex-cli.md)
