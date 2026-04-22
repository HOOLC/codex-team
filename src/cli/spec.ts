import rawCliSpec from "./spec.json";

type Locale = "en" | "zh-CN";

interface CliFlagSpec {
  flag: string;
  description: string;
  global: boolean;
  aliases?: string[];
  takesValue?: boolean;
}

interface CliCommandSpec {
  name: string;
  aliases?: string[];
  flags: string[];
  helpUsages: string[];
  usageErrors: Record<string, string>;
  completionSubcommands?: string[];
  completionTargets?: string[];
}

interface ReadmeEntry {
  usage: string;
  description: Record<Locale, string>;
}

interface ReadmeSection {
  id: string;
  title: Record<Locale, string>;
  entries: ReadmeEntry[];
}

interface CliSpec {
  programName: string;
  summary: string;
  accountNamePattern: string;
  flags: CliFlagSpec[];
  completionAccountCommands: string[];
  notes: string[];
  commands: CliCommandSpec[];
  readme: {
    sections: ReadmeSection[];
    shellCompletion: {
      intro: Record<Locale, string>;
      codeBlockLanguage: string;
      commands: string[];
      outro: Record<Locale, string>;
    };
  };
}

const cliSpec = rawCliSpec as unknown as CliSpec;
const flagDescriptionMap = new Map(
  cliSpec.flags.flatMap((flag) => [
    [flag.flag, flag.description] as const,
    ...(flag.aliases ?? []).map((alias) => [alias, flag.description] as const),
  ]),
);
const flagAliasMap = new Map(
  cliSpec.flags.flatMap((flag) => (flag.aliases ?? []).map((alias) => [alias, flag.flag] as const)),
);
const commandAliasMap = new Map(
  cliSpec.commands.flatMap((command) =>
    (command.aliases ?? []).map((alias) => [alias, command.name] as const),
  ),
);

export type { CliCommandSpec, CliFlagSpec, Locale, ReadmeEntry, ReadmeSection };

export const PROGRAM_NAME = cliSpec.programName;
export const PROGRAM_SUMMARY = cliSpec.summary;
export const ACCOUNT_NAME_PATTERN = cliSpec.accountNamePattern;
export const COMMAND_SPECS = cliSpec.commands;
export const COMMAND_NAMES = cliSpec.commands.map((command) => command.name);
export const GLOBAL_FLAGS = new Set(cliSpec.flags.filter((flag) => flag.global).map((flag) => flag.flag));
export const VALUE_FLAGS = new Set(
  cliSpec.flags.filter((flag) => flag.takesValue).map((flag) => flag.flag),
);
export const COMMAND_FLAGS = Object.fromEntries(
  cliSpec.commands.map((command) => [command.name, new Set(command.flags)]),
) as Record<(typeof COMMAND_NAMES)[number], Set<string>>;
export const HELP_NOTES = cliSpec.notes;
export const README_SECTIONS = cliSpec.readme.sections;
export const README_SHELL_COMPLETION = cliSpec.readme.shellCompletion;
export const COMMAND_ALIASES = commandAliasMap;
export const FLAG_ALIASES = flagAliasMap;

export function getFlagDescription(flag: string): string {
  return flagDescriptionMap.get(flag) ?? "option";
}

export function listGlobalFlags(): string[] {
  return cliSpec.flags.filter((flag) => flag.global).map((flag) => flag.flag);
}

export function listCommandAliases(): Array<{ alias: string; command: string }> {
  return cliSpec.commands
    .flatMap((command) => (command.aliases ?? []).map((alias) => ({ alias, command: command.name })))
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export function listFlagAliases(): Array<{ alias: string; flag: string }> {
  return cliSpec.flags
    .flatMap((flag) => (flag.aliases ?? []).map((alias) => ({ alias, flag: flag.flag })))
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export function listHelpUsageLines(): string[] {
  return cliSpec.commands.flatMap((command) => command.helpUsages);
}

export function getCommandSpec(name: string): CliCommandSpec {
  const command = cliSpec.commands.find((candidate) => candidate.name === name);
  if (!command) {
    throw new Error(`Unknown command spec "${name}".`);
  }

  return command;
}

export function getUsage(commandName: string, variant = "default"): string {
  const command = getCommandSpec(commandName);
  const usage = command.usageErrors[variant];
  if (!usage) {
    throw new Error(`Unknown usage variant "${variant}" for command "${commandName}".`);
  }

  return usage;
}

export function isCompletionAccountCommand(commandName: string): boolean {
  return cliSpec.completionAccountCommands.includes(commandName);
}

export function resolveCommandName(name: string): string {
  return commandAliasMap.get(name) ?? name;
}

export function resolveFlagName(name: string): string {
  return flagAliasMap.get(name) ?? name;
}
