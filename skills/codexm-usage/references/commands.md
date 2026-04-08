# codexm command map

- Check the current local auth and best-effort live usage: `codexm current`
- Force a fresh current-account usage refresh: `codexm current --refresh`
- Generate shell completion scripts: `codexm completion <zsh|bash>`
- Save the current auth as a named account: `codexm save <name>`
- List saved accounts and refreshed quota state: `codexm list`
- Show auto-switch score details and normalized 1-hour breakdowns: `codexm list --verbose`
- Switch local auth to a saved account: `codexm switch <name>`
- Let `codexm` choose the best account from quota data: `codexm switch --auto`
- Preview the `switch --auto` decision without changing auth: `codexm switch --auto --dry-run`
- Start Codex Desktop with the current auth, or switch first and then launch: `codexm launch [name]`
- Watch managed Desktop MCP/quota signals: `codexm watch`
- Watch and auto-switch on quota exhaustion: `codexm watch --auto-switch`
- Run the watcher in the background: `codexm watch --detach [--auto-switch]`
- Inspect or stop the background watcher: `codexm watch --status`, `codexm watch --stop`
- Refresh the saved snapshot for the current managed account: `codexm update`
- Remove or rename a saved account: `codexm remove <name> --yes`, `codexm rename <old> <new>`

## Common guidance

- Use `codexm current` when the user does not know what auth is active now or wants a quick current-usage summary.
- Use `codexm current --refresh` when the user explicitly wants the latest usage data instead of best-effort live data.
- Use `codexm list` when the user wants to compare saved accounts or inspect quota state.
- Use `codexm list --verbose` when the user wants score details behind auto-switch ranking.
- Use `codexm save <name>` right after the user has logged into the desired account with native Codex auth.
- Use `codexm update` when the current local auth already matches a managed account and the user wants to refresh the saved snapshot.
- Use `codexm launch [name]` when the user wants Codex Desktop to start with a specific account immediately.
- Use `codexm watch` for observation only; add `--auto-switch` only when the user wants automatic account switching.
- Use `codexm completion <zsh|bash>` when the user wants shell completion setup; saved account names are completed dynamically.
