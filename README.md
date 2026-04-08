# codex-team

`codex-team` is a small CLI for managing multiple Codex ChatGPT login snapshots on one machine.

It stores named snapshots under `~/.codex-team/`, lets you switch the active `~/.codex/auth.json`, and can cache quota usage including 5-hour and weekly window status.

## Install

```bash
npm install -g codex-team
```

After install, use the `codexm` command.

## Commands

```bash
codexm --version
codexm current [--refresh] [--json]
codexm list [name] [--json]
codexm save <name> [--force] [--json]
codexm update [--json]
codexm switch <name> [--force] [--json]
codexm switch --auto --dry-run [--force] [--json]
codexm launch [name] [--json]
codexm watch [--auto-switch]
codexm remove <name> --yes [--json]
codexm rename <old> <new> [--json]
```

Global flags: `--help`, `--version`, `--debug`

Use `--json` on query and mutation commands when you need machine-readable output.
Use `--debug` when you want diagnostic output on stderr, such as command decisions, managed Desktop detection, and switch or launch progress details.
`codexm list` refreshes quota data before printing it, shows the current managed account above the table, marks current rows with `*` in text mode, and includes top-level `current` plus per-row `is_current` fields in JSON mode.
`codexm launch` starts Codex Desktop with the current auth, or switches to a saved account first when you pass a name. If Codex Desktop is already running, `codexm launch` asks before relaunching it. If the running Desktop was started by `codexm launch`, later `codexm switch` tries to apply the new auth to that managed Desktop session automatically; if it was started outside `codexm`, `codexm switch` warns that it only updates local auth, then points you to `codexm launch` so future switches can apply immediately to that launched session. Run `codexm launch` from an external terminal when you need to restart Codex Desktop; running it from inside the current Codex Desktop session is refused because quitting the app would terminate that session. By default, `codexm switch` waits for the current managed Desktop thread to finish before restarting the Codex app server. Use `codexm switch --force` to restart immediately instead. Restarting the app server interrupts the current managed Desktop thread.
`codexm watch` attaches to the managed Codex Desktop DevTools session and injects a renderer probe that tees bridge-level `mcp-request` / `mcp-notification` / `mcp-response` traffic between the GUI and app server. By default it only observes and prints bridge traffic; pass `--auto-switch` to trigger `switch --auto` when that bridge traffic shows quota exhaustion, such as exhausted `account/rateLimits/*` payloads or `UsageLimitExceeded`. With `--debug`, it prints the normalized bridge `mcp-*` messages plus watch decision logs to stderr.
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
