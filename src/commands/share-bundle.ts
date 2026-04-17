import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  ensureAccountName,
  type AccountStore,
} from "../account-store/index.js";
import {
  parseAuthSnapshot,
} from "../auth-snapshot.js";
import {
  getUsage,
} from "../cli/spec.js";
import { writeJson } from "../cli/output.js";
import { pathExists } from "../account-store/storage.js";
import {
  createShareBundle,
  deriveShareBundleFacts,
  type ShareBundle,
  type ShareBundleProfile,
  readShareBundleFile,
  writeShareBundleFile,
} from "../share-bundle.js";
import {
  validateConfigSnapshot,
} from "../account-store/config.js";

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

function describeBundleConfigPresence(hasConfigToml: boolean): string {
  return hasConfigToml ? "yes" : "no";
}

function validateChatGPTBundleProfile(
  bundleProfile: ShareBundleProfile | undefined,
  facts: ReturnType<typeof deriveShareBundleFacts>,
): void {
  if (!bundleProfile) {
    return;
  }

  const comparisons: Array<[keyof ShareBundleProfile, string | null | undefined]> = [
    ["account_id", facts.account_id],
    ["user_id", facts.user_id],
    ["email", facts.email],
    ["plan", facts.plan],
  ];

  for (const [fieldName, expectedValue] of comparisons) {
    const actualValue = bundleProfile[fieldName];
    if (actualValue === undefined) {
      continue;
    }
    if ((expectedValue ?? null) !== actualValue) {
      throw new Error(`Bundle profile field "${fieldName}" does not match auth snapshot.`);
    }
  }
}

export interface ShareBundleInspection {
  bundle_path: string;
  kind: string;
  version: number;
  exported_at: string;
  auth_kind: "chatgpt" | "apikey";
  auth_mode: string;
  account_id: string;
  user_id: string | null;
  identity: string;
  email: string | null;
  plan: string | null;
  profile_present: boolean;
  profile_consistent: boolean | null;
  contains_config_toml: boolean;
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
  let configToml: string | null = null;

  if (sourceType === "current") {
    if (!(await pathExists(store.paths.currentAuthPath))) {
      throw new Error("Current ~/.codex/auth.json does not exist.");
    }
    authSnapshot = parseAuthSnapshot(await readFile(store.paths.currentAuthPath, "utf8"));
    if (authSnapshot.auth_mode === "apikey" && (await pathExists(store.paths.currentConfigPath))) {
      configToml = await readFile(store.paths.currentConfigPath, "utf8");
    }
    validateConfigSnapshot("current-export", authSnapshot, configToml);
  } else {
    const managedName = sourceName;
    if (!managedName) {
      throw new Error("Managed export source is missing an account name.");
    }
    const account = await store.getManagedAccount(managedName);
    authSnapshot = parseAuthSnapshot(await readFile(account.authPath, "utf8"));
    if (account.configPath) {
      configToml = await readFile(account.configPath, "utf8");
    }
    if (authSnapshot.auth_mode === "apikey") {
      if (!configToml) {
        throw new Error(`Managed apikey account "${managedName}" is missing config.toml.`);
      }
      validateConfigSnapshot(managedName, authSnapshot, configToml);
    }
  }

  const bundle = createShareBundle({
    authSnapshot,
    configToml,
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
  const facts = deriveShareBundleFacts(bundle.auth.auth_json);

  if (bundle.auth.kind === "chatgpt") {
    validateChatGPTBundleProfile(bundle.auth.profile, facts);
  } else if (!bundle.auth.config_toml) {
    throw new Error("apikey share bundle is missing config.toml.");
  } else {
    validateConfigSnapshot(options.localName, bundle.auth.auth_json, bundle.auth.config_toml);
  }

  const account = await options.store.addAccountSnapshot(options.localName, bundle.auth.auth_json, {
    force: options.force,
    rawConfig: bundle.auth.config_toml ?? null,
  });

  return {
    bundle,
    account,
  };
}

export async function inspectShareBundle(bundlePath: string): Promise<ShareBundleInspection> {
  const bundle = await readShareBundleFile(bundlePath);
  const facts = deriveShareBundleFacts(bundle.auth.auth_json);
  let profileConsistent: boolean | null = null;

  if (bundle.auth.kind === "chatgpt" && bundle.auth.profile) {
    try {
      validateChatGPTBundleProfile(bundle.auth.profile, facts);
      profileConsistent = true;
    } catch {
      profileConsistent = false;
    }
  }

  return {
    bundle_path: bundlePath,
    kind: bundle.kind,
    version: bundle.version,
    exported_at: bundle.exported_at,
    auth_kind: bundle.auth.kind,
    auth_mode: bundle.auth.auth_json.auth_mode,
    account_id: facts.account_id,
    user_id: facts.user_id,
    identity: facts.identity,
    email: facts.email,
    plan: facts.plan,
    profile_present: bundle.auth.profile !== undefined,
    profile_consistent: profileConsistent,
    contains_config_toml: bundle.auth.config_toml !== undefined,
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
  const sourceType = sourceName ? "managed" : "current";
  const { bundlePath, bundle, importExample } = await exportShareBundle({
    store,
    sourceName,
    outputPath,
    force,
  });

  debugLog?.(`export: source=${sourceType}:${sourceName ?? "current"} path=${bundlePath}`);

  const payload = {
    ok: true,
    action: "export",
    bundle_path: bundlePath,
    source_type: sourceType,
    source_name: sourceName,
    auth_kind: bundle.auth.kind,
    identity: deriveShareBundleFacts(bundle.auth.auth_json).identity,
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

  debugLog?.(`inspect: path=${bundlePath} kind=${payload.kind}`);

  if (json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(`Bundle: ${bundlePath}\n`);
    stdout.write(`Kind: ${payload.kind}\n`);
    stdout.write(`Version: ${payload.version}\n`);
    stdout.write(`Exported at: ${payload.exported_at}\n`);
    stdout.write(`Auth kind: ${payload.auth_kind}\n`);
    stdout.write(`Auth mode: ${payload.auth_mode}\n`);
    stdout.write(`Identity: ${payload.identity}\n`);
    stdout.write(`Email: ${payload.email ?? "-"}\n`);
    stdout.write(`Plan: ${payload.plan ?? "-"}\n`);
    stdout.write(`Profile: ${payload.profile_present ? "yes" : "no"}\n`);
    if (payload.profile_consistent !== null) {
      stdout.write(`Profile consistent: ${payload.profile_consistent ? "yes" : "no"}\n`);
    }
    stdout.write(`Contains config.toml: ${describeBundleConfigPresence(payload.contains_config_toml)}\n`);
  }

  return 0;
}
