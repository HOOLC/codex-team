# Codex Desktop Proxy Usage Notes

## Goal

Make Codex Desktop show a coherent proxy-owned account and quota view when `codexm proxy` is enabled, without leaking the selected upstream account into Desktop account and usage UI.

## Desktop dependency map

### Account visibility

- `account-info` comes from the Electron main process.
- The returned `plan` is decoded from the current auth token claim `https://api.openai.com/auth.chatgpt_plan_type`.
- Usage settings are visible when auth method is `chatgpt` and `account-info.plan` is `plus`, `pro`, or `prolite`.

### Usage settings data

The Desktop usage settings view depends on these backend routes:

1. `/backend-api/wham/usage`
   - Supplies the displayed rate-limit and credits payload.
   - Current proxy implementation already synthesizes this route for proxy auth.

2. `/backend-api/subscriptions/auto_top_up/settings`
   - Supplies the auto-top-up settings row state.
   - If this route errors, the settings view renders an error row instead of the usage details.

3. `/backend-api/wham/accounts/check`
   - Supplies the current account selection used by the frontend when it needs a concrete ChatGPT account id.
   - This route currently still exposes the real upstream account ordering in proxy mode.

4. `/backend-api/accounts/check/v4-2023-04-27`
   - Used by the auto-top-up dialog for account role and billing currency lookups.
   - Not required for the base usage section to render, but it should remain coherent with the proxy-owned account view.

## Current proxy behavior

### What already works

- `~/.codex/auth.json` is rewritten to synthetic proxy auth.
- Desktop runtime reads the synthetic proxy auth correctly.
- `/backend-api/wham/usage` already returns a synthetic aggregate payload:
  - `plan_type = "pro"`
  - integer `used_percent`
  - unlimited synthetic credits

### What is still broken

1. `/backend-api/subscriptions/auto_top_up/settings` is transparently forwarded.
   - With synthetic proxy auth this returns `403`.
   - Desktop treats that as a usage settings load failure, so quota UI does not render normally.

2. `/backend-api/wham/accounts/check` is transparently forwarded.
   - Proxy mode therefore exposes real upstream account ids and plans to Desktop.
   - Desktop can show a real upstream account context instead of the synthetic proxy account context.

3. `/backend-api/accounts/check/v4-2023-04-27` is also transparently forwarded and returns `403` for synthetic auth.
   - This is primarily an auto-top-up dialog issue, but it is part of the same proxy-owned account surface.

## Recommended proxy contract

When proxy mode is enabled and the incoming request is synthetic proxy auth or a Codex Desktop request, treat the Desktop usage/account routes as a synthetic proxy account surface.

### Synthetic routes

- `/backend-api/wham/usage`
  - Keep the existing synthetic aggregate behavior.

- `/backend-api/wham/accounts/check`
  - Return a synthetic account list with:
    - `default_account_id = "codexm-proxy-account"`
    - `account_ordering = ["codexm-proxy-account"]`
    - a single account entry representing the proxy-owned account
  - Keep the account identity stable and proxy-owned.

- `/backend-api/subscriptions/auto_top_up/settings`
  - Return a synthetic disabled state so the usage page can render:
    - `is_enabled = false`
    - `recharge_threshold = null`
    - `recharge_target = null`

- `/backend-api/accounts/check/v4-2023-04-27`
  - Return a synthetic account map for the proxy account so the auto-top-up dialog does not query a missing upstream account.
  - Minimal required fields:
    - `accounts["codexm-proxy-account"].account.account_user_role`
    - `accounts["codexm-proxy-account"].entitlement.billing_currency`

## Rationale

- Desktop should see proxy mode as a single synthetic account surface.
- The chosen upstream account is an internal transport detail.
- Mixing synthetic usage with real upstream account metadata produces inconsistent UI and makes proxy mode appear to be a real saved upstream account.

## Last-good quota cache

### Goal

Keep `codexm list` and TUI readable when a refresh fails, without relying on a single global snapshot.

### Contract

- Store `last_good_quota` per managed account in that account's `meta.json`.
- Update `last_good_quota` whenever a quota refresh succeeds.
- Also update it when list/TUI completes with a good account snapshot that includes usable quota windows.
- On refresh failure:
  - prefer `last_good_quota`
  - mark the displayed row as `stale`
  - keep a bounded max age

### Max age

- Use `7d`.
- This keeps the fallback aligned with the longest quota window while avoiding effectively unbounded stale display.

## Verification targets

- Desktop proxy auth can fetch:
  - `/backend-api/wham/usage`
  - `/backend-api/wham/accounts/check`
  - `/backend-api/subscriptions/auto_top_up/settings`
  - `/backend-api/accounts/check/v4-2023-04-27`
- `codexm list` and TUI show `[stale]` rows from account-scoped `last_good_quota` after a refresh failure.
- Fallback does not apply when the stored `last_good_quota` is older than the configured max age.
