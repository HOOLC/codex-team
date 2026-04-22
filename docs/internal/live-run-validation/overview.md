# Live-Run Validation

`live-run validation` (`实际运行验证`) is a replayable developer-run acceptance check against the built `codexm` CLI and TUI in an isolated runtime. It is distinct from unit tests, integration tests, and device-specific "real machine" testing: the point is to exercise the shipped operator surface the way a user would, while still keeping the operator's live runtime untouched.

## When To Run

- Inner-loop development: optional. Use automated tests first while iterating.
- Before pushing or updating a PR that changes user-visible CLI, TUI, proxy, daemon, watch, run, share-bundle, or Desktop behavior: run the smallest relevant live-run validation subset that covers every touched feature area.
- When a change crosses multiple surfaces or changes shared presentation/runtime wiring, run the full core suite in [minimal-live-run-suite.md](./minimal-live-run-suite.md).
- For static config, generated docs, or non-behavioral refactors, live-run validation is not required unless the operator workflow or output contract changed.

## Isolation Rules

- Run the built artifact, not `tsx` source. Use `node dist/cli.cjs ...` after `pnpm build`.
- Always use a temp `HOME` and isolated `CODEX_HOME`.
- Copy only the runtime artifacts the scenario needs. The default bootstrap is:

```bash
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codexm-live-run.XXXXXX")"
export HOME="$TMP_ROOT/home"
export CODEX_HOME="$HOME/.codex"
export CODEXM_PROXY_PORT=16655
mkdir -p "$HOME/.codex" "$HOME/.codex-team"

cp ~/.codex/auth.json "$HOME/.codex/auth.json"
test -f ~/.codex/config.toml && cp ~/.codex/config.toml "$HOME/.codex/config.toml"
test -d ~/.codex-team/accounts && cp -R ~/.codex-team/accounts "$HOME/.codex-team/accounts"
test -f ~/.codex-team/state.json && cp ~/.codex-team/state.json "$HOME/.codex-team/state.json"
```

- If a case only needs a subset of those files, prefer the smaller copy.
- If the cloned current auth is already the synthetic `proxy` auth, either copy the temp runtime's `.codex-team/proxy/` backup state as well or immediately switch to a direct managed account before running non-proxy cases.
- Use a non-default `CODEXM_PROXY_PORT` so live-run validation cannot collide with the live shared daemon/proxy.
- TUI cases must run in a real TTY or PTY so layout, focus, raw-mode, and quit behavior are observable.
- Every case must leave the temp runtime clean: stop daemon/watch/proxy processes, remove temp directories, and confirm no background owner is left pointing at the temp runtime.

## Case Schema

Each case entry should include:

- `ID`: stable case identifier such as `CLI-READ-01`
- `Name`: short operator-facing label
- `Surface`: `CLI`, `TUI`, `Desktop`, or mixed
- `Feature coverage`: commands, shortcuts, or behaviors the case proves
- `Run when`: code or UX areas that should trigger the case before push
- `Platform`: `all`, `macOS`, or other scoped environment
- `Setup`: required runtime artifacts, accounts, auth, or environment variables
- `Operation path`: ordered user actions or commands to replay
- `Validation points`: the exact effects, output, and hygiene signals that must hold
- `Cleanup`: shutdown and artifact removal steps
- `Cost`: approximate time plus whether live auth or network is required
- `Automation overlap`: related automated tests so readers know what this case is adding beyond unit/integration coverage

Optional fields are `failure signatures`, `notes`, and `known acceptable variance`.

## Suite Layout

- [minimal-live-run-suite.md](./minimal-live-run-suite.md): the smallest durable case set that collectively covers the main operator surfaces

The suite is intentionally split into `core` and `extension` cases:

- `core`: run when the touched surface is user-visible and the path is practical on a normal developer machine
- `extension`: higher-cost or environment-specific flows such as login capture, managed Desktop lifecycle, or TUI runtime handoff

The goal is not to run everything on every branch. The goal is to have a replayable minimal case map so a PR push always has the right amount of real operator coverage.
