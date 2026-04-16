import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  ensureAccountName,
  type AccountStore,
} from "../account-store/index.js";
import {
  getSnapshotAccountId,
  getSnapshotIdentity,
  getSnapshotUserId,
  parseAuthSnapshot,
} from "../auth-snapshot.js";
import {
  getUsage,
} from "../cli/spec.js";
import { writeJson } from "../cli/output.js";
import { pathExists } from "../account-store/storage.js";
import {
  createShareBundle,
  type ShareBundle,
  readShareBundleFile,
  writeShareBundleFile,
} from "../share-bundle.js";

type DebugLogger = (message: string) => void;

function formatTimestampForFilename(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
}

function buildDefaultBundlePath(sourceType: "current" | "managed", sourceName: string | null, now: Date): string {
  const base = sourceType === "managed" && sourceName ? sourceName : "current";
  return `./codexm-share-${base}-${formatTimestampForFilename(now)}.json`;
}

function formatImportExample(bundlePath: string): string {
  return `codexm import ${bundlePath} --name <local-name>`;
}

function describeBundleSource(bundle: {
  source_type: "current" | "managed";
  source_name: string | null;
}): string {
  return bundle.source_type === "managed" && bundle.source_name
    ? `managed account "${bundle.source_name}"`
    : "current auth";
}

export interface ShareBundleInspection {
  bundle_path: string;
  schema_version: number;
  exported_at: string;
  source_type: "current" | "managed";
  source_name: string | null;
  suggested_name: string | null;
  auth_mode: string;
  account_id: string;
  user_id: string | null;
  identity: string;
  contains_config_snapshot: boolean;
  bundle_file_name: string;
}

export async function exportShareBundle(options: {
  store: AccountStore;
  sourceName: string | null;
  outputPath?: string;
  force?: boolean;
  exportedAt?: Date;
}): Promise<{
  bundlePath: string;
  bundle: ShareBundle;
  importExample: string;
}> {
  const { store } = options;
  const sourceName = options.sourceName ?? null;
  const sourceType = sourceName ? "managed" : "current";
  const exportedAt = options.exportedAt ?? new Date();
  const resolvedOutputPath = options.outputPath ?? buildDefaultBundlePath(sourceType, sourceName, exportedAt);

  if (await pathExists(resolvedOutputPath)) {
    if (options.force !== true) {
      throw new Error("Bundle output already exists. Use --force to overwrite it.");
    }
  }

  let authSnapshot;
  let configSnapshot: string | null = null;
  let suggestedName: string | null = null;

  if (sourceType === "current") {
    if (!(await pathExists(store.paths.currentAuthPath))) {
      throw new Error("Current ~/.codex/auth.json does not exist.");
    }
    authSnapshot = parseAuthSnapshot(await readFile(store.paths.currentAuthPath, "utf8"));
    if (authSnapshot.auth_mode === "apikey" && (await pathExists(store.paths.currentConfigPath))) {
      configSnapshot = await readFile(store.paths.currentConfigPath, "utf8");
    }
  } else {
    const managedName = sourceName;
    if (!managedName) {
      throw new Error("Managed export source is missing an account name.");
    }
    const account = await store.getManagedAccount(managedName);
    authSnapshot = parseAuthSnapshot(await readFile(account.authPath, "utf8"));
    suggestedName = account.name;
    if (account.configPath) {
      configSnapshot = await readFile(account.configPath, "utf8");
    }
  }

  const bundle = createShareBundle({
    sourceType,
    sourceName,
    suggestedName,
    authSnapshot,
    configSnapshot,
    exportedAt,
  });
  await writeShareBundleFile(resolvedOutputPath, bundle);

  return {
    bundlePath: resolvedOutputPath,
    bundle,
    importExample: formatImportExample(resolvedOutputPath),
  };
}

export async function importShareBundle(options: {
  store: AccountStore;
  bundlePath: string;
  localName: string;
  force?: boolean;
}) {
  ensureAccountName(options.localName);
  const bundle = await readShareBundleFile(options.bundlePath);
  const account = await options.store.addAccountSnapshot(options.localName, bundle.auth_snapshot, {
    force: options.force,
    rawConfig: bundle.config_snapshot,
  });

  return {
    bundle,
    account,
  };
}

export async function inspectShareBundle(bundlePath: string): Promise<ShareBundleInspection> {
  const bundle = await readShareBundleFile(bundlePath);
  return {
    bundle_path: bundlePath,
    schema_version: bundle.schema_version,
    exported_at: bundle.exported_at,
    source_type: bundle.source_type,
    source_name: bundle.source_name,
    suggested_name: bundle.suggested_name,
    auth_mode: bundle.auth_snapshot.auth_mode,
    account_id: getSnapshotAccountId(bundle.auth_snapshot),
    user_id: getSnapshotUserId(bundle.auth_snapshot) ?? null,
    identity: getSnapshotIdentity(bundle.auth_snapshot),
    contains_config_snapshot: bundle.config_snapshot !== null,
    bundle_file_name: basename(bundlePath),
  };
}

export async function handleExportCommand(options: {
  positionals: string[];
  outputPath: string | undefined;
  force: boolean;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { positionals, outputPath, force, json, store, stdout, debugLog } = options;
  if (positionals.length > 1) {
    throw new Error(`Usage: ${getUsage("export")}`);
  }

  const sourceName = positionals[0] ?? null;
  const { bundlePath, bundle, importExample } = await exportShareBundle({
    store,
    sourceName,
    outputPath,
    force,
  });

  debugLog?.(`export: source=${bundle.source_type}:${sourceName ?? "current"} path=${bundlePath}`);

  const payload = {
    ok: true,
    action: "export",
    bundle_path: bundlePath,
    source_type: bundle.source_type,
    source_name: bundle.source_name,
    auth_mode: bundle.auth_snapshot.auth_mode,
    identity: getSnapshotIdentity(bundle.auth_snapshot),
    import_example: importExample,
  };

  if (json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(`Exported share bundle to ${bundlePath}\n\n`);
    stdout.write("Import on another machine:\n");
    stdout.write(`  ${payload.import_example}\n`);
  }

  return 0;
}

export async function handleImportCommand(options: {
  positionals: string[];
  localName: string | undefined;
  force: boolean;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { positionals, localName, force, json, store, stdout, debugLog } = options;
  if (positionals.length !== 1 || !localName) {
    throw new Error(`Usage: ${getUsage("import")}`);
  }
  ensureAccountName(localName);

  const bundlePath = positionals[0];
  const { account } = await importShareBundle({
    store,
    bundlePath,
    localName,
    force,
  });

  debugLog?.(`import: path=${bundlePath} name=${localName} identity=${account.identity}`);

  const payload = {
    ok: true,
    action: "import",
    source_bundle: bundlePath,
    switched: false,
    account: {
      name: account.name,
      account_id: account.account_id,
      user_id: account.user_id ?? null,
      identity: account.identity,
      auth_mode: account.auth_mode,
    },
  };

  if (json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(`Imported account "${account.name}" from ${bundlePath}.\n`);
    stdout.write("Current auth was not changed.\n");
  }

  return 0;
}

export async function handleInspectBundleCommand(options: {
  positionals: string[];
  json: boolean;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { positionals, json, stdout, debugLog } = options;
  if (positionals.length !== 1) {
    throw new Error(`Usage: ${getUsage("inspect")}`);
  }

  const bundlePath = positionals[0];
  const payload = {
    ok: true,
    action: "inspect",
    ...(await inspectShareBundle(bundlePath)),
  };

  debugLog?.(`inspect: path=${bundlePath} source=${payload.source_type}`);

  if (json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(`Bundle: ${bundlePath}\n`);
    stdout.write(`Schema: ${payload.schema_version}\n`);
    stdout.write(`Exported at: ${payload.exported_at}\n`);
    stdout.write(`Source: ${describeBundleSource(payload)}\n`);
    stdout.write(`Suggested name: ${payload.suggested_name ?? "-"}\n`);
    stdout.write(`Auth mode: ${payload.auth_mode}\n`);
    stdout.write(`Identity: ${payload.identity}\n`);
    stdout.write(`Contains config snapshot: ${payload.contains_config_snapshot ? "yes" : "no"}\n`);
  }

  return 0;
}
