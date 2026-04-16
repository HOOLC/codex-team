import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AccountStore } from "../account-store/index.js";
import {
  DIRECTORY_MODE,
  ensureDirectory,
} from "../account-store/storage.js";
import type {
  AccountDashboardActionResult,
  AccountDashboardExportSource,
  AccountDashboardImportPreview,
} from "../tui/index.js";
import {
  exportShareBundle,
  importShareBundle,
  inspectShareBundle,
} from "./share-bundle.js";

function buildDeleteBackupPath(store: AccountStore, name: string): string {
  return join(store.paths.backupsDir, `tui-delete-${Date.now()}-${name}`);
}

export async function exportShareBundleForTui(options: {
  store: AccountStore;
  source: AccountDashboardExportSource;
  outputPath: string;
}): Promise<AccountDashboardActionResult> {
  const { bundlePath } = await exportShareBundle({
    store: options.store,
    sourceName: options.source.type === "managed" ? options.source.name : null,
    outputPath: options.outputPath,
    force: false,
  });

  return {
    statusMessage: `Exported share bundle to ${bundlePath}.`,
    undo: {
      label: "undo export",
      run: async () => {
        await rm(bundlePath, { force: true });
        return {
          statusMessage: `Removed ${bundlePath}.`,
        };
      },
    },
  };
}

export async function previewShareBundleForTui(
  bundlePath: string,
): Promise<AccountDashboardImportPreview> {
  const inspection = await inspectShareBundle(bundlePath);
  return {
    bundlePath,
    suggestedName: inspection.suggested_name,
    title: "Import Bundle",
    lines: [
      `Source: ${inspection.source_type === "managed" && inspection.source_name ? `managed account "${inspection.source_name}"` : "current auth"}`,
      `Suggested name: ${inspection.suggested_name ?? "-"}`,
      `Auth mode: ${inspection.auth_mode}`,
      `Identity: ${inspection.identity}`,
      `Contains config snapshot: ${inspection.contains_config_snapshot ? "yes" : "no"}`,
    ],
  };
}

export async function importShareBundleForTui(options: {
  store: AccountStore;
  bundlePath: string;
  localName: string;
}): Promise<AccountDashboardActionResult> {
  const { account } = await importShareBundle({
    store: options.store,
    bundlePath: options.bundlePath,
    localName: options.localName,
    force: false,
  });

  return {
    statusMessage: `Imported account "${account.name}".`,
    preferredName: account.name,
    undo: {
      label: "undo import",
      run: async () => {
        await options.store.removeAccount(account.name);
        return {
          statusMessage: `Undid import "${account.name}".`,
        };
      },
    },
  };
}

export async function deleteAccountForTui(options: {
  store: AccountStore;
  name: string;
}): Promise<AccountDashboardActionResult> {
  const account = await options.store.getManagedAccount(options.name);
  const accountDir = dirname(account.authPath);
  const backupPath = buildDeleteBackupPath(options.store, options.name);
  await ensureDirectory(options.store.paths.backupsDir, DIRECTORY_MODE);
  await rename(accountDir, backupPath);

  return {
    statusMessage: `Deleted "${options.name}".`,
    undo: {
      label: "undo delete",
      run: async () => {
        await rename(backupPath, accountDir);
        return {
          statusMessage: `Restored "${options.name}".`,
          preferredName: options.name,
        };
      },
      discard: async () => {
        await rm(backupPath, { recursive: true, force: true });
      },
    },
  };
}
