import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import { captureWritable } from "./cli-fixtures.js";
import { cleanupTempHome, createTempHome, writeCurrentAuth, writeCurrentConfig } from "./test-helpers.js";

describe("overlay commands", () => {
  test("overlay create returns an isolated codex home for a saved account and overlay delete removes it", async () => {
    const homeDir = await createTempHome();

    try {
      await writeCurrentAuth(homeDir, "acct-overlay", "chatgpt", "plus", "user-overlay");
      await writeCurrentConfig(homeDir, 'cli_auth_credentials_store = "keyring"');
      const store = createAccountStore(homeDir);
      await store.saveCurrentAccount("overlay-main");

      const createStdout = captureWritable();
      const createStderr = captureWritable();
      const createExitCode = await runCli(
        ["overlay", "create", "overlay-main", "--owner-pid", "4242", "--json"],
        {
          store,
          stdout: createStdout.stream,
          stderr: createStderr.stream,
        },
      );

      expect(createExitCode).toBe(0);
      expect(createStderr.read()).toBe("");
      const created = JSON.parse(createStdout.read());
      expect(created).toMatchObject({
        ok: true,
        action: "overlay-create",
        overlay: {
          account_name: "overlay-main",
          owner_pid: 4242,
        },
      });

      const overlayPath = created.overlay.codex_home_path as string;
      expect(overlayPath).toContain(`${homeDir}/.codex-team/run-overlays/overlay-main/`);
      expect(await readFile(join(overlayPath, "auth.json"), "utf8")).toContain('"account_id": "acct-overlay"');
      expect(await readFile(join(overlayPath, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');

      const deleteStdout = captureWritable();
      const deleteStderr = captureWritable();
      const deleteExitCode = await runCli(["overlay", "delete", overlayPath, "--json"], {
        store,
        stdout: deleteStdout.stream,
        stderr: deleteStderr.stream,
      });

      expect(deleteExitCode).toBe(0);
      expect(deleteStderr.read()).toBe("");
      expect(JSON.parse(deleteStdout.read())).toMatchObject({
        ok: true,
        action: "overlay-delete",
        deleted: [overlayPath],
      });
      await expect(access(overlayPath)).rejects.toBeTruthy();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("overlay gc removes stale overlays with dead owner pids", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const staleOverlayPath = join(
        homeDir,
        ".codex-team",
        "run-overlays",
        "stale-main",
        "overlay-dead",
      );
      await mkdir(staleOverlayPath, { recursive: true });
      await writeFile(
        join(staleOverlayPath, "overlay.json"),
        `${JSON.stringify({
          accountName: "stale-main",
          createdAt: "2026-04-10T00:00:00.000Z",
          pid: 999_999,
          ownerPid: 999_999,
          runId: "overlay-dead",
        }, null, 2)}\n`,
      );

      const stdout = captureWritable();
      const stderr = captureWritable();
      const exitCode = await runCli(["overlay", "gc", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toBe("");
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "overlay-gc",
        deleted: [staleOverlayPath],
      });
      await expect(access(staleOverlayPath)).rejects.toBeTruthy();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
