# codexm dashboard reference

`codexm` in a TTY and `codexm tui [query]` open the same interactive dashboard.

The bottom hint bar adapts to terminal width: narrow terminals use shorter labels, and wider terminals expand the same actions to fuller wording such as `Enter switch`, `a autoswitch`, and `e export`.

## Main list

Use these keys while browsing the account list:

| Key | Action |
| --- | --- |
| `j` / `k`, `Up` / `Down` | Move the selection |
| `g` / `Home` | Jump to the first row |
| `G` / `End` | Jump to the last row |
| `/` | Enter filter mode |
| `Enter` | Switch to the selected direct account; on the synthetic `proxy` row, toggle proxy on or off |
| `f` | Reload the current selection or force-switch it; on the current `proxy` row this reapplies proxy wiring |
| `a` | Toggle daemon-backed autoswitch |
| `p` | Toggle whether the selected direct account can be picked as an autoswitch target |
| `o` | Switch, then open Codex TUI |
| `O` | Switch, then open isolated Codex |
| `d` | Switch, then open or focus Codex Desktop |
| `Shift+D` | Confirm and relaunch Codex Desktop |
| `e` | Export the selected managed direct account |
| `i` | Import a share bundle |
| `x` | Delete the selected managed direct account after confirmation |
| `u` | Undo the latest import, export, or delete |
| `r` | Refresh quota and dashboard state |
| `Esc` | Clear the temporary detail override or back out of the current prompt |
| `q` | Quit from the main dashboard |
| `Ctrl-C` | Quit immediately |

## Row-specific behavior

- The synthetic `proxy` row cannot be protected, exported, or deleted from the dashboard.
- Selecting the current direct account and pressing `Enter` does not switch again; the dashboard tells you to use `f` to reload it.
- While proxy mode is enabled, `@` marks the configured real upstream row. The `proxy` row stays visible even when proxy mode is off.

## Filter mode

After pressing `/`:

| Key | Action |
| --- | --- |
| Text input | Update the filter query |
| `Backspace` | Delete before the cursor |
| `Ctrl-U` | Clear the whole query |
| `Left` / `Right` | Move the cursor |
| `Enter` | Apply the filter and return to the main list |
| `Esc` | Leave filter mode |

## Import and export prompts

The export path prompt and import path/name prompts share the same controls:

| Key | Action |
| --- | --- |
| Text input | Edit the current value |
| `Backspace` | Delete before the cursor |
| `Ctrl-U` | Clear the whole field |
| `Left` / `Right` | Move the cursor |
| `Enter` | Confirm |
| `Esc` | Go back; on import-name it returns to the bundle-path step |

The dashboard no longer has a dedicated shortcut for exporting the current live auth. Use `codexm export` for that case.

## Confirm dialogs

Delete, stale-daemon cleanup, and Desktop relaunch confirmations use:

| Key | Action |
| --- | --- |
| `y` | Confirm |
| `n`, `Enter`, or `Esc` | Cancel |
| `q` / `Ctrl-C` | Quit the dashboard |

## Busy operations

While a switch, import, export, refresh, or Desktop action is running:

| Key | Action |
| --- | --- |
| `Esc` / `Ctrl-C` | Cancel the active operation |
| `j` / `k`, `Up` / `Down`, `g` / `G` | Keep browsing the list while the operation runs |
| `q` | Show the cancel hint instead of quitting immediately |

If a managed Desktop refresh must wait for the active thread to finish, the status line shows the wait progress until the switch can continue.
