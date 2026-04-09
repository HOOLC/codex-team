---
name: codexm-usage
description: Use when a user wants help managing multiple Codex login snapshots with codexm, including saving, listing, switching, launching, watching quota signals, or understanding managed Desktop behavior.
---

# codexm Usage

Use this skill when the user is asking how to use `codexm` as a tool. Do not use it for `codex-team` implementation, testing, release, or code review work.

## How to use

1. First identify the user's goal: inspect state, inspect current usage, compare accounts, save the current login, switch accounts, launch Desktop, watch quota behavior, set up shell completion, or explain command behavior.
2. Prefer the shortest command that matches that goal.
3. If the user is unsure about current state, start with `codexm current` or `codexm list`.
4. If the question is about Desktop behavior, explain the difference between `switch`, `launch`, and `watch` before giving commands.

## Route by task

- Command map: [references/commands.md](references/commands.md)
- Managed Desktop behavior: [references/managed-desktop.md](references/managed-desktop.md)

## Response Guidance

- When the user expects Desktop to switch accounts immediately, explain the difference between `switch` and `launch`.
- If the user mentions an in-progress managed Desktop thread, mention the default wait behavior and the `--force` trade-off.
- If the user asks to monitor quota exhaustion or auto-switch on quota exhaustion, route them to `codexm watch`; add `--no-auto-switch` only when they explicitly want read-only monitoring without automatic switching.
- If the user asks for current usage, prefer `codexm current`; add `--refresh` only when they explicitly want the latest data.
- If the user asks how to compare accounts or understand why `switch --auto` picked one, prefer `codexm list --verbose`.
- If the user asks for shell completion, route them to `codexm completion <zsh|bash>` and mention that saved account names are completed dynamically.
- When the user wants machine-readable output, include `--json` where supported.
- If the user wants raw command help only, answer with commands first and keep explanation short.
