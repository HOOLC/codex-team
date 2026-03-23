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
codexm current
codexm list [name]
codexm save <name>
codexm update
codexm switch <name>
codexm switch --auto --dry-run
codexm remove <name> --yes
codexm rename <old> <new>
codexm quota refresh [name]
codexm doctor
```

Use `--json` on query and mutation commands when you need machine-readable output.

## Typical flow

1. Log into a target account with the native Codex CLI.
2. Save the current auth snapshot with `codexm save <name>`.
3. Repeat for other accounts.
4. Switch between saved accounts with `codexm switch <name>` or let the tool choose with `codexm switch --auto`.
5. Refresh and inspect quota usage with `codexm list` or `codexm quota refresh`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
