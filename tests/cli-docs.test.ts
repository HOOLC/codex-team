import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";
import packageJson from "../package.json";

import {
  buildReadmeCommandSections,
  replaceGeneratedReadmeSections,
} from "../src/cli/readme.js";
import { COMMAND_NAMES } from "../src/cli/spec.js";

describe("CLI Docs", () => {
  test("package scripts expose verify shortcuts", () => {
    expect(packageJson.scripts.verify).toBe("pnpm typecheck && pnpm test");
    expect(packageJson.scripts["verify:full"]).toBe("pnpm verify && pnpm build");
  });

  test("generated English README sections stay in sync", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const sections = buildReadmeCommandSections("en");

    expect(readme).toContain(sections.coreCommands);
    expect(readme).toContain(sections.shellCompletion);
    expect(replaceGeneratedReadmeSections(readme, "en")).toBe(readme);
  });

  test("generated Chinese README sections stay in sync", async () => {
    const readme = await readFile(join(process.cwd(), "README.zh-CN.md"), "utf8");
    const sections = buildReadmeCommandSections("zh-CN");

    expect(readme).toContain(sections.coreCommands);
    expect(readme).toContain(sections.shellCompletion);
    expect(replaceGeneratedReadmeSections(readme, "zh-CN")).toBe(readme);
  });

  test("CLI spec stays in sync with the main command dispatcher", async () => {
    const source = await readFile(join(process.cwd(), "src", "main.ts"), "utf8");
    const dispatcherCommands = [...source.matchAll(/case "([^"]+)": \{/g)]
      .map((match) => match[1]!)
      .sort();

    expect(dispatcherCommands).toEqual([...COMMAND_NAMES].sort());
  });
});
