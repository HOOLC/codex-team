# managed Desktop behavior

`codexm` distinguishes between:

- local auth state under `~/.codex/auth.json`
- a Codex Desktop session started by `codexm launch`

## switch vs launch

- `codexm switch` always updates local auth first.
- `codexm launch [name]` is the preferred way to make Codex Desktop use a selected account immediately.
- If Desktop was started outside `codexm`, `codexm switch` only updates local auth and warns that the running Desktop session may still keep the previous login state.

## managed Desktop refresh

- If Desktop was started by `codexm launch`, later `codexm switch` can apply the new auth to that managed Desktop session.
- By default, `codexm switch` waits for the current managed Desktop thread to finish before restarting the Codex app server.
- `codexm switch --force` skips that wait and applies the change immediately.
- Restarting the managed Codex app server interrupts the current managed Desktop thread.

## response guidance

- If the user expects an already-running Desktop window to switch accounts in place, explain whether it is a managed or unmanaged Desktop session.
- If the user mentions ongoing work in Desktop, mention the default wait behavior before suggesting `--force`.
