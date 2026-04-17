---
name: codexm-usage
description: Use when a user wants help managing multiple Codex login snapshots with codexm, including saving, listing, switching, launching, watching quota signals, or understanding managed Desktop behavior.
---

# codexm Usage

Use this skill when the user is asking how to use `codexm` as a tool, including account dashboard flows, share-bundle import/export, and `codexm run`. Do not use it for `codex-team` implementation, testing, release, or code review work.

## How to use

1. First identify the user's goal: inspect state, inspect current usage, compare accounts, add a new login, save or refresh the current login, switch accounts, open the account dashboard, export or import a share bundle, launch Desktop, run the CLI through the restart wrapper, watch quota behavior, set up shell completion, or explain command behavior.
2. Prefer the shortest command that matches that goal.
3. If the user is unsure about current state, start with `codexm current` or `codexm list`; use `codexm doctor` when they are debugging runtime or Desktop consistency.
4. If the question is about Desktop behavior, explain the difference between `switch`, `launch`, and `watch` before giving commands.

## Route by task

- Command map: [references/commands.md](references/commands.md)
- Managed Desktop behavior: [references/managed-desktop.md](references/managed-desktop.md)

## Response Guidance

- When the user expects Desktop to switch accounts immediately, explain the difference between `switch` and `launch`.
- If the user mentions an in-progress managed Desktop thread, mention the default wait behavior and the `--force` trade-off.
- If the user asks to monitor quota exhaustion or auto-switch on quota exhaustion, route them to `codexm watch`; add `--no-auto-switch` only when they explicitly want read-only monitoring without automatic switching.
- If the user asks for current usage, prefer `codexm current`; add `--refresh` only when they explicitly want the latest data.
- When the user asks for `codexm current --refresh`, mention that it prefers managed Desktop/runtime quota, then the ChatGPT usage API, and may fall back to recent cached quota with a `stale` label if the API is temporarily unavailable.
- If the user is debugging mismatches between local auth, managed Desktop, and direct runtime reads, route them to `codexm doctor`.
- If the user wants to add another account without changing current auth, prefer `codexm add <name>`; use `--device-auth` for remote/headless machines and `--with-api-key` only when they explicitly want API-key auth.
- If the user wants to update the saved snapshot for the account already active in local auth, route them to `codexm update`.
- If the user asks how to compare accounts or understand why `switch --auto` picked one, prefer `codexm list --verbose`.
- If the user wants an interactive picker, filtering, import/export, delete, or Desktop launch in one place, route them to plain `codexm` in a TTY or `codexm tui [query]`.
- If the user is worried about transient quota refresh errors in the dashboard, mention that the dashboard keeps the last successful quota view and surfaces the error through warnings/failures until the next successful refresh.
- If the user wants to move a login to another trusted machine without re-login, route them to `codexm export`, `codexm inspect`, and `codexm import`, and mention that share bundles are plain auth snapshots for fully trusted recipients only.
- If the user wants a CLI workflow that survives account-triggered restarts, route them to `codexm run -- ...codexArgs`.
- If the user asks for shell completion, route them to `codexm completion <zsh|bash>` and mention that saved account names are completed dynamically.
- When the user wants machine-readable output, include `--json` where supported.
- If the user wants raw command help only, answer with commands first and keep explanation short.
