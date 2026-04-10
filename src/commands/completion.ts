import type { AccountStore } from "../account-store.js";
import {
  buildCompletionBashScript,
  buildCompletionZshScript,
  listCompletionAccountNames,
} from "../cli/help.js";

export async function handleCompletionCommand(options: {
  store: AccountStore;
  positionals: string[];
  flags: Set<string>;
  stdout: NodeJS.WriteStream;
}): Promise<number> {
  if (options.flags.has("--accounts")) {
    if (options.positionals.length > 0) {
      throw new Error("Usage: codexm completion --accounts");
    }

    const accountNames = await listCompletionAccountNames(options.store);
    if (accountNames.length > 0) {
      options.stdout.write(`${accountNames.join("\n")}\n`);
    }
    return 0;
  }

  const shell = options.positionals[0] ?? null;
  if (options.positionals.length !== 1 || (shell !== "zsh" && shell !== "bash")) {
    throw new Error("Usage: codexm completion <zsh|bash>");
  }

  options.stdout.write(shell === "zsh" ? buildCompletionZshScript() : buildCompletionBashScript());
  return 0;
}
