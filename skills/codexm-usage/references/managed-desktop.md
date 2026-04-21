# managed Desktop behavior

`codexm` distinguishes between:

- local auth state under `~/.codex/auth.json`
- a Codex Desktop session started by `codexm launch`

## switch vs launch

- `codexm switch` always updates local auth first.
- `codexm launch [name]` is the preferred way to make Codex Desktop use a selected account immediately.
- `codexm launch` also ensures the shared baseline daemon is running.
- If Desktop was started outside `codexm`, `codexm switch` only updates local auth and warns that the running Desktop session may still keep the previous login state.
- If a non-managed Desktop session is already running, `codexm launch` asks the user to confirm a force-kill before relaunching with managed state.

## managed Desktop refresh

- If Desktop was started by `codexm launch`, later `codexm switch` can apply the new auth to that managed Desktop session.
- By default, `codexm switch` waits for the current managed Desktop thread to finish before restarting the Codex app server.
- `codexm switch --force` skips that wait and applies the change immediately.
- Restarting the managed Codex app server interrupts the current managed Desktop thread.

## proxy account

- `codexm proxy enable` writes a synthetic ChatGPT auth plus proxy-backed `chatgpt_base_url` and `openai_base_url` into the default `CODEX_HOME`, while keeping the live provider identity unchanged so proxy and non-proxy sessions keep shared history. Managed Desktop or CLI entrypoints launched through `codexm` route both live Responses websocket turns and REST traffic through the local proxy. While proxy remains enabled, `codexm switch <name>` updates the proxy's current upstream instead of disabling proxy; autoswitch only moves that upstream after quota-exhaustion signals. The dashboard and `codexm list` always keep the synthetic `proxy` row visible; while proxy mode is enabled, `@` marks the configured current upstream, and `Last upstream: ...` continues to describe the most recent real proxy hit when known. Bare Desktop or CLI launches outside `codexm` are not forced into that path.
- `CODEXM_PROXY_PORT=<port>` changes the shared daemon/proxy bind port for `launch`, `daemon start`, `autoswitch enable`, `proxy enable`, and `run --proxy`; use `--port` on `proxy enable` when only that invocation should differ.
- `codexm proxy disable` restores the previous direct auth/config backup and stops the proxy daemon.
- For one-off CLI runs that must not affect local Desktop or thread/session data, prefer `codexm run --proxy` because it creates an isolated `CODEX_HOME`.

## watch behavior

- `codexm autoswitch enable` turns on daemon-backed background auto-switching for managed Desktop and proxy flows.
- `codexm autoswitch disable` turns that feature off while leaving the baseline daemon running.
- `codexm daemon status` shows the shared daemon pid, enabled features, and log path; `codexm daemon stop` stops the daemon but preserves the last daemon feature state for the next start or restart.
- `codexm watch` observes managed Desktop MCP/quota signals and runs `switch --auto` after terminal quota-exhaustion signals by default.
- `codexm watch --no-auto-switch` keeps the same quota and reconnect output without changing accounts automatically.
- `codexm watch` is foreground-only; it prints structured quota and reconnect lines, and `--debug` adds raw bridge `mcp-*` traffic plus watch decision logs on stderr.

## response guidance

- If the user expects an already-running Desktop window to switch accounts in place, explain whether it is a managed or unmanaged Desktop session.
- If the user mentions ongoing work in Desktop, mention the default wait behavior before suggesting `--force`.
- If the user says "watch" but wants observation only, recommend `codexm watch --no-auto-switch`.
- If the user wants background auto-switching without keeping a foreground watch open, recommend `codexm autoswitch enable`.
