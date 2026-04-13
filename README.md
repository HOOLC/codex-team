# codex-team

`codex-team` is a small CLI for managing multiple Codex ChatGPT login snapshots on one machine.

It stores named snapshots under `~/.codex-team/`, lets you switch the active `~/.codex/auth.json`, and can cache quota usage including 5-hour and weekly window status.

## Install

```bash
npm install -g codex-team
```

After install, use the `codexm` command.

## Quick start

```bash
npm install -g codex-team
codexm add plus1
codexm add team1
codexm launch --watch
```

`codexm add` opens a login flow and stores each account as a named snapshot. `codexm launch --watch` starts Codex Desktop and keeps a background watcher running so quota exhaustion can switch to the best available saved account.

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
codexm add <name> [--device-auth|--with-api-key] [--force] [--json]
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

- `codexm current` shows the active account. It uses the running managed Desktop session when available, falls back to local `auth.json`, and warns if those differ. Add `--refresh` to include current quota usage.
- `codexm list` refreshes quota data before printing, shows the current managed account above the table, marks current rows with `*`, and includes top-level `current` plus per-row `is_current` fields in JSON mode. The default table shows normalized `CURRENT SCORE`; add `--verbose` for normalized `1H SCORE`, raw 5H/1W breakdown, and plan ratio details. The `AVAILABLE` column is binary (`available` or `unavailable`). Text output highlights exhausted accounts with a red row background, applies one remaining-quota threshold set across score and usage columns (`<=10%` red, `<20%` yellow, both bold), and shows reset times within one hour with a cyan `(Xm)` suffix.
- `codexm add <name>` creates a new managed account without changing the active `~/.codex/auth.json`. By default it uses the built-in browser ChatGPT login flow; add `--device-auth` for device-code login on remote/headless machines. `--with-api-key` reads an API key from stdin, for example `printenv OPENAI_API_KEY | codexm add work-api --with-api-key`.
- `codexm launch` starts Codex Desktop with current auth, switches first when you pass a saved account name, or picks the best saved account with `codexm launch --auto`. Add `--watch` to keep a detached watcher running after launch. Run `codexm launch` from an external terminal if you need to restart Desktop.
- `codexm switch`, `codexm switch --auto`, and auth-changing `codexm launch` flows share a cross-process lock under `~/.codex-team/locks/switch.lock` so only one auth-changing operation runs at a time. If the lock is busy, the CLI reports the lock path and the owning command; `watch` skips that cycle instead of queueing behind an in-flight switch.
- `codexm watch` watches the managed Codex Desktop session, prints quota updates, and by default auto-switches when the active account is exhausted. Use `--no-auto-switch` for read-only watching. `--detach` runs it in the background; use `--status` and `--stop` to inspect or stop it.

Unknown commands and flags fail fast; when there is a close match, `codexm` suggests it.

## Typical flow

1. Add target accounts with `codexm add <name>` or save the currently active Codex auth with `codexm save <name>`.
2. Repeat for other accounts.
3. Switch between saved accounts with `codexm switch <name>`, let the tool choose with `codexm switch --auto`, or start Desktop on the best candidate with `codexm launch --auto --watch`.
4. Refresh and inspect quota usage with `codexm list`.

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
