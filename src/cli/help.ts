import type { AccountStore } from "../account-store/index.js";
import { COMMAND_FLAGS, COMMAND_NAMES, GLOBAL_FLAGS } from "./args.js";

const COMPLETION_ACCOUNT_COMMANDS = new Set(["launch", "list", "remove", "rename", "switch"] as const);

function quoteBashWords(words: readonly string[]): string {
  return words.join(" ");
}

function describeCommandFlag(flag: string): string {
  switch (flag) {
    case "--accounts":
      return `${flag}:print saved account names for shell completion`;
    case "--auto":
      return `${flag}:switch to the best available account`;
    case "--debug":
      return `${flag}:enable debug logging`;
    case "--detach":
      return `${flag}:run watch in the background`;
    case "--device-auth":
      return `${flag}:add account with device-code login`;
    case "--no-auto-switch":
      return `${flag}:watch without switching accounts automatically`;
    case "--dry-run":
      return `${flag}:show the selected account without switching`;
    case "--force":
      return `${flag}:skip confirmation and force the action`;
    case "--help":
      return `${flag}:show help`;
    case "--json":
      return `${flag}:print JSON output`;
    case "--refresh":
      return `${flag}:refresh quota data before printing`;
    case "--status":
      return `${flag}:show background watch status`;
    case "--stop":
      return `${flag}:stop the background watch`;
    case "--watch":
      return `${flag}:start a detached watch after launch`;
    case "--with-api-key":
      return `${flag}:add account by reading an API key from stdin`;
    case "--version":
      return `${flag}:print the installed version`;
    case "--yes":
      return `${flag}:skip removal confirmation`;
    default:
      return `${flag}:option`;
  }
}

export function printHelp(stream: NodeJS.WriteStream): void {
  stream.write(`codexm - manage multiple Codex ChatGPT auth snapshots

Usage:
  codexm --version
  codexm --help
  codexm completion <zsh|bash>
  codexm current [--refresh] [--json]
  codexm doctor [--json]
  codexm list [name] [--verbose] [--json]
  codexm add <name> [--device-auth|--with-api-key] [--force] [--json]
  codexm save <name> [--force] [--json]
  codexm update [--json]
  codexm switch <name> [--force] [--json]
  codexm switch --auto [--dry-run] [--force] [--json]
  codexm launch [name] [--auto] [--watch] [--no-auto-switch] [--json]
  codexm watch [--no-auto-switch] [--detach] [--status] [--stop]
  codexm remove <name> [--yes] [--json]
  codexm rename <old> <new> [--json]

Global flags: --help, --version, --debug

Notes:
  codexm current shows live usage when a managed Codex Desktop session is available.
  codexm current --refresh prefers managed Desktop MCP quota, then falls back to the usage API.
  codexm doctor checks local auth, direct app-server probes, and managed Desktop consistency.
  codexm list refreshes quota data, shows the current managed account, and marks current rows with "*"; use --verbose to expand score inputs.
  Run codexm launch from an external terminal if you need to restart Codex Desktop.
  Unknown commands and flags fail fast; close matches include a suggestion.

Account names must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.
`);
}

export function buildCompletionZshScript(): string {
  const commands = COMMAND_NAMES.map((command) => `'${command}:${command} command'`).join("\n    ");
  // `_describe` expects `name:description`; if we pass `--flag[description]`,
  // zsh treats the whole string as the inserted completion candidate.
  const globalFlags = [...GLOBAL_FLAGS].map(describeCommandFlag).map((flag) => `'${flag}'`).join("\n    ");

  const commandCases = COMMAND_NAMES.map((command) => {
    const flags = [...COMMAND_FLAGS[command]]
      .map(describeCommandFlag)
      .map((flag) => `'${flag}'`)
      .join(" ");
    return `    ${command})
      command_flags=(${flags})
      ;;`;
  }).join("\n");

  const accountCommandPattern = [...COMPLETION_ACCOUNT_COMMANDS].join("|");

  return `#compdef codexm

_codexm() {
  local -a commands global_flags command_flags accounts
  local command=\${words[2]}

  commands=(
    ${commands}
  )
  global_flags=(
    ${globalFlags}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'command' commands
    _describe -t flags 'global flag' global_flags
    return 0
  fi

  if [[ \$command == completion ]]; then
    _describe -t completion-target 'completion target' \\
      'zsh:zsh completion script' \\
      'bash:bash completion script' \\
      '--accounts:print saved account names for completion'
    return 0
  fi

  if (( CURRENT == 3 )) && [[ \${words[CURRENT]} != --* ]]; then
    case \$command in
      ${accountCommandPattern}) ;;
      *) return 0 ;;
    esac

    accounts=(\${(@f)\$(codexm completion --accounts 2>/dev/null)})
    if (( \${#accounts[@]} > 0 )); then
      _describe -t accounts 'account' accounts
      return 0
    fi
  fi

  command_flags=()
  case \$command in
${commandCases}
  esac

  if [[ \${words[CURRENT]} == --* ]]; then
    _describe -t flags 'global flag' global_flags
    _describe -t flags 'command flag' command_flags
  fi
}

_codexm "$@"
`;
}

export function buildCompletionBashScript(): string {
  const commands = COMMAND_NAMES.join(" ");
  const globalFlags = [...GLOBAL_FLAGS].join(" ");
  const commandCases = COMMAND_NAMES.map((command) => {
    const flags = [...COMMAND_FLAGS[command]].join(" ");
    return `    ${command}) command_flags="${flags}" ;;`;
  }).join("\n");

  const accountCommandCases = [...COMPLETION_ACCOUNT_COMMANDS]
    .map((command) => `    ${command})`)
    .join("|");

  return `_codexm() {
  local cur prev command command_flags global_flags commands accounts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"
  global_flags="${quoteBashWords([...GLOBAL_FLAGS])}"
  commands="${commands}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands} \${global_flags}" -- "\${cur}") )
    return 0
  fi

  if [[ "\${command}" == "completion" ]]; then
    COMPREPLY=( $(compgen -W "zsh bash --accounts" -- "\${cur}") )
    return 0
  fi

  if [[ \${COMP_CWORD} -eq 2 && "\${cur}" != --* ]]; then
    case "\${command}" in
      ${accountCommandCases})
        accounts="$(codexm completion --accounts 2>/dev/null)"
        COMPREPLY=( $(compgen -W "\${accounts}" -- "\${cur}") )
        return 0
        ;;
    esac
  fi

  command_flags=""
  case "\${command}" in
${commandCases}
  esac

  if [[ "\${cur}" == --* ]]; then
    COMPREPLY=( $(compgen -W "\${global_flags} \${command_flags}" -- "\${cur}") )
  fi
}

complete -F _codexm codexm
`;
}

export async function listCompletionAccountNames(store: AccountStore): Promise<string[]> {
  const { accounts } = await store.listAccounts();
  return accounts.map((account) => account.name).sort((left, right) => left.localeCompare(right));
}
