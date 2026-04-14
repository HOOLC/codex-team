import { readFile, writeFile } from "node:fs/promises";

import { replaceGeneratedReadmeSections } from "./readme-sections.mjs";

const files = [
  {
    path: new URL("../README.md", import.meta.url),
    locale: "en",
  },
  {
    path: new URL("../README.zh-CN.md", import.meta.url),
    locale: "zh-CN",
  },
];

for (const file of files) {
  const current = await readFile(file.path, "utf8");
  const next = await replaceGeneratedReadmeSections(current, file.locale);

  if (next !== current) {
    await writeFile(file.path, next);
  }
}
