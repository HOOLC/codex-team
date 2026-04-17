# codexm Refresh Resilience Design

## Goal

Make `codexm` quota refresh failures predictable for both the dashboard and CLI:

- keep the dashboard on the last good view when quota refresh calls fail
- keep current-account identity refresh independent from quota refresh
- treat cached quota as display data when safe, but avoid using stale quota as unbounded auto-switch input
- make `chatgpt.com/backend-api/wham/usage` failure behavior explicit in tests and user-facing docs

## Scope

This change covers:

- dashboard snapshot generation and refresh behavior
- CLI quota refresh fallbacks for `current` / `list`
- failure and stale-state tests for network errors and API errors from `chatgpt.com/backend-api/wham/usage`
- README and agent-skill guidance for the refreshed behavior

This change does not add proxy mode yet. It only establishes the refresh-resilience semantics that proxy mode will later reuse.

## Design

### Snapshot semantics

The dashboard uses two related concepts:

- `view snapshot`: the rendered list, header, summary, detail panel, warnings, and failures
- `decision snapshot`: the quota inputs that commands use for ranking and auto-switch decisions

When quota refresh partially fails, `codexm` should build the next dashboard view by merging:

- refreshed quota rows for accounts that succeeded
- the last known good quota rows for accounts whose refresh failed

The merged snapshot should recompute header, summary, pool, detail lines, and ordering from that merged quota set. A failure should update warning and failure surfaces, but should not collapse the dashboard into a lower-information view when the previous successful quota is still available.

When an entire dashboard refresh throws before any new quota state is available, the TUI should keep the previous snapshot and only surface the refresh failure message or banner.

### CLI semantics

`codexm current --refresh` and quota-backed list reads should follow the same quota precedence:

1. live runtime quota when available
2. fresh API quota
3. cached quota fallback when refresh fails and cached quota is still within the store fallback age
4. explicit unavailable / error output when no safe fallback exists

### Freshness and decisions

Display state and decision state differ:

- display state may keep last-good quota indefinitely, as long as the UI labels it stale
- decision state must not treat stale quota as equivalent to fresh quota

Existing ranking code already excludes non-`ok` quota rows from auto-switch candidates. This design keeps that rule. Stale cached quota remains valid for display and operator context, but does not become an unbounded positive auto-switch signal.

## Testing

Add or update behavior tests for:

- dashboard keeps the previous successful snapshot when a later refresh returns quota failures
- dashboard keeps totals and pool lines stable when every quota refresh fails
- CLI current/list behavior for `chatgpt.com/backend-api/wham/usage` network failures
- CLI current/list behavior for `chatgpt.com/backend-api/wham/usage` API error responses
- stale quota continues to display, but auto-switch ranking still ignores non-`ok` rows

## User-facing impact

- the dashboard should stop "jumping" or dropping into a noisy degraded layout on quota refresh errors
- refresh failures should show as warnings/failures, not as a lossy redraw
- CLI refresh commands should make it clear whether data came from runtime, API, cached fallback, or is unavailable
