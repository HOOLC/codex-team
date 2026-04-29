# codexm proxy replay on quota exhaustion

This note is superseded by [codex-quota-exhaustion-signals.md](/Users/bytedance/code/codex-team/docs/internal/codex-quota-exhaustion-signals.md).

Date: 2026-04-22

## Goal

Keep proxy-backed Codex sessions running through quota exhaustion without forcing the user to resend the turn.

## Scope

- Websocket `/v1/responses`
- Buffered REST requests:
  - `/v1/responses` with `stream: false`
  - `/v1/chat/completions` with `stream: false`
  - `/v1/completions` with `stream: false`
  - matching non-stream API-key upstream routes when proxy synthetic auth selects an API-key account

Out of scope:

- Streamed REST responses after any bytes have been sent downstream
- Mid-turn continuation after downstream output has already started

## Trigger

Replay is only attempted when all of the following are true:

- proxy synthetic auth is handling the request
- daemon autoswitch is enabled
- the upstream failure matches the shared exhaustion matcher in [codex-quota-exhaustion-signals.md](/Users/bytedance/code/codex-team/docs/internal/codex-quota-exhaustion-signals.md)
- the websocket turn is still in protocol / prelude state, or the buffered REST response has not been written yet
- the request has not already been replayed once

## Websocket behavior

The proxy buffers early upstream events for an active turn while the stream only contains protocol or prelude events.

- If quota exhaustion happens before user-visible or side-effectful output starts:
  - drop the buffered first attempt
  - pick a new upstream account with autoswitch ranking
  - persist that upstream as the proxy's current upstream
  - replay the same `response.create`
- If user-visible or side-effectful output has already started:
  - stop replaying
  - forward the original terminal failure

This preserves normal streaming once the turn is clearly underway, while keeping prelude-only failures invisible to the client.

## REST behavior

Buffered REST routes already hold the full upstream response before writing to the client.

- On the first retryable quota failure:
  - select a new upstream with autoswitch ranking
  - persist it as the proxy current upstream
  - resend the same request once
- For transparent API-key `/v1/responses`, do not replay across accounts when the request carries an upstream `previous_response_id`; return the original failure with `replay_skip_reason = previous_response_id` because the proxy cannot safely translate that upstream-owned parent id
- On the second failure, or if no alternate upstream exists:
  - return the original failure

## Upstream persistence

Proxy autoswitch replay updates the saved proxy upstream backup files under `~/.codex-team/proxy/`.

That keeps these views aligned after a replay-triggered switch:

- `codexm list` / dashboard `@`
- `codexm current`
- later `codexm proxy disable` restoration

## Logging

Proxy request logs now record replay metadata on the final request record:

- `replay_count`
- `replayed_from_account_names`
- `service_tier` (`default` or `priority`)

For websocket turns this is emitted on the terminal `/v1/responses` log entry.
