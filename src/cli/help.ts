import type { AccountStore } from "../account-store/index.js";
import {
  ACCOUNT_NAME_PATTERN,
  COMMAND_FLAGS,
  COMMAND_NAMES,
  GLOBAL_FLAGS,
  HELP_NOTES,
  PROGRAM_NAME,
  PROGRAM_SUMMARY,
  getCommandSpec,
  getFlagDescription,
  isCompletionAccountCommand,
  listGlobalFlags,
  listHelpUsageLines,
} from "./spec.js";

function quoteBashWords(words: readonly string[]): string {
  return words.join(" ");
}

function describeCommandFlag(flag: string): string {
  return `${flag}:${getFlagDescription(flag)}`;
}

export function buildHelpText(): string {
  const usageLines = listHelpUsageLines()
    .map((usage) => `  ${usage}`)
    .join("\n");
  const noteLines = HELP_NOTES
    .map((note) => `  ${note}`)
    .join("\n");

  return `${PROGRAM_NAME} - ${PROGRAM_SUMMARY}

Usage:
  ${PROGRAM_NAME} --version
  ${PROGRAM_NAME} --help
${usageLines}

Global flags: ${listGlobalFlags().join(", ")}

Notes:
${noteLines}

Account names must match /${ACCOUNT_NAME_PATTERN}/.
`;
}

export function printHelp(stream: NodeJS.WriteStream): void {
  stream.write(buildHelpText());
}

export function buildCompletionZshScript(): string {
  const commands = COMMAND_NAMES.map((command) => `'${command}:${command} command'`).join("\n    ");
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

  const accountCommandPattern = COMMAND_NAMES.filter((command) => isCompletionAccountCommand(command)).join("|");
  const completionTargets = getCommandSpec("completion").completionTargets ?? [];

  return `#compdef ${PROGRAM_NAME}

_${PROGRAM_NAME}() {
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
${completionTargets.map((target) => `      '${target}:${target} completion script' \\`).join("\n")}
      '--accounts:${getFlagDescription("--accounts")}'
    return 0
  fi

  if (( CURRENT == 3 )) && [[ \${words[CURRENT]} != --* ]]; then
    case \$command in
      ${accountCommandPattern}) ;;
      *) return 0 ;;
    esac

    accounts=(\${(@f)\$(${PROGRAM_NAME} completion --accounts 2>/dev/null)})
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

_${PROGRAM_NAME} "$@"
`;
}

export function buildCompletionBashScript(): string {
  const commands = COMMAND_NAMES.join(" ");
  const globalFlags = [...GLOBAL_FLAGS].join(" ");
  const commandCases = COMMAND_NAMES.map((command) => {
    const flags = [...COMMAND_FLAGS[command]].join(" ");
    return `    ${command}) command_flags="${flags}" ;;`;
  }).join("\n");

  const accountCommandCases = COMMAND_NAMES
    .filter((command) => isCompletionAccountCommand(command))
    .map((command) => `    ${command})`)
    .join("|");
  const completionTargets = (getCommandSpec("completion").completionTargets ?? []).join(" ");

  return `_${PROGRAM_NAME}() {
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
    COMPREPLY=( $(compgen -W "${completionTargets} --accounts" -- "\${cur}") )
    return 0
  fi

  if [[ \${COMP_CWORD} -eq 2 && "\${cur}" != --* ]]; then
    case "\${command}" in
      ${accountCommandCases})
        accounts="$(${PROGRAM_NAME} completion --accounts 2>/dev/null)"
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

complete -F _${PROGRAM_NAME} ${PROGRAM_NAME}
`;
}

export async function listCompletionAccountNames(store: AccountStore): Promise<string[]> {
  const { accounts } = await store.listAccounts();
  return accounts.map((account) => account.name).sort((left, right) => left.localeCompare(right));
}
