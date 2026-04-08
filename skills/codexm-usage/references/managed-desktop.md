# managed Desktop behavior

`codexm` distinguishes between:

- local auth state under `~/.codex/auth.json`
- a Codex Desktop session started by `codexm launch`

## switch vs launch

- `codexm switch` always updates local auth first.
- `codexm launch [name]` is the preferred way to make Codex Desktop use a selected account immediately.
- If Desktop was started outside `codexm`, `codexm switch` only updates local auth and warns that the running Desktop session may still keep the previous login state.
- If a non-managed Desktop session is already running, `codexm launch` asks the user to confirm a force-kill before relaunching with managed state.

## managed Desktop refresh

- If Desktop was started by `codexm launch`, later `codexm switch` can apply the new auth to that managed Desktop session.
- By default, `codexm switch` waits for the current managed Desktop thread to finish before restarting the Codex app server.
- `codexm switch --force` skips that wait and applies the change immediately.
- Restarting the managed Codex app server interrupts the current managed Desktop thread.

## watch behavior

- `codexm watch` observes managed Desktop MCP/quota signals and does not switch accounts by default.
- `codexm watch --auto-switch` watches the same signals and runs `switch --auto` only after a quota-exhaustion signal is detected.
- `codexm watch` prints structured quota and reconnect lines; use `--debug` if the user wants raw bridge `mcp-*` traffic and watch decision logs on stderr.
- `codexm watch --detach` keeps the watcher running in the background.
- `codexm watch --status` shows watcher state, pid, start time, and log path.
- `codexm watch --stop` stops the background watcher.

## response guidance

- If the user expects an already-running Desktop window to switch accounts in place, explain whether it is a managed or unmanaged Desktop session.
- If the user mentions ongoing work in Desktop, mention the default wait behavior before suggesting `--force`.
- If the user says "watch" but does not ask for automatic switching, keep the recommendation on plain `codexm watch` without `--auto-switch`.
