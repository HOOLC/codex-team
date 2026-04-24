# codex-team AGENTS

This file contains repository-stable engineering constraints for agents.
Detailed design notes live in `docs/internal/`.

## Guardrails

- Do not add a command by querying both Desktop and direct runtime paths unless the command semantics explicitly require it.
- Do not spread new platform-specific Desktop process logic outside the Desktop launcher boundary.
- Do not duplicate plan or quota normalization rules outside `src/plan-quota-profile.ts`.
- Do not duplicate share-bundle schema or file I/O rules outside `src/share-bundle.ts`.
- Before adding legacy interface, data, or code compatibility paths, confirm with the user that backward compatibility is necessary.

## Module Boundaries

- `src/main.ts`: CLI orchestration only.
- `src/commands/*`: command handlers.
- `src/share-bundle.ts`: trusted share-bundle schema and file read/write helpers.
- `src/commands/share-bundle.ts`: CLI import, export, and inspect flows for share bundles.
- `src/commands/tui-share.ts`: dashboard import, export, delete, and undo flows.
- `src/tui/index.ts`: interactive dashboard rendering, layout, prompts, and action contracts.
- `src/desktop/launcher.ts`: managed Desktop lifecycle, DevTools bridge, Desktop runtime reads, and watch stream handling.
- `src/codex-cli-runner.ts`: `codexm run` restart, resume, and session discovery flow.
- `src/codex-direct-client.ts`: direct `codex app-server` client for one-shot runtime reads.
- `src/watch/history.ts`: watch history persistence and ETA calculation.
- `src/account-store/service.ts`: account store orchestration and mutation flows.
- `src/plan-quota-profile.ts`: centralized plan normalization and quota ratio rules.
- `src/cli/quota.ts`: quota presentation, list ordering, and auto-switch candidate formatting.
- `src/cli/quota-display.ts`: shared list and dashboard emphasis, color, and truncation rules.

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
- Automated tests and live-run validation must run against cloned temporary runtime state. Never point them at the operator's real `~/.codex` auth/config/store, live Codex TUI sessions, or live Codex Desktop processes.
- Prefer copying only the runtime artifacts needed for the scenario into a temp `HOME` or temp workdir, then use env overrides to exercise the real CLI against that clone.
- Live-run validation may use live ChatGPT/OpenAI services and auth when needed, but must not write to the operator's local session/thread data or interfere with existing CLI, TUI, or Desktop instances. Use a temp `HOME`, isolated `CODEX_HOME`, or codexm overlay so generated sessions, logs, sockets, and auth/config writes stay outside the live runtime.
- Never stop, restart, disable, enable, or repoint the operator's currently relied-on `codexm` proxy or daemon as part of agent validation. When proxy or daemon behavior needs live verification, run an isolated instance on separate state and, when needed, a separate port.
- For user-visible CLI, TUI, proxy, daemon, watch, run, share-bundle, or Desktop behavior changes, run the smallest relevant live-run validation subset from `docs/internal/live-run-validation/` before pushing or updating a PR. This is not required for every inner-loop development iteration.
- Verification must cover resource and lifecycle hygiene, not just happy-path assertions. Explicitly watch for idle busy-loops and CPU/memory/IO spikes; check graceful quit and forced-interrupt paths; and confirm timers, workers, child processes, fs watchers, sockets, lockfiles, temp files, raw-mode/alt-screen state, and cloned runtime directories are released after success, failure, or cancellation.

## References

- `docs/internal/codex-runtime-channels.md`
- `docs/internal/live-run-validation/overview.md`
- `docs/internal/`: detailed design notes and longer operational references live here; keep this file focused on repo-stable contract.

## User Docs

- Treat `README.md` and `README.zh-CN.md` as user-facing onboarding guides, not internal reference manuals.
- Treat `skills/*` as user-facing onboarding material for coding agents, not runtime requirements.
- Keep README sections short and task-oriented; prefer a few high-signal commands and examples over exhaustive command listings.
- If a change affects user-visible commands, flags, output, TUI interaction, or packaging expectations, update `README.md`, `README.zh-CN.md`, and any affected agent-skill files in the same change.
- Treat `src/cli/spec.json` as the source of truth for spec-driven CLI usage/help text and generated README command sections; do not hand-edit generated copies first.
- Run `pnpm docs:readme` after editing spec-backed README command entries.
