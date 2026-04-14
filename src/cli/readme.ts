import {
  README_SECTIONS,
  README_SHELL_COMPLETION,
  type Locale,
} from "./spec.js";

const CORE_COMMANDS_START = "<!-- GENERATED:CORE_COMMANDS:START -->";
const CORE_COMMANDS_END = "<!-- GENERATED:CORE_COMMANDS:END -->";
const SHELL_COMPLETION_START = "<!-- GENERATED:SHELL_COMPLETION:START -->";
const SHELL_COMPLETION_END = "<!-- GENERATED:SHELL_COMPLETION:END -->";

function buildCoreCommandsSection(locale: Locale): string {
  return README_SECTIONS.map((section) => {
    const entries = section.entries
      .map((entry) => `- \`${entry.usage}\`: ${entry.description[locale]}`)
      .join("\n");

    return `${section.title[locale]}\n\n${entries}`;
  }).join("\n\n");
}

function buildShellCompletionSection(locale: Locale): string {
  return `${README_SHELL_COMPLETION.intro[locale]}\n\n\`\`\`${README_SHELL_COMPLETION.codeBlockLanguage}
${README_SHELL_COMPLETION.commands.join("\n")}
\`\`\`\n\n${README_SHELL_COMPLETION.outro[locale]}`;
}

function replaceSection(
  source: string,
  startMarker: string,
  endMarker: string,
  content: string,
): string {
  const pattern = new RegExp(
    `${startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?\\n${endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  return source.replace(pattern, `${startMarker}\n${content}\n${endMarker}`);
}

export function buildReadmeCommandSections(locale: Locale): {
  coreCommands: string;
  shellCompletion: string;
} {
  return {
    coreCommands: buildCoreCommandsSection(locale),
    shellCompletion: buildShellCompletionSection(locale),
  };
}

export function replaceGeneratedReadmeSections(source: string, locale: Locale): string {
  const sections = buildReadmeCommandSections(locale);
  const withCoreCommands = replaceSection(
    source,
    CORE_COMMANDS_START,
    CORE_COMMANDS_END,
    sections.coreCommands,
  );

  return replaceSection(
    withCoreCommands,
    SHELL_COMPLETION_START,
    SHELL_COMPLETION_END,
    sections.shellCompletion,
  );
}

export {
  CORE_COMMANDS_END,
  CORE_COMMANDS_START,
  SHELL_COMPLETION_END,
  SHELL_COMPLETION_START,
};
