import { readFile } from "node:fs/promises";

const CORE_COMMANDS_START = "<!-- GENERATED:CORE_COMMANDS:START -->";
const CORE_COMMANDS_END = "<!-- GENERATED:CORE_COMMANDS:END -->";
const SHELL_COMPLETION_START = "<!-- GENERATED:SHELL_COMPLETION:START -->";
const SHELL_COMPLETION_END = "<!-- GENERATED:SHELL_COMPLETION:END -->";

let cachedSpec = null;

async function loadCliSpec() {
  if (cachedSpec) {
    return cachedSpec;
  }

  const specUrl = new URL("../src/cli/spec.json", import.meta.url);
  cachedSpec = JSON.parse(await readFile(specUrl, "utf8"));
  return cachedSpec;
}

function replaceSection(source, startMarker, endMarker, content) {
  const pattern = new RegExp(
    `${startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?\\n${endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  return source.replace(pattern, `${startMarker}\n${content}\n${endMarker}`);
}

export async function buildReadmeCommandSections(locale) {
  const spec = await loadCliSpec();
  const coreCommands = spec.readme.sections
    .map((section) => {
      const entries = section.entries
        .map((entry) => `- \`${entry.usage}\`: ${entry.description[locale]}`)
        .join("\n");

      return `${section.title[locale]}\n\n${entries}`;
    })
    .join("\n\n");

  const shellCompletion = `${spec.readme.shellCompletion.intro[locale]}\n\n\`\`\`${spec.readme.shellCompletion.codeBlockLanguage}
${spec.readme.shellCompletion.commands.join("\n")}
\`\`\`\n\n${spec.readme.shellCompletion.outro[locale]}`;

  return {
    coreCommands,
    shellCompletion,
  };
}

export async function replaceGeneratedReadmeSections(source, locale) {
  const sections = await buildReadmeCommandSections(locale);
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
