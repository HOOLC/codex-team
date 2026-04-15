import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import {
  cleanupTempHome,
  createApiKeyPayload,
  createAuthPayload,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  textResponse,
  writeCurrentAuth,
} from "./test-helpers.js";
import { captureWritable, createInteractiveStdin } from "./cli-fixtures.js";

describe("CLI Account Commands", () => {
  test("adds a ChatGPT account from the browser login flow without changing current auth", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-current-before-add");
      const stdout = captureWritable();
      const stderr = captureWritable();
      const calls: string[] = [];

      const exitCode = await runCli(["add", "added-main", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        authLogin: {
          login: async (request) => {
            calls.push(request.mode);
            return createAuthPayload("acct-added-main", "chatgpt", "plus", "user-added");
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual(["browser"]);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "add",
        account: {
          name: "added-main",
          auth_mode: "chatgpt",
          account_id: "acct-added-main",
          user_id: "user-added",
        },
      });
      expect(stderr.read()).toBe("");

      const savedAuthRaw = await readFile(
        join(homeDir, ".codex-team", "accounts", "added-main", "auth.json"),
        "utf8",
      );
      expect(JSON.parse(savedAuthRaw)).toMatchObject({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "acct-added-main",
        },
      });
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-current-before-add");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("adds a ChatGPT account from the device login flow", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();
      const calls: string[] = [];

      const exitCode = await runCli(["add", "device-main", "--device-auth"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        authLogin: {
          login: async (request) => {
            calls.push(request.mode);
            return createAuthPayload("acct-device-main", "chatgpt", "team", "user-device");
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(calls).toEqual(["device"]);
      expect(stdout.read()).toContain('Added account "device-main"');
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("adds an API key account from stdin", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      const exitCode = await runCli(["add", "api-main", "--with-api-key", "--json"], {
        store,
        stdin: Readable.from(["sk-test-add\n"]) as unknown as NodeJS.ReadStream,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "add",
        account: {
          name: "api-main",
          auth_mode: "apikey",
        },
      });
      expect(stderr.read()).toBe("");

      const savedAuthRaw = await readFile(
        join(homeDir, ".codex-team", "accounts", "api-main", "auth.json"),
        "utf8",
      );
      expect(JSON.parse(savedAuthRaw)).toEqual(createApiKeyPayload("sk-test-add"));
      const savedConfig = await readFile(
        join(homeDir, ".codex-team", "accounts", "api-main", "config.toml"),
        "utf8",
      );
      expect(savedConfig).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("rejects mutually exclusive add login modes", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["add", "bad", "--device-auth", "--with-api-key"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain(
      "Error: Usage: codexm add <name> [--device-auth|--with-api-key] [--force] [--json]",
    );
  });

  test("prints save usage that matches help output", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["save"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Error: Usage: codexm save <name> [--force] [--json]");
  });

  test("prints remove usage that matches help output", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["remove"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Error: Usage: codexm remove <name> [--yes] [--json]");
  });

  test("prints rename usage that matches help output", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["rename", "before"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Error: Usage: codexm rename <old> <new> [--json]");
  });

  test("accepts the common short aliases for remove confirmation and json output", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-remove-short");
      await runCli(["save", "remove-short", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const stderr = captureWritable();
      const exitCode = await runCli(["remove", "remove-short", "-y", "-j"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "remove",
        account: "remove-short",
      });
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports update and rejects unmanaged current auth", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "3",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-update");
      await runCli(["save", "cli-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-update", "chatgpt", "pro");
      const updateStdout = captureWritable();
      const updateStderr = captureWritable();
      const updateCode = await runCli(["update", "--json"], {
        store,
        stdout: updateStdout.stream,
        stderr: updateStderr.stream,
      });

      expect(updateCode).toBe(0);
      expect(JSON.parse(updateStdout.read())).toMatchObject({
        ok: true,
        action: "update",
        account: {
          name: "cli-main",
          auth_mode: "chatgpt",
        },
        quota: {
          refresh_status: "ok",
          credits_balance: 3,
          plan_type: "plus",
          five_hour: {
            used_percent: 20,
          },
          one_week: {
            used_percent: 70,
          },
        },
      });

      await writeCurrentAuth(homeDir, "acct-unmanaged");
      const unmanagedStdout = captureWritable();
      const unmanagedStderr = captureWritable();
      const unmanagedCode = await runCli(["update", "--json"], {
        store,
        stdout: unmanagedStdout.stream,
        stderr: unmanagedStderr.stream,
      });

      expect(unmanagedCode).toBe(1);
      expect(JSON.parse(unmanagedStderr.read())).toMatchObject({
        ok: false,
        error: "Current account is not managed.",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports interactive remove without leaving stdin active", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-remove");
      await runCli(["save", "remove-me", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdin = createInteractiveStdin();
      const stdout = captureWritable();
      const stderr = captureWritable();
      const removePromise = runCli(["remove", "remove-me"], {
        store,
        stdin,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      stdin.emitInput("y\n");

      const removeCode = await removePromise;
      expect(removeCode).toBe(0);
      expect(stdout.read()).toBe(
        'Remove saved account "remove-me"? [y/N] \nRemoved account "remove-me".\n',
      );
      expect(stderr.read()).toBe("");
      expect(stdin.resumeCalls).toBeGreaterThanOrEqual(1);
      expect(stdin.pauseCalls).toBeGreaterThanOrEqual(1);

      const accounts = await store.listAccounts();
      expect(accounts.accounts).toHaveLength(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
