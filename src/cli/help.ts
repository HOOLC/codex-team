import type { AccountStore } from "../account-store/index.js";
import {
  ACCOUNT_NAME_PATTERN,
  COMMAND_FLAGS,
  COMMAND_SPECS,
  COMMAND_NAMES,
  GLOBAL_FLAGS,
  HELP_NOTES,
  PROGRAM_NAME,
  PROGRAM_SUMMARY,
  getCommandSpec,
  getFlagDescription,
  isCompletionAccountCommand,
  listCommandAliases,
  listFlagAliases,
  listGlobalFlags,
  listHelpUsageLines,
} from "./spec.js";

function quoteBashWords(words: readonly string[]): string {
  return words.join(" ");
}

function describeCommandFlag(flag: string): string {
  return `${flag}:${getFlagDescription(flag)}`;
}

function listGlobalFlagsWithAliases(): string[] {
  return [
    ...GLOBAL_FLAGS,
    ...listFlagAliases()
      .filter(({ flag }) => GLOBAL_FLAGS.has(flag))
      .map(({ alias }) => alias),
  ];
}

function listCommandFlagsWithAliases(commandName: string): string[] {
  return [
    ...COMMAND_FLAGS[commandName as keyof typeof COMMAND_FLAGS],
    ...listFlagAliases()
      .filter(({ flag }) => COMMAND_FLAGS[commandName as keyof typeof COMMAND_FLAGS].has(flag))
      .map(({ alias }) => alias),
  ];
}

function bashCasePattern(tokens: readonly string[]): string {
  return tokens.join("|");
}

function zshDescribeValues(values: readonly string[], description: string): string {
  return values
    .map((value) => `'${value}:${value} ${description}'`)
    .join(" ");
}

export function buildHelpText(): string {
  const usageLines = listHelpUsageLines()
    .map((usage) => `  ${usage}`)
    .join("\n");
  const commandAliases = listCommandAliases()
    .map(({ alias, command }) => `${alias}=${command}`)
    .join(", ");
  const flagAliases = listFlagAliases()
    .map(({ alias, flag }) => `${alias}=${flag}`)
    .join(", ");
  const noteLines = HELP_NOTES
    .map((note) => `  ${note}`)
    .join("\n");

  return `${PROGRAM_NAME} - ${PROGRAM_SUMMARY}

Usage:
  ${PROGRAM_NAME} --version
  ${PROGRAM_NAME} --help
${usageLines}

Global flags: ${listGlobalFlags().join(", ")}
Command aliases: ${commandAliases}
Flag aliases: ${flagAliases}

Notes:
${noteLines}

Account names must match /${ACCOUNT_NAME_PATTERN}/.
`;
}

export function printHelp(stream: NodeJS.WriteStream): void {
  stream.write(buildHelpText());
}

export function buildCompletionZshScript(): string {
  const commands = COMMAND_SPECS.flatMap((command) => [
    `'${command.name}:${command.name} command'`,
    ...(command.aliases ?? []).map((alias) => `'${alias}:${command.name} command alias'`),
  ]).join("\n    ");
  const globalFlags = listGlobalFlagsWithAliases()
    .map(describeCommandFlag)
    .map((flag) => `'${flag}'`)
    .join("\n    ");

  const commandCases = COMMAND_SPECS.map((command) => {
    const flags = listCommandFlagsWithAliases(command.name)
      .map(describeCommandFlag)
      .map((flag) => `'${flag}'`)
      .join(" ");
    const commandTokens = [command.name, ...(command.aliases ?? [])].join("|");
    return `    ${commandTokens})
      command_flags=(${flags})
      ;;`;
  }).join("\n");
  const subcommandCases = COMMAND_SPECS
    .filter((command) => (command.completionSubcommands ?? []).length > 0)
    .map((command) => {
      const commandTokens = [command.name, ...(command.aliases ?? [])].join("|");
      return `      ${commandTokens})
        subcommands=(${zshDescribeValues(command.completionSubcommands ?? [], "subcommand")})
        ;;`;
    })
    .join("\n");

  const accountCommandPattern = COMMAND_SPECS
    .filter((command) => isCompletionAccountCommand(command.name))
    .flatMap((command) => [command.name, ...(command.aliases ?? [])])
    .join("|");

  return `#compdef ${PROGRAM_NAME}

_${PROGRAM_NAME}() {
  local -a commands global_flags command_flags accounts subcommands
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

  if [[ \${words[CURRENT-1]} == --account ]]; then
    accounts=(\${(@f)\$(${PROGRAM_NAME} completion --accounts 2>/dev/null)})
    if (( \${#accounts[@]} > 0 )); then
      _describe -t accounts 'account' accounts
      return 0
    fi
  fi

  if (( CURRENT == 3 )) && [[ \${words[CURRENT]} != -* ]]; then
    subcommands=()
    case \$command in
${subcommandCases}
    esac
    if (( \${#subcommands[@]} > 0 )); then
      _describe -t subcommands 'subcommand' subcommands
      return 0
    fi

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

  if [[ \${words[CURRENT]} == -* ]]; then
    _describe -t flags 'global flag' global_flags
    _describe -t flags 'command flag' command_flags
  fi
}

_${PROGRAM_NAME} "$@"
`;
}

export function buildCompletionBashScript(): string {
  const commands = COMMAND_SPECS.flatMap((command) => [command.name, ...(command.aliases ?? [])]).join(" ");
  const globalFlags = listGlobalFlagsWithAliases().join(" ");
  const commandCases = COMMAND_SPECS.map((command) => {
    const flags = listCommandFlagsWithAliases(command.name).join(" ");
    const commandTokens = bashCasePattern([command.name, ...(command.aliases ?? [])]);
    return `    ${commandTokens}) command_flags="${flags}" ;;`;
  }).join("\n");
  const subcommandCases = COMMAND_SPECS
    .filter((command) => (command.completionSubcommands ?? []).length > 0)
    .map((command) => {
      const commandTokens = bashCasePattern([command.name, ...(command.aliases ?? [])]);
      return `    ${commandTokens}) subcommands="${(command.completionSubcommands ?? []).join(" ")}" ;;`;
    })
    .join("\n");

  const accountCommandPattern = bashCasePattern(COMMAND_SPECS
    .filter((command) => isCompletionAccountCommand(command.name))
    .flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const completionTargets = (getCommandSpec("completion").completionTargets ?? []).join(" ");

  return `_${PROGRAM_NAME}() {
  local cur prev command command_flags global_flags commands accounts subcommands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"
  global_flags="${quoteBashWords(listGlobalFlagsWithAliases())}"
  commands="${commands}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands} \${global_flags}" -- "\${cur}") )
    return 0
  fi

  if [[ "\${command}" == "completion" ]]; then
    if [[ "\${cur}" == -* ]]; then
      COMPREPLY=( $(compgen -W "--accounts" -- "\${cur}") )
    else
      COMPREPLY=( $(compgen -W "${completionTargets} --accounts" -- "\${cur}") )
    fi
    return 0
  fi

  if [[ "\${prev}" == "--account" ]]; then
    accounts="$(${PROGRAM_NAME} completion --accounts 2>/dev/null)"
    COMPREPLY=( $(compgen -W "\${accounts}" -- "\${cur}") )
    return 0
  fi

  if [[ \${COMP_CWORD} -eq 2 && "\${cur}" != -* ]]; then
    subcommands=""
    case "\${command}" in
${subcommandCases}
    esac
    if [[ -n "\${subcommands}" ]]; then
      COMPREPLY=( $(compgen -W "\${subcommands}" -- "\${cur}") )
      return 0
    fi

    case "\${command}" in
      ${accountCommandPattern})
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

  if [[ "\${cur}" == -* ]]; then
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
