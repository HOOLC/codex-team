# codexm quota exhaustion signals

This file is the repository source-of-truth for how `codex-team` detects quota exhaustion and when it is allowed to replay a failed request.

## Canonical exhaustion signals

The current live Codex error shape is snake_case:

- `codex_error_info = usage_limit_exceeded`

Structured payloads are also treated as exhaustion when they contain:

- `code` / `errorCode` / `error_code` / `type` in:
  - `insufficient_quota`
  - `quota_exceeded`
  - `rate_limit_exceeded`
  - `usage_limit_exceeded`
- `message` / `error_message` / `detail` containing phrases such as:
  - `insufficient quota`
  - `quota exceeded`
  - `usage limit exceeded`
  - `hit your usage limit`
  - `rate limit exceeded`

When a route does not emit an explicit exhaustion error object, a rate-limit snapshot is also considered exhausted when either `usedPercent` or `used_percent` reaches `100`.

## Shared implementation

All exhaustion detection should go through:

- [src/quota-exhaustion-signals.ts](/Users/bytedance/code/codex-team/src/quota-exhaustion-signals.ts)

Current consumers:

- [src/proxy/server.ts](/Users/bytedance/code/codex-team/src/proxy/server.ts)
- [src/desktop/runtime-signals.ts](/Users/bytedance/code/codex-team/src/desktop/runtime-signals.ts)
- [src/watch/cli-watcher.ts](/Users/bytedance/code/codex-team/src/watch/cli-watcher.ts)

If a new path needs exhaustion detection, add it to the shared module first instead of forking another matcher.

## Replay boundary

Buffered REST replay remains simple:

- replay is allowed before any response body is written
- replay stops after one retry or when no alternate upstream exists

Websocket `/v1/responses` replay uses a narrower boundary:

- replay is allowed while the turn has only emitted protocol or prelude events
- replay stops once user-visible assistant output has started
- replay also stops once side-effectful output has started
  - for example, completed tool-call items that a downstream client could act on

In practice this means:

- safe to replay:
  - `response.created`
  - `response.in_progress`
  - other pre-output metadata events that do not yet contain assistant content or committed tool items
- not safe to replay:
  - `response.output_text.delta`
  - `response.output_text.done`
  - `response.output_item.done` once it normalizes into a conversation item

This is intentionally stricter than "any bytes were sent" and intentionally looser than "nothing at all was returned".

## Logging expectations

Terminal proxy request logs should keep recording:

- `replay_count`
- `replayed_from_account_names`
- `service_tier` (`default` or `priority`)

For websocket turns, these fields belong on the terminal `/v1/responses` record, not on the initial `101` upgrade record.
