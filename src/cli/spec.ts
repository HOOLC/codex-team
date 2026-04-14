import rawCliSpec from "./spec.json";

type Locale = "en" | "zh-CN";

interface CliFlagSpec {
  flag: string;
  description: string;
  global: boolean;
}

interface CliCommandSpec {
  name: string;
  flags: string[];
  helpUsages: string[];
  usageErrors: Record<string, string>;
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
const flagDescriptionMap = new Map(cliSpec.flags.map((flag) => [flag.flag, flag.description]));

export type { CliCommandSpec, CliFlagSpec, Locale, ReadmeEntry, ReadmeSection };

export const PROGRAM_NAME = cliSpec.programName;
export const PROGRAM_SUMMARY = cliSpec.summary;
export const ACCOUNT_NAME_PATTERN = cliSpec.accountNamePattern;
export const COMMAND_SPECS = cliSpec.commands;
export const COMMAND_NAMES = cliSpec.commands.map((command) => command.name);
export const GLOBAL_FLAGS = new Set(cliSpec.flags.filter((flag) => flag.global).map((flag) => flag.flag));
export const COMMAND_FLAGS = Object.fromEntries(
  cliSpec.commands.map((command) => [command.name, new Set(command.flags)]),
) as Record<(typeof COMMAND_NAMES)[number], Set<string>>;
export const HELP_NOTES = cliSpec.notes;
export const README_SECTIONS = cliSpec.readme.sections;
export const README_SHELL_COMPLETION = cliSpec.readme.shellCompletion;

export function getFlagDescription(flag: string): string {
  return flagDescriptionMap.get(flag) ?? "option";
}

export function listGlobalFlags(): string[] {
  return cliSpec.flags.filter((flag) => flag.global).map((flag) => flag.flag);
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
