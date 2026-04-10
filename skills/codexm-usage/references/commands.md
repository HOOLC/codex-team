# codexm command map

- Check the current local auth and best-effort live usage: `codexm current`
- Force a fresh current-account usage refresh: `codexm current --refresh`
- Generate shell completion scripts: `codexm completion <zsh|bash>`
- Add a new managed ChatGPT account with browser login: `codexm add <name>`
- Add a new managed ChatGPT account with device-code login: `codexm add <name> --device-auth`
- Add a managed API-key account from stdin: `printenv OPENAI_API_KEY | codexm add <name> --with-api-key`
- Save the current auth as a named account: `codexm save <name>`
- List saved accounts and refreshed quota state: `codexm list`
- Show auto-switch score details and normalized 1-hour breakdowns: `codexm list --verbose`
- Switch local auth to a saved account: `codexm switch <name>`
- Let `codexm` choose the best account from quota data: `codexm switch --auto`
- Preview the `switch --auto` decision without changing auth: `codexm switch --auto --dry-run`
- Start Codex Desktop with the current auth, switch first, or auto-pick the best account: `codexm launch [name]`, `codexm launch --auto`
- Launch Desktop and ensure a detached watcher is running: `codexm launch --watch`, `codexm launch --auto --watch`
- Watch managed Desktop MCP/quota signals and auto-switch on terminal quota exhaustion: `codexm watch`
- Watch without automatic switching: `codexm watch --no-auto-switch`
- Run the watcher in the background: `codexm watch --detach`, `codexm watch --detach --no-auto-switch`
- Inspect or stop the background watcher: `codexm watch --status`, `codexm watch --stop`
- Refresh the saved snapshot for the current managed account: `codexm update`
- Remove or rename a saved account: `codexm remove <name> --yes`, `codexm rename <old> <new>`

## Common guidance

- Use `codexm current` when the user does not know what auth is active now or wants a quick current-usage summary.
- Use `codexm current --refresh` when the user explicitly wants the latest usage data instead of best-effort live data.
- Use `codexm list` when the user wants to compare saved accounts or inspect quota state.
- Use `codexm list --verbose` when the user wants score details behind auto-switch ranking.
- Use `codexm add <name>` when the user wants to create a managed account without changing current auth.
- Use `codexm add <name> --device-auth` on remote/headless machines where browser callback login is inconvenient.
- Use `codexm save <name>` right after the user has already logged into the desired account with native Codex auth or Codex Desktop.
- Use `codexm update` when the current local auth already matches a managed account and the user wants to refresh the saved snapshot.
- Use `codexm launch [name]` when the user wants Codex Desktop to start with a specific account immediately, and add `--watch` when they also want background quota supervision.
- Use `codexm watch` when the user wants ongoing monitoring with automatic switching; use `codexm watch --no-auto-switch` for observation only.
- Use `codexm completion <zsh|bash>` when the user wants shell completion setup; saved account names are completed dynamically.
