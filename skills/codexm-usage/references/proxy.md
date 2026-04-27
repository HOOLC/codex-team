# codexm proxy mode

Use proxy mode when you want Codex or another OpenAI-compatible client to talk to one stable local endpoint while `codexm` routes requests to saved upstream accounts internally.

## What `codexm proxy enable` does

- Starts or reuses the shared local daemon on `127.0.0.1`.
- Installs a synthetic ChatGPT auth such as `proxy@codexm.local`.
- Rewrites the default runtime's local transport URLs to the proxy.
- Keeps the live provider identity unchanged, so proxy and non-proxy sessions still share one live thread history.

The synthetic `proxy` row stays visible in `codexm list` and the dashboard even when proxy mode is off.

## Live vs isolated proxy usage

- `codexm proxy enable`: turns on proxy mode for the default runtime under the normal `CODEX_HOME`.
- `codexm run --proxy -- ...`: creates an isolated overlay and routes that one CLI run through the local proxy without writing threads, sessions, auth, or config into the live runtime.

For `codexm`-managed entrypoints, both Responses websocket turns and REST `/v1` traffic go through the local proxy. Bare unmanaged `codex` or Desktop launches are outside that guarantee.

## Upstream selection

- While proxy mode is enabled, `codexm switch <name>` updates the proxy's current real upstream instead of disabling proxy, replacing the default runtime's synthetic `proxy` auth, or creating a `last-active-auth.json` backup.
- Daemon autoswitch can move that upstream later, but only after quota-exhaustion signals.
- `@` marks the configured current real upstream in `codexm list` and the dashboard while proxy mode is enabled.
- `Proxy last upstream: ...` in `codexm list` and `Last upstream: ...` in the dashboard only appear when a recent real proxy hit is known.

## Replay behavior

When daemon autoswitch is on, the proxy can replay one retryable quota-exhausted request before downstream output starts:

- one `/v1/responses` websocket turn
- one buffered non-stream REST request such as `/v1/responses`, `/v1/chat/completions`, or `/v1/completions`

Once downstream output has started, the proxy keeps the original failure and does not attempt a mid-stream replay.

## Quota surface

- The synthetic `proxy` row aggregates quota from non-protected, auto-switch-eligible accounts that still have quota snapshots.
- Exhausted eligible accounts stay in the aggregate so a fully drained pool still shows `0%` instead of disappearing.
- Protected accounts are excluded from the aggregate.
- Managed Desktop usage/account reads stay on this synthetic proxy account surface instead of drifting to whichever real upstream served the latest request.

## Desktop, ports, and logs

- `codexm launch` selects the managed Desktop backend route at launch time; after turning proxy on or off, rerun `codexm launch` to apply the new Desktop backend route.
- `CODEXM_PROXY_PORT=<port>` changes the shared daemon/proxy port for `launch`, `daemon start`, `autoswitch enable`, `proxy enable`, and `run --proxy`.
- Logs live under `~/.codex-team/logs/`.
- Non-200 proxy requests also write `proxy-errors-YYYY-MM-DD.jsonl` with request/response diagnostics.

See [managed-desktop.md](managed-desktop.md) for the managed Desktop refresh boundary.
