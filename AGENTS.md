# codex-team AGENTS

This file contains repository-stable engineering constraints for agents.
Detailed design notes live in `docs/internal/`.

## Guardrails

- Do not add a command by querying both Desktop and direct runtime paths unless the command semantics explicitly require it.
- Do not spread new platform-specific Desktop process logic outside the Desktop launcher boundary.
- Do not duplicate plan or quota normalization rules outside `src/plan-quota-profile.ts`.
- Before adding legacy interface, data, or code compatibility paths, confirm with the user that backward compatibility is necessary.

## Module Boundaries

- `src/main.ts`: CLI orchestration only.
- `src/commands/*`: command handlers.
- `src/desktop/launcher.ts`: managed Desktop lifecycle, DevTools bridge, Desktop runtime reads, and watch stream handling.
- `src/codex-direct-client.ts`: direct `codex app-server` client for one-shot runtime reads.
- `src/watch/history.ts`: watch history persistence and ETA calculation.
- `src/account-store/service.ts`: account store orchestration and mutation flows.
- `src/plan-quota-profile.ts`: centralized plan normalization and quota ratio rules.
- `src/cli/quota.ts`: quota presentation, list ordering, and auto-switch candidate formatting.

## Runtime Path Rules

- `current`: Desktop-first, direct fallback.
- `watch`: Desktop-only.
- `switch`: Desktop-only.
- `doctor`: direct-first; Desktop only for supplemental consistency checks.

## Quota And Ranking Rules

- Keep plan normalization centralized in `src/plan-quota-profile.ts`.
- Treat ETA as display and analysis data unless a command explicitly uses it for decisions.
- Keep `list` ordering and `auto-switch` ranking as separate concerns when their user goals differ.

## Verification

- For user-visible CLI behavior changes, run `pnpm typecheck` and `pnpm test`.
- Do not add unit tests whose only purpose is to assert static configuration, constant mappings, package script strings, generated README/spec synchronization, or copied implementation snippets. Prefer behavior-level tests or build/generation checks.
- Automated tests and real self-tests must run against cloned temporary runtime state. Never point them at the operator's real `~/.codex` auth/config/store, live Codex TUI sessions, or live Codex Desktop processes.
- Prefer copying only the runtime artifacts needed for the scenario into a temp `HOME` or temp workdir, then use env overrides to exercise the real CLI against that clone.
- Verification must cover resource and lifecycle hygiene, not just happy-path assertions. Explicitly watch for idle busy-loops and CPU/memory/IO spikes; check graceful quit and forced-interrupt paths; and confirm timers, workers, child processes, fs watchers, sockets, lockfiles, temp files, raw-mode/alt-screen state, and cloned runtime directories are released after success, failure, or cancellation.

## References

- `docs/internal/codex-runtime-channels.md`

## User Docs

- Treat `README.md` and `README.zh-CN.md` as user-facing onboarding guides, not internal reference manuals.
- Keep README sections short and task-oriented; prefer a few high-signal commands and examples over exhaustive command listings.
