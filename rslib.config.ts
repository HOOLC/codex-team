import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      format: "esm",
      autoExtension: false,
      syntax: "es2022",
      source: {
        entry: {
          cli: "./src/cli.ts",
        },
      },
      bundle: true,
      dts: false,
      output: {
        target: "node",
        distPath: {
          root: "./dist",
        },
      },
    },
  ],
});
