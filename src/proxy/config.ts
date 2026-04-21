import { copyFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AccountStore } from "../account-store/index.js";
import {
  FILE_MODE,
  atomicWriteFile,
  chmodIfPossible,
  ensureDirectory,
  pathExists,
} from "../account-store/storage.js";
import {
  PROXY_MODEL_PROVIDER_ID,
  PROXY_MODEL_PROVIDER_NAME,
} from "./constants.js";
import { readAuthSnapshotFile } from "../auth-snapshot.js";
import { createSyntheticProxyAuthSnapshot, isSyntheticProxyAuthSnapshot } from "./synthetic-auth.js";
import { resolveProxyDataDir, type ProxyProcessState } from "./state.js";

function stripProxyProviderTable(lines: string[]): string[] {
  const result: string[] = [];
  let skippingProxyTable = false;

  for (const line of lines) {
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (tableMatch) {
      const tableName = tableMatch[1]?.trim() ?? "";
      if (
        tableName === `model_providers.${PROXY_MODEL_PROVIDER_ID}`
        || tableName.startsWith(`model_providers.${PROXY_MODEL_PROVIDER_ID}.`)
      ) {
        skippingProxyTable = true;
        continue;
      }
      skippingProxyTable = false;
    }

    if (!skippingProxyTable) {
      result.push(line);
    }
  }

  return result;
}

function withoutProxyConfigLines(rawConfig: string | null): string[] {
  return stripProxyProviderTable(
    (rawConfig ?? "")
      .split(/\r?\n/u)
      .filter((line) => !/^\s*chatgpt_base_url\s*=/u.test(line))
      .filter((line) => !/^\s*openai_base_url\s*=/u.test(line))
      .filter((line) => !/^\s*preferred_auth_method\s*=/u.test(line))
      .filter((line) => !/^\s*model_provider\s*=/u.test(line)),
  );
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed.at(-1) === "") {
    trimmed.pop();
  }
  return trimmed;
}

function sanitizeProxyConfig(rawConfig: string | null): string | null {
  const sanitizedLines = trimTrailingBlankLines(withoutProxyConfigLines(rawConfig));
  if (sanitizedLines.length === 0) {
    return null;
  }

  return `${sanitizedLines.join("\n")}\n`;
}

function buildProxyProviderLines(openAIBaseUrl: string): string[] {
  return [
    `[model_providers.${PROXY_MODEL_PROVIDER_ID}]`,
    `name = "${PROXY_MODEL_PROVIDER_NAME}"`,
    `base_url = "${openAIBaseUrl}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = true",
  ];
}

export function buildProxyConfig(
  rawConfig: string | null,
  backendBaseUrl: string,
  openAIBaseUrl: string,
): string {
  const lines = withoutProxyConfigLines(rawConfig);
  const proxyLines = [
    `model_provider = "${PROXY_MODEL_PROVIDER_ID}"`,
    'preferred_auth_method = "chatgpt"',
    `chatgpt_base_url = "${backendBaseUrl}"`,
    `openai_base_url = "${openAIBaseUrl}"`,
  ];
  const providerLines = buildProxyProviderLines(openAIBaseUrl);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/u.test(line));

  if (firstTableIndex === -1) {
    return `${[
      ...trimTrailingBlankLines(lines),
      ...proxyLines,
      "",
      ...providerLines,
    ].join("\n")}\n`;
  }

  const beforeTable = trimTrailingBlankLines(lines.slice(0, firstTableIndex));
  const fromFirstTable = lines.slice(firstTableIndex);
  return `${[
    ...beforeTable,
    ...proxyLines,
    "",
    ...providerLines,
    "",
    ...fromFirstTable,
  ].join("\n")}\n`;
}

async function currentAuthIsSynthetic(store: AccountStore): Promise<boolean> {
  try {
    return isSyntheticProxyAuthSnapshot(await readAuthSnapshotFile(store.paths.currentAuthPath));
  } catch {
    return false;
  }
}

export async function writeSyntheticProxyRuntime(options: {
  store: AccountStore;
  state: ProxyProcessState;
  now?: Date;
}): Promise<ProxyProcessState> {
  const proxyDataDir = resolveProxyDataDir(options.store.paths.codexTeamDir);
  await ensureDirectory(proxyDataDir, 0o700);

  const syntheticAlreadyActive = await currentAuthIsSynthetic(options.store);
  const authBackupPath = join(proxyDataDir, "last-direct-auth.json");
  const configBackupPath = join(proxyDataDir, "last-direct-config.toml");
  const authExisted = await pathExists(options.store.paths.currentAuthPath);
  const configExisted = await pathExists(options.store.paths.currentConfigPath);

  if (!syntheticAlreadyActive) {
    if (authExisted) {
      await copyFile(options.store.paths.currentAuthPath, authBackupPath);
      await chmodIfPossible(authBackupPath, FILE_MODE);
    } else {
      await rm(authBackupPath, { force: true });
    }

    if (configExisted) {
      await copyFile(options.store.paths.currentConfigPath, configBackupPath);
      await chmodIfPossible(configBackupPath, FILE_MODE);
    } else {
      await rm(configBackupPath, { force: true });
    }
  }

  const rawConfig = configExisted
    ? await readFile(options.store.paths.currentConfigPath, "utf8")
    : null;
  const syntheticAuth = createSyntheticProxyAuthSnapshot(options.now ?? new Date());

  await atomicWriteFile(
    options.store.paths.currentAuthPath,
    `${JSON.stringify(syntheticAuth, null, 2)}\n`,
    FILE_MODE,
  );
  await atomicWriteFile(
    options.store.paths.currentConfigPath,
    buildProxyConfig(rawConfig, options.state.base_url, options.state.openai_base_url),
    FILE_MODE,
  );

  return {
    ...options.state,
    enabled: true,
    enabled_at: new Date().toISOString(),
    direct_auth_backup_path: authExisted ? authBackupPath : null,
    direct_config_backup_path: configExisted ? configBackupPath : null,
    direct_auth_existed: authExisted,
    direct_config_existed: configExisted,
  };
}

export async function restoreDirectRuntime(options: {
  store: AccountStore;
  state: ProxyProcessState | null;
}): Promise<{ auth_restored: boolean; config_restored: boolean }> {
  const state = options.state;
  let authRestored = false;
  let configRestored = false;

  if (state?.direct_auth_existed === false) {
    await rm(options.store.paths.currentAuthPath, { force: true });
    authRestored = true;
  } else if (state?.direct_auth_backup_path && await pathExists(state.direct_auth_backup_path)) {
    await copyFile(state.direct_auth_backup_path, options.store.paths.currentAuthPath);
    await chmodIfPossible(options.store.paths.currentAuthPath, FILE_MODE);
    authRestored = true;
  }

  if (state?.direct_config_existed === false) {
    await rm(options.store.paths.currentConfigPath, { force: true });
    configRestored = true;
  } else if (state?.direct_config_backup_path && await pathExists(state.direct_config_backup_path)) {
    await copyFile(state.direct_config_backup_path, options.store.paths.currentConfigPath);
    await chmodIfPossible(options.store.paths.currentConfigPath, FILE_MODE);
    configRestored = true;
  } else if (await pathExists(options.store.paths.currentConfigPath)) {
    const rawConfig = await readFile(options.store.paths.currentConfigPath, "utf8");
    const sanitizedConfig = sanitizeProxyConfig(rawConfig);
    if (sanitizedConfig === null) {
      await rm(options.store.paths.currentConfigPath, { force: true });
      configRestored = true;
    } else if (sanitizedConfig !== rawConfig) {
      await atomicWriteFile(options.store.paths.currentConfigPath, sanitizedConfig, FILE_MODE);
      configRestored = true;
    }
  }

  return {
    auth_restored: authRestored,
    config_restored: configRestored,
  };
}
