import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import { parseArgs, validateParsedArgs } from "../src/cli/args.js";
import {
  cleanupTempHome,
  createApiKeyPayload,
  createAuthPayload,
  createTempHome,
  readCurrentAuth,
  writeCurrentApiKeyAuth,
  writeCurrentAuth,
  writeCurrentConfig,
} from "./test-helpers.js";
import { captureWritable } from "./cli-fixtures.js";

async function writeShareBundle(
  filePath: string,
  options: {
    authSnapshot: ReturnType<typeof createAuthPayload> | ReturnType<typeof createApiKeyPayload>;
    sourceType?: "current" | "managed";
    sourceName?: string | null;
    suggestedName?: string | null;
    configSnapshot?: string | null;
  },
): Promise<void> {
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        schema_version: 1,
        exported_at: "2026-04-16T10:20:30.000Z",
        source_type: options.sourceType ?? "managed",
        source_name: options.sourceName ?? null,
        suggested_name: options.suggestedName ?? null,
        auth_snapshot: options.authSnapshot,
        config_snapshot: options.configSnapshot ?? null,
      },
      null,
      2,
    )}\n`,
  );
}

describe("CLI Share Commands", () => {
  test("parses share command option values before validation", () => {
    const parsed = parseArgs(["export", "plus-main", "--output", "./share.json", "--force"]);

    expect(parsed.command).toBe("export");
    expect(parsed.positionals).toEqual(["plus-main"]);
    expect(parsed.flags).toEqual(new Set(["--force"]));
    expect(parsed.optionValues).toEqual(new Map([["--output", "./share.json"]]));
    expect(() => validateParsedArgs(parsed)).not.toThrow();
  });

  test("exports the current auth snapshot to a share bundle", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const outputPath = join(homeDir, "current-share.codexm.json");
      await writeCurrentAuth(homeDir, "acct-share-current", "chatgpt", "plus", "user-share-current");

      const exitCode = await runCli(["export", "--output", outputPath, "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "export",
        bundle_path: outputPath,
        source_type: "current",
        source_name: null,
        auth_mode: "chatgpt",
        identity: "acct-share-current:user-share-current",
      });
      expect(stderr.read()).toBe("");

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        schema_version: 1,
        source_type: "current",
        source_name: null,
        suggested_name: null,
        auth_snapshot: {
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct-share-current",
          },
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("exports a managed apikey account with its config snapshot", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const outputPath = join(homeDir, "api-share.codexm.json");
      const rawConfig = [
        'model_provider = "openai"',
        'base_url = "https://api.openai.com/v1"',
      ].join("\n");
      await writeCurrentApiKeyAuth(homeDir, "sk-test-share-export");
      await writeCurrentConfig(homeDir, rawConfig);
      await store.saveCurrentAccount("api-main");

      const exitCode = await runCli(["export", "api-main", "--output", outputPath], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain(`Exported share bundle to ${outputPath}`);
      expect(stdout.read()).toContain(
        `codexm import ${outputPath} --name <local-name>`,
      );
      expect(stderr.read()).toBe("");

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        source_type: "managed",
        source_name: "api-main",
        suggested_name: "api-main",
        auth_snapshot: {
          auth_mode: "apikey",
          OPENAI_API_KEY: "sk-test-share-export",
        },
        config_snapshot: `${rawConfig}\n`,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("imports a share bundle into a named managed account without switching current auth", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const bundlePath = join(homeDir, "incoming-share.codexm.json");
      await writeCurrentAuth(homeDir, "acct-before-import", "chatgpt", "plus", "user-before-import");
      await writeShareBundle(bundlePath, {
        authSnapshot: createAuthPayload("acct-imported", "chatgpt", "pro", "user-imported"),
        sourceType: "managed",
        sourceName: "source-main",
        suggestedName: "source-main",
      });

      const exitCode = await runCli(["import", bundlePath, "--name", "friend-main", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "import",
        source_bundle: bundlePath,
        switched: false,
        account: {
          name: "friend-main",
          auth_mode: "chatgpt",
          account_id: "acct-imported",
          user_id: "user-imported",
          identity: "acct-imported:user-imported",
        },
      });
      expect(stderr.read()).toBe("");

      expect(JSON.parse(await readFile(join(homeDir, ".codex-team", "accounts", "friend-main", "auth.json"), "utf8"))).toMatchObject({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "acct-imported",
        },
      });
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-before-import");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refuses to import when the bundle identity is already managed locally", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const bundlePath = join(homeDir, "duplicate-share.codexm.json");
      await writeCurrentAuth(homeDir, "acct-duplicate", "chatgpt", "plus", "user-duplicate");
      await store.saveCurrentAccount("existing-main");
      await writeShareBundle(bundlePath, {
        authSnapshot: createAuthPayload("acct-duplicate", "chatgpt", "plus", "user-duplicate"),
        sourceType: "managed",
        sourceName: "source-duplicate",
        suggestedName: "source-duplicate",
      });

      const exitCode = await runCli(["import", bundlePath, "--name", "friend-main"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain(
        'Identity acct-duplicate:user-duplicate is already managed by "existing-main".',
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("inspects a share bundle without printing raw secrets", async () => {
    const homeDir = await createTempHome();

    try {
      const stdout = captureWritable();
      const stderr = captureWritable();
      const bundlePath = join(homeDir, "inspect-share.codexm.json");
      await writeShareBundle(bundlePath, {
        authSnapshot: createAuthPayload("acct-inspect", "chatgpt", "team", "user-inspect"),
        sourceType: "managed",
        sourceName: "inspect-main",
        suggestedName: "inspect-main",
      });

      const exitCode = await runCli(["inspect", bundlePath], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain(`Bundle: ${bundlePath}`);
      expect(stdout.read()).toContain('Source: managed account "inspect-main"');
      expect(stdout.read()).toContain("Suggested name: inspect-main");
      expect(stdout.read()).toContain("Identity: acct-inspect:user-inspect");
      expect(stdout.read()).not.toContain("refresh-acct-inspect");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("requires --name when importing a share bundle", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["import", "/tmp/share.json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Error: Usage: codexm import <file> --name <local-name> [--force] [--json]");
  });

  test("can overwrite an existing bundle path with export --force", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const outputPath = join(homeDir, "force-share.codexm.json");
      await writeCurrentAuth(homeDir, "acct-force-share", "chatgpt", "plus", "user-force-share");
      await writeFile(outputPath, '{"stale":true}\n');

      const exitCode = await runCli(["export", "--output", outputPath, "--force"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        schema_version: 1,
        auth_snapshot: {
          tokens: {
            account_id: "acct-force-share",
          },
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
