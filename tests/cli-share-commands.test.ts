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
    authKind?: "chatgpt" | "apikey";
    configToml?: string | null;
    profile?: {
      account_id?: string;
      user_id?: string;
      email?: string;
      plan?: string;
    } | null;
  },
): Promise<void> {
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        kind: "auth_bundle",
        version: 1,
        exported_at: "2026-04-16T10:20:30.000Z",
        auth: {
          kind: options.authKind ?? options.authSnapshot.auth_mode,
          auth_json: options.authSnapshot,
          ...(options.configToml === null || options.configToml === undefined
            ? {}
            : { config_toml: options.configToml }),
          ...(options.profile === null || options.profile === undefined
            ? {}
            : { profile: options.profile }),
        },
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
        auth_kind: "chatgpt",
        identity: "acct-share-current:user-share-current",
      });
      expect(stderr.read()).toBe("");

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        kind: "auth_bundle",
        version: 1,
        auth: {
          kind: "chatgpt",
          auth_json: {
            auth_mode: "chatgpt",
            tokens: {
              account_id: "acct-share-current",
            },
          },
          profile: {
            account_id: "acct-share-current",
            user_id: "user-share-current",
            email: "acct-share-current@example.com",
            plan: "plus",
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
        kind: "auth_bundle",
        version: 1,
        auth: {
          kind: "apikey",
          auth_json: {
            auth_mode: "apikey",
            OPENAI_API_KEY: "sk-test-share-export",
          },
          config_toml: `${rawConfig}\n`,
        },
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
        profile: {
          account_id: "acct-imported",
          user_id: "user-imported",
          email: "acct-imported@example.com",
          plan: "pro",
        },
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
        profile: {
          account_id: "acct-duplicate",
          user_id: "user-duplicate",
          email: "acct-duplicate@example.com",
          plan: "plus",
        },
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
        profile: {
          account_id: "acct-inspect",
          user_id: "user-inspect",
          email: "acct-inspect@example.com",
          plan: "team",
        },
      });

      const exitCode = await runCli(["inspect", bundlePath], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stdout.read()).toContain(`Bundle: ${bundlePath}`);
      expect(stdout.read()).toContain("Kind: auth_bundle");
      expect(stdout.read()).toContain("Auth kind: chatgpt");
      expect(stdout.read()).toContain("Identity: acct-inspect:user-inspect");
      expect(stdout.read()).toContain("Profile: yes");
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
        kind: "auth_bundle",
        version: 1,
        auth: {
          auth_json: {
            tokens: {
              account_id: "acct-force-share",
            },
          },
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refuses to export an apikey account without config.toml", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const outputPath = join(homeDir, "missing-config.codexm.json");
      await store.addAccountSnapshot("api-main", createApiKeyPayload("sk-test-missing-config"));

      const exitCode = await runCli(["export", "api-main", "--output", outputPath], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain('Managed apikey account "api-main" is missing config.toml.');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("rejects a chatgpt bundle when profile conflicts with auth facts", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const bundlePath = join(homeDir, "profile-mismatch.codexm.json");

      await writeShareBundle(bundlePath, {
        authSnapshot: createAuthPayload("acct-mismatch", "chatgpt", "pro", "user-mismatch"),
        profile: {
          account_id: "acct-mismatch",
          user_id: "user-mismatch",
          email: "wrong@example.com",
          plan: "team",
        },
      });

      const exitCode = await runCli(["import", bundlePath, "--name", "friend-main"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain('Bundle profile field "email" does not match auth snapshot.');
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("ignores an apikey bundle profile while still requiring config.toml", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const bundlePath = join(homeDir, "apikey-profile.codexm.json");
      const rawConfig = [
        'model_provider = "openai"',
        'base_url = "https://api.openai.com/v1"',
      ].join("\n");

      await writeShareBundle(bundlePath, {
        authSnapshot: createApiKeyPayload("sk-test-import-profile"),
        authKind: "apikey",
        configToml: rawConfig,
        profile: {
          email: "ignored@example.com",
          plan: "plus",
        },
      });

      const exitCode = await runCli(["import", bundlePath, "--name", "api-main", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "import",
        account: {
          name: "api-main",
          auth_mode: "apikey",
        },
      });
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
