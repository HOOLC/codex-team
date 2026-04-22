import { readFile } from "node:fs/promises";

import {
  getSnapshotAccountId,
  getSnapshotEmail,
  parseAuthSnapshot,
} from "../auth-snapshot.js";
import type { AccountStore } from "../account-store/index.js";
import type { RunnerOptions, RunnerResult } from "../codex-cli-runner.js";
import {
  prepareIsolatedCodexRun,
  prepareIsolatedProxyRun,
  startIsolatedQuotaHistorySampler,
  type PreparedIsolatedCodexRun,
} from "./isolated-runtime.js";

type RunCodexCli = (options: RunnerOptions) => Promise<RunnerResult>;

export async function readCurrentRunAccountMetadata(
  store: AccountStore,
): Promise<{ accountId: string | null; email: string | null }> {
  try {
    const rawAuth = await readFile(store.paths.currentAuthPath, "utf8");
    const snapshot = parseAuthSnapshot(rawAuth);
    return {
      accountId: getSnapshotAccountId(snapshot) || null,
      email: getSnapshotEmail(snapshot) ?? null,
    };
  } catch {
    return {
      accountId: null,
      email: null,
    };
  }
}

export async function runDirectCodexSession(options: {
  store: AccountStore;
  runCodexCli: RunCodexCli;
  codexArgs: string[];
  debugLog?: (message: string) => void;
  stderr: NodeJS.WriteStream;
  signal?: AbortSignal;
}): Promise<RunnerResult> {
  const currentAccount = await readCurrentRunAccountMetadata(options.store);
  return await options.runCodexCli({
    codexArgs: options.codexArgs,
    accountId: currentAccount.accountId,
    email: currentAccount.email,
    debugLog: options.debugLog,
    stderr: options.stderr,
    signal: options.signal,
  });
}

export async function runIsolatedAccountCodexSession(options: {
  accountName: string;
  store: AccountStore;
  runCodexCli: RunCodexCli;
  codexArgs: string[];
  debugLog?: (message: string) => void;
  stderr: NodeJS.WriteStream;
  signal?: AbortSignal;
  pollIntervalMs: number;
  prepareIsolatedRunImpl?: (options: {
    accountName: string;
    baseEnv?: NodeJS.ProcessEnv;
    store: AccountStore;
  }) => Promise<PreparedIsolatedCodexRun>;
  startIsolatedQuotaHistorySamplerImpl?: typeof startIsolatedQuotaHistorySampler;
}): Promise<RunnerResult> {
  const prepareIsolatedRunImpl =
    options.prepareIsolatedRunImpl ?? prepareIsolatedCodexRun;
  const startIsolatedQuotaHistorySamplerImpl =
    options.startIsolatedQuotaHistorySamplerImpl ?? startIsolatedQuotaHistorySampler;
  const preparedRun = await prepareIsolatedRunImpl({
    accountName: options.accountName,
    baseEnv: process.env,
    store: options.store,
  });
  const sampler = startIsolatedQuotaHistorySamplerImpl({
    account: preparedRun.account,
    codexHomeEnv: preparedRun.env,
    pollIntervalMs: options.pollIntervalMs,
    scopeId: preparedRun.runId,
    store: options.store,
    debugLog: options.debugLog,
  });

  try {
    return await options.runCodexCli({
      codexArgs: options.codexArgs,
      accountId: preparedRun.account.account_id,
      email: preparedRun.account.email ?? null,
      authFilePath: preparedRun.authFilePath,
      sessionsDirPath: preparedRun.sessionsDirPath,
      env: preparedRun.env,
      disableAuthWatch: true,
      registerProcess: false,
      debugLog: options.debugLog,
      stderr: options.stderr,
      signal: options.signal,
    });
  } finally {
    await sampler.stop();
    await preparedRun.cleanup();
  }
}

export async function runIsolatedProxyCodexSession(options: {
  backendBaseUrl: string;
  openAIBaseUrl: string;
  store: AccountStore;
  runCodexCli: RunCodexCli;
  codexArgs: string[];
  debugLog?: (message: string) => void;
  stderr: NodeJS.WriteStream;
  signal?: AbortSignal;
}): Promise<RunnerResult> {
  const preparedRun = await prepareIsolatedProxyRun({
    backendBaseUrl: options.backendBaseUrl,
    openAIBaseUrl: options.openAIBaseUrl,
    baseEnv: process.env,
    store: options.store,
  });

  try {
    return await options.runCodexCli({
      codexArgs: options.codexArgs,
      accountId: preparedRun.account.account_id,
      email: preparedRun.account.email,
      authFilePath: preparedRun.authFilePath,
      sessionsDirPath: preparedRun.sessionsDirPath,
      env: preparedRun.env,
      disableAuthWatch: true,
      registerProcess: false,
      debugLog: options.debugLog,
      stderr: options.stderr,
      signal: options.signal,
    });
  } finally {
    await preparedRun.cleanup();
  }
}
