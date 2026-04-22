import { ensureAccountName, type AccountStore } from "../account-store/index.js";
import type { CodexLoginProvider } from "../codex-login.js";
import { maskAccountId } from "../auth-snapshot.js";
import { toCliQuotaSummary } from "../cli/quota.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import { ensureNotReservedProxyAccountName } from "../proxy/constants.js";

interface CommandStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

type DebugLogger = (message: string) => void;

async function readStreamToString(stream: NodeJS.ReadStream): Promise<string> {
  let content = "";
  stream.setEncoding("utf8");

  for await (const chunk of stream) {
    content += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }

  return content;
}

async function confirmRemoval(name: string, streams: CommandStreams): Promise<boolean> {
  if (!streams.stdin.isTTY) {
    throw new Error(`Refusing to remove "${name}" without --yes in a non-interactive terminal.`);
  }

  streams.stdout.write(`Remove saved account "${name}"? [y/N] `);

  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      streams.stdin.off("data", onData);
      streams.stdin.pause();
    };

    const onData = (buffer: Buffer) => {
      const answer = buffer.toString("utf8").trim().toLowerCase();
      cleanup();
      streams.stdout.write("\n");
      resolve(answer === "y" || answer === "yes");
    };

    streams.stdin.resume();
    streams.stdin.on("data", onData);
  });
}

function toCliAccount(account: {
  name: string;
  account_id: string | null;
  user_id?: string | null;
  identity: string | null;
  auth_mode: string;
  auto_switch_eligible?: boolean;
}) {
  return {
    name: account.name,
    account_id: account.account_id,
    user_id: account.user_id ?? null,
    identity: account.identity,
    auth_mode: account.auth_mode,
    auto_switch_eligible: account.auto_switch_eligible ?? true,
  };
}

export async function handleAddCommand(options: {
  name: string | undefined;
  positionals: string[];
  deviceAuth: boolean;
  withApiKey: boolean;
  force: boolean;
  json: boolean;
  store: AccountStore;
  authLogin: CodexLoginProvider;
  streams: CommandStreams;
  debugLog?: DebugLogger;
}): Promise<number> {
  const {
    name,
    positionals,
    deviceAuth,
    withApiKey,
    force,
    json,
    store,
    authLogin,
    streams,
    debugLog,
  } = options;

  if (!name || positionals.length !== 1 || (deviceAuth && withApiKey)) {
    throw new Error(`Usage: ${getUsage("add")}`);
  }
  ensureAccountName(name);
  ensureNotReservedProxyAccountName(name, "name a managed account");

  const snapshot = withApiKey
    ? {
        auth_mode: "apikey" as const,
        OPENAI_API_KEY: (await readStreamToString(streams.stdin)).trim(),
      }
    : await authLogin.login({
        mode: deviceAuth ? "device" : "browser",
        stdout: streams.stdout,
        stderr: streams.stderr,
      });

  if (withApiKey && !snapshot.OPENAI_API_KEY) {
    throw new Error("No API key was provided on stdin.");
  }

  const account = await store.addAccountSnapshot(name, snapshot, {
    force,
    rawConfig: withApiKey ? "" : null,
  });
  debugLog?.(
    `add: name=${account.name} auth_mode=${account.auth_mode} identity=${maskAccountId(account.identity)} mode=${withApiKey ? "apikey" : deviceAuth ? "device" : "browser"}`,
  );

  const payload = {
    ok: true,
    action: "add",
    account: toCliAccount(account),
  };

  if (json) {
    writeJson(streams.stdout, payload);
  } else {
    streams.stdout.write(`Added account "${account.name}" (${maskAccountId(account.identity)}).\n`);
  }

  return 0;
}

export async function handleSaveCommand(options: {
  name: string | undefined;
  json: boolean;
  force: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { name, json, force, store, stdout, debugLog } = options;

  if (!name) {
    throw new Error(`Usage: ${getUsage("save")}`);
  }
  ensureAccountName(name);
  ensureNotReservedProxyAccountName(name, "name a managed account");

  const account = await store.saveCurrentAccount(name, force);
  debugLog?.(
    `save: name=${account.name} auth_mode=${account.auth_mode} identity=${maskAccountId(account.identity)}`,
  );

  const payload = {
    ok: true,
    action: "save",
    account: toCliAccount(account),
  };

  if (json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(`Saved account "${account.name}" (${maskAccountId(account.identity)}).\n`);
  }

  return 0;
}

export async function handleUpdateCommand(options: {
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { json, store, stdout, debugLog } = options;
  const result = await store.updateCurrentManagedAccount();
  const warnings: string[] = [];
  let quota: ReturnType<typeof toCliQuotaSummary> | null = null;

  try {
    const quotaResult = await store.refreshQuotaForAccount(result.account.name);
    const quotaList = await store.listQuotaSummaries();
    const matched =
      quotaList.accounts.find((account) => account.name === quotaResult.account.name) ?? null;
    quota = matched ? toCliQuotaSummary(matched) : null;
  } catch (error) {
    warnings.push((error as Error).message);
  }

  const payload = {
    ok: true,
    action: "update",
    account: toCliAccount(result.account),
    quota,
    warnings,
  };

  debugLog?.(
    `update: name=${result.account.name} quota=${quota?.refresh_status ?? "unknown"} warnings=${warnings.length}`,
  );

  if (json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(
      `Updated managed account "${result.account.name}" (${maskAccountId(result.account.identity)}).\n`,
    );
    for (const warning of warnings) {
      stdout.write(`Warning: ${warning}\n`);
    }
  }

  return 0;
}

export async function handleRemoveCommand(options: {
  name: string | undefined;
  json: boolean;
  yes: boolean;
  store: AccountStore;
  streams: CommandStreams;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { name, json, yes, store, streams, debugLog } = options;

  if (!name) {
    throw new Error(`Usage: ${getUsage("remove")}`);
  }
  ensureAccountName(name);

  const confirmed = yes || (await confirmRemoval(name, streams));
  debugLog?.(`remove: target=${name} confirmed=${confirmed}`);
  if (!confirmed) {
    if (json) {
      writeJson(streams.stdout, {
        ok: false,
        action: "remove",
        account: name,
        cancelled: true,
      });
    } else {
      streams.stdout.write("Cancelled.\n");
    }
    return 1;
  }

  await store.removeAccount(name);
  if (json) {
    writeJson(streams.stdout, { ok: true, action: "remove", account: name });
  } else {
    streams.stdout.write(`Removed account "${name}".\n`);
  }

  return 0;
}

export async function handleRenameCommand(options: {
  oldName: string | undefined;
  newName: string | undefined;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { oldName, newName, json, store, stdout, debugLog } = options;

  if (!oldName || !newName) {
    throw new Error(`Usage: ${getUsage("rename")}`);
  }
  ensureAccountName(oldName);
  ensureAccountName(newName);
  ensureNotReservedProxyAccountName(newName, "rename an account to that name");

  const account = await store.renameAccount(oldName, newName);
  debugLog?.(
    `rename: from=${oldName} to=${newName} identity=${maskAccountId(account.identity)}`,
  );

  if (json) {
    writeJson(stdout, {
      ok: true,
      action: "rename",
      account: toCliAccount(account),
    });
  } else {
    stdout.write(`Renamed "${oldName}" to "${newName}".\n`);
  }

  return 0;
}

export async function handleProtectCommand(options: {
  name: string | undefined;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { name, json, store, stdout, debugLog } = options;

  if (!name) {
    throw new Error(`Usage: ${getUsage("protect")}`);
  }
  ensureAccountName(name);

  const account = await store.setAutoSwitchEligibility(name, false);
  debugLog?.(`protect: name=${account.name} auto_switch_eligible=${account.auto_switch_eligible}`);

  if (json) {
    writeJson(stdout, {
      ok: true,
      action: "protect",
      account: toCliAccount(account),
    });
  } else {
    stdout.write(`Protected "${account.name}" from auto-switch target selection.\n`);
  }

  return 0;
}

export async function handleUnprotectCommand(options: {
  name: string | undefined;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { name, json, store, stdout, debugLog } = options;

  if (!name) {
    throw new Error(`Usage: ${getUsage("unprotect")}`);
  }
  ensureAccountName(name);

  const account = await store.setAutoSwitchEligibility(name, true);
  debugLog?.(`unprotect: name=${account.name} auto_switch_eligible=${account.auto_switch_eligible}`);

  if (json) {
    writeJson(stdout, {
      ok: true,
      action: "unprotect",
      account: toCliAccount(account),
    });
  } else {
    stdout.write(`Removed auto-switch protection from "${account.name}".\n`);
  }

  return 0;
}
