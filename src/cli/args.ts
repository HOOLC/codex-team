export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Set<string>;
}

export class CliUsageError extends Error {
  suggestion: string | null;

  constructor(message: string, suggestion: string | null = null) {
    super(message);
    this.name = "CliUsageError";
    this.suggestion = suggestion;
  }
}

export const COMMAND_NAMES = [
  "current",
  "doctor",
  "list",
  "add",
  "save",
  "update",
  "switch",
  "launch",
  "watch",
  "remove",
  "rename",
  "completion",
] as const;

export const GLOBAL_FLAGS = new Set(["--help", "--version", "--debug"]);

export const COMMAND_FLAGS: Record<(typeof COMMAND_NAMES)[number], Set<string>> = {
  current: new Set(["--json", "--refresh"]),
  doctor: new Set(["--json"]),
  list: new Set(["--json", "--verbose"]),
  add: new Set(["--device-auth", "--with-api-key", "--force", "--json"]),
  save: new Set(["--force", "--json"]),
  update: new Set(["--json"]),
  switch: new Set(["--auto", "--dry-run", "--force", "--json"]),
  launch: new Set(["--auto", "--watch", "--no-auto-switch", "--json"]),
  watch: new Set(["--no-auto-switch", "--detach", "--status", "--stop"]),
  remove: new Set(["--yes", "--json"]),
  rename: new Set(["--json"]),
  completion: new Set(["--accounts"]),
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }

  return {
    command: positionals[0] ?? null,
    positionals: positionals.slice(1),
    flags,
  };
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const nextDiagonal = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      );
      diagonal = nextDiagonal;
    }
  }

  return previous[right.length];
}

function findClosestSuggestion(value: string, candidates: string[]): string | null {
  let bestCandidate: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = levenshteinDistance(value, candidate);
    if (distance < bestDistance) {
      bestCandidate = candidate;
      bestDistance = distance;
    }
  }

  const threshold = Math.max(2, Math.ceil(value.length / 3));
  return bestDistance <= threshold ? bestCandidate : null;
}

export function validateParsedArgs(parsed: ParsedArgs): void {
  if (parsed.command && !COMMAND_NAMES.includes(parsed.command as (typeof COMMAND_NAMES)[number])) {
    throw new CliUsageError(
      `Unknown command "${parsed.command}".`,
      findClosestSuggestion(parsed.command, [...COMMAND_NAMES]),
    );
  }

  const allowedFlags = new Set<string>(GLOBAL_FLAGS);
  if (parsed.command) {
    for (const flag of COMMAND_FLAGS[parsed.command as keyof typeof COMMAND_FLAGS]) {
      allowedFlags.add(flag);
    }
  }

  for (const flag of parsed.flags) {
    if (!allowedFlags.has(flag)) {
      const commandContext = parsed.command ? ` for command "${parsed.command}"` : "";
      throw new CliUsageError(
        `Unknown flag "${flag}"${commandContext}.`,
        findClosestSuggestion(flag, [...allowedFlags]),
      );
    }
  }
}
