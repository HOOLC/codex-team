# codex-team

`codex-team` is a small CLI for managing multiple Codex ChatGPT login snapshots on one machine.

It stores named snapshots under `~/.codex-team/`, lets you switch the active `~/.codex/auth.json`, and can cache quota usage including 5-hour and weekly window status.

## Install

```bash
npm install -g codex-team
```

After install, use the `codexm` command.

## Shell completion

Generate a shell completion script and install it with your shell's standard mechanism:

```bash
mkdir -p ~/.zsh/completions
codexm completion zsh > ~/.zsh/completions/_codexm
mkdir -p ~/.local/share/bash-completion/completions
codexm completion bash > ~/.local/share/bash-completion/completions/codexm
```

The generated scripts dynamically complete saved account names by calling `codexm completion --accounts`.

## Commands

```bash
codexm --version
codexm completion <zsh|bash>
codexm current [--refresh] [--json]
codexm list [name] [--verbose] [--json]
codexm save <name> [--force] [--json]
codexm update [--json]
codexm switch <name> [--force] [--json]
codexm switch --auto --dry-run [--force] [--json]
codexm launch [name] [--auto] [--watch] [--no-auto-switch] [--json]
codexm watch [--no-auto-switch] [--detach] [--status] [--stop]
codexm remove <name> --yes [--json]
codexm rename <old> <new> [--json]
```

Global flags: `--help`, `--version`, `--debug`

Use `--json` for machine-readable output and `--debug` for stderr diagnostics.

- `codexm current` keeps the default current-auth summary, prefers managed Desktop MCP account state when available, and labels whether the result came from MCP or local `auth.json`; when the running managed Desktop auth differs from local `auth.json`, it prints a warning. `--refresh` prefers managed Desktop MCP quota when a codexm-managed session is available and falls back to the usage API. JSON output adds a top-level `quota` field whenever usage data is available.
- `codexm list` refreshes quota data before printing, shows the current managed account above the table, marks current rows with `*`, and includes top-level `current` plus per-row `is_current` fields in JSON mode. The default table shows normalized `CURRENT SCORE`; add `--verbose` for normalized `1H SCORE`, raw 5H/1W breakdown, and plan ratio details.
- `codexm launch` starts Codex Desktop with current auth, switches first when you pass a saved account name, or picks the best saved account with `codexm launch --auto`. Add `--watch` to ensure a detached background watcher is running after launch; by default that watcher auto-switches on terminal quota events, and `--no-auto-switch` turns it into a read-only quota watcher. A codexm-managed Desktop session can accept later `codexm switch` updates directly; unmanaged sessions only update local auth and point you back to `codexm launch`. Run `codexm launch` from an external terminal if you need to restart Desktop, and use `codexm switch --force` when you want to skip waiting for the current managed Desktop thread.
- `codexm switch`, `codexm switch --auto`, and auth-changing `codexm launch` flows share a cross-process lock under `~/.codex-team/locks/switch.lock` so only one auth-changing operation runs at a time. If the lock is busy, the CLI reports the lock path and the owning command; `watch` skips that cycle instead of queueing behind an in-flight switch.
- `codexm watch` attaches to the managed Codex Desktop DevTools session, tracks bridge-level quota signals, prints structured quota updates, and by default can trigger `switch --auto` on terminal quota events such as exhausted `account/rateLimits/*` payloads or `usageLimitExceeded`. Use `--no-auto-switch` to keep the same quota feed without changing accounts. `--detach` runs the watcher in the background and stores state in `~/.codex-team/watch-state.json` with logs under `~/.codex-team/logs/watch.log`; use `--status` and `--stop` to inspect or stop it.

Unknown commands and flags fail fast; when there is a close match, `codexm` suggests it.

## Typical flow

1. Log into a target account with the native Codex CLI.
2. Save the current auth snapshot with `codexm save <name>`.
3. Repeat for other accounts.
4. Switch between saved accounts with `codexm switch <name>`, let the tool choose with `codexm switch --auto`, or start Desktop on the best candidate with `codexm launch --auto --watch`.
5. Refresh and inspect quota usage with `codexm list`.

For ChatGPT auth snapshots, `codex-team` can save and switch different users under the same ChatGPT account/workspace as separate managed entries when the local login tokens distinguish them.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
