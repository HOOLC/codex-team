import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import {
  exportShareBundleForTui,
  importShareBundleForTui,
  previewShareBundleForTui,
  deleteAccountForTui,
} from "../src/commands/tui-share.js";
import {
  cleanupTempHome,
  createAuthPayload,
  createTempHome,
  readCurrentAuth,
  writeCurrentAuth,
} from "./test-helpers.js";

async function writeShareBundle(
  filePath: string,
  options: {
    authSnapshot: ReturnType<typeof createAuthPayload>;
    sourceType?: "current" | "managed";
    sourceName?: string | null;
    suggestedName?: string | null;
  },
): Promise<void> {
  await import("node:fs/promises").then(async ({ writeFile }) => {
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
          config_snapshot: null,
        },
        null,
        2,
      )}\n`,
    );
  });
}

describe("TUI Share Actions", () => {
  test("exports the current auth and removes the bundle on undo", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const bundlePath = join(homeDir, "undo-export.codexm.json");
      await writeCurrentAuth(homeDir, "acct-export-current", "chatgpt", "plus", "user-export-current");

      const result = await exportShareBundleForTui({
        store,
        source: {
          type: "current",
          name: null,
        },
        outputPath: bundlePath,
      });

      expect(result.statusMessage).toBe(`Exported share bundle to ${bundlePath}.`);
      expect(JSON.parse(await readFile(bundlePath, "utf8"))).toMatchObject({
        source_type: "current",
        auth_snapshot: {
          tokens: {
            account_id: "acct-export-current",
          },
        },
      });

      const undoResult = await result.undo!.run();
      expect(undoResult.statusMessage).toBe(`Removed ${bundlePath}.`);
      await expect(readFile(bundlePath, "utf8")).rejects.toThrow();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("previews a share bundle for import", async () => {
    const homeDir = await createTempHome();

    try {
      const bundlePath = join(homeDir, "preview-share.codexm.json");
      await writeShareBundle(bundlePath, {
        authSnapshot: createAuthPayload("acct-preview", "chatgpt", "team", "user-preview"),
        sourceType: "managed",
        sourceName: "preview-main",
        suggestedName: "preview-main",
      });

      const preview = await previewShareBundleForTui(bundlePath);

      expect(preview.title).toBe("Import Bundle");
      expect(preview.bundlePath).toBe(bundlePath);
      expect(preview.suggestedName).toBe("preview-main");
      expect(preview.lines).toContain('Source: managed account "preview-main"');
      expect(preview.lines).toContain("Identity: acct-preview:user-preview");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("imports a share bundle and removes the saved account on undo", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const bundlePath = join(homeDir, "undo-import.codexm.json");
      await writeCurrentAuth(homeDir, "acct-before-import", "chatgpt", "plus", "user-before-import");
      await writeShareBundle(bundlePath, {
        authSnapshot: createAuthPayload("acct-import-tui", "chatgpt", "pro", "user-import-tui"),
        sourceType: "managed",
        sourceName: "source-main",
        suggestedName: "source-main",
      });

      const result = await importShareBundleForTui({
        store,
        bundlePath,
        localName: "friend-main",
      });

      expect(result.statusMessage).toBe('Imported account "friend-main".');
      expect(JSON.parse(await readFile(join(homeDir, ".codex-team", "accounts", "friend-main", "auth.json"), "utf8"))).toMatchObject({
        tokens: {
          account_id: "acct-import-tui",
        },
      });
      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-before-import");

      const undoResult = await result.undo!.run();
      expect(undoResult.statusMessage).toBe('Undid import "friend-main".');
      await expect(readFile(join(homeDir, ".codex-team", "accounts", "friend-main", "auth.json"), "utf8")).rejects.toThrow();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("deletes a managed account and restores it on undo", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-delete-tui", "chatgpt", "plus", "user-delete-tui");
      await store.saveCurrentAccount("delete-main");

      const result = await deleteAccountForTui({
        store,
        name: "delete-main",
      });

      expect(result.statusMessage).toBe('Deleted "delete-main".');
      await expect(readFile(join(homeDir, ".codex-team", "accounts", "delete-main", "auth.json"), "utf8")).rejects.toThrow();

      const undoResult = await result.undo!.run();
      expect(undoResult.statusMessage).toBe('Restored "delete-main".');
      expect(JSON.parse(await readFile(join(homeDir, ".codex-team", "accounts", "delete-main", "auth.json"), "utf8"))).toMatchObject({
        tokens: {
          account_id: "acct-delete-tui",
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
