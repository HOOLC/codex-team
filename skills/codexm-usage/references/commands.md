# codexm command map

- Check the current local auth: `codexm current`
- Save the current auth as a named account: `codexm save <name>`
- List saved accounts and refreshed quota state: `codexm list`
- Switch local auth to a saved account: `codexm switch <name>`
- Let `codexm` choose the best account from quota data: `codexm switch --auto`
- Start Codex Desktop with the current auth, or switch first and then launch: `codexm launch [name]`
- Refresh the saved snapshot for the current managed account: `codexm update`
- Remove or rename a saved account: `codexm remove <name> --yes`, `codexm rename <old> <new>`

## Common guidance

- Use `codexm current` when the user does not know what auth is active now.
- Use `codexm list` when the user wants to compare saved accounts or inspect quota state.
- Use `codexm save <name>` right after the user has logged into the desired account with native Codex auth.
- Use `codexm update` when the current local auth already matches a managed account and the user wants to refresh the saved snapshot.
- Use `codexm launch [name]` when the user wants Codex Desktop to start with a specific account immediately.
