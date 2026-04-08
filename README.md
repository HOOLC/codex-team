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
codexm launch [name] [--json]
codexm watch [--auto-switch] [--detach] [--status] [--stop]
codexm remove <name> --yes [--json]
codexm rename <old> <new> [--json]
```

Global flags: `--help`, `--version`, `--debug`

Use `--json` on query and mutation commands when you need machine-readable output.
Use `--debug` when you want diagnostic output on stderr, such as command decisions, managed Desktop detection, and switch or launch progress details.
`codexm current` keeps the default current-account summary and, when a codexm-managed Desktop session is available, best-effort adds a live one-line usage view from bridge/MCP rate limits. `codexm current --refresh` prefers that managed MCP quota path and falls back to the usage API for the uniquely matched managed account. In JSON mode it adds a top-level `quota` field whenever usage data is available.
`codexm list` refreshes quota data before printing it, shows the current managed account above the table, marks current rows with `*` in text mode, and includes top-level `current` plus per-row `is_current` fields in JSON mode. The default text table includes the auto-switch `CURRENT SCORE` as a normalized 0..100 plan-relative score; add `--verbose` to show the normalized `1H SCORE` plus the raw 5H/1W breakdown and plan ratio behind it. Ranking uses current bottleneck quota as the primary score, then only falls back to the 1-hour score when current-score gaps are small. `1W` is treated as the shared unit and `5H` is normalized into that unit by plan ratio.
`codexm launch` starts Codex Desktop with the current auth, or switches to a saved account first when you pass a name. If Codex Desktop is already running, `codexm launch` asks before relaunching it. If the running Desktop was started by `codexm launch`, later `codexm switch` tries to apply the new auth to that managed Desktop session automatically; if it was started outside `codexm`, `codexm switch` warns that it only updates local auth, then points you to `codexm launch` so future switches can apply immediately to that launched session. Run `codexm launch` from an external terminal when you need to restart Codex Desktop; running it from inside the current Codex Desktop session is refused because quitting the app would terminate that session. By default, `codexm switch` waits for the current managed Desktop thread to finish before restarting the Codex app server. Use `codexm switch --force` to restart immediately instead. Restarting the app server interrupts the current managed Desktop thread.
`codexm watch` attaches to the managed Codex Desktop DevTools session and injects a renderer probe that tees bridge-level `mcp-request` / `mcp-notification` / `mcp-response` traffic between the GUI and app server. By default it prints a quota-update summary each time managed Desktop quota data changes; pass `--auto-switch` to trigger `switch --auto` when that bridge traffic shows quota exhaustion, such as exhausted `account/rateLimits/*` payloads or `usageLimitExceeded`. If the DevTools watch connection drops, `codexm watch` reports that monitoring is inactive, retries automatically, and resumes once it reconnects. `codexm watch --detach` runs that watcher in the background and writes state to `~/.codex-team/watch-state.json` plus logs to `~/.codex-team/logs/watch.log`; use `codexm watch --status` and `codexm watch --stop` to inspect or stop it. With `--debug`, it additionally prints the normalized bridge `mcp-*` messages plus watch decision logs to stderr.
Unknown commands and flags fail fast instead of being ignored; when there is a close match, `codexm` suggests it.

## Typical flow

1. Log into a target account with the native Codex CLI.
2. Save the current auth snapshot with `codexm save <name>`.
3. Repeat for other accounts.
4. Switch between saved accounts with `codexm switch <name>` or let the tool choose with `codexm switch --auto`.
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
