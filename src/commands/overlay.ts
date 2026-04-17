import type { AccountStore } from "../account-store/index.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import {
  deleteCodexOverlay,
  garbageCollectCodexOverlays,
  prepareCodexOverlay,
} from "../run/isolated-runtime.js";

type DebugLogger = (message: string) => void;

function parseOwnerPid(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const ownerPid = Number(rawValue);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new Error('Flag "--owner-pid" must be a positive integer.');
  }

  return ownerPid;
}

export async function handleOverlayCommand(options: {
  positionals: string[];
  ownerPid?: string;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { positionals, ownerPid, json, store, stdout, debugLog } = options;
  const [subcommand, ref] = positionals;

  if (subcommand === "create") {
    if (!ref) {
      throw new Error(`Usage: ${getUsage("overlay", "create")}`);
    }

    const overlay = await prepareCodexOverlay({
      accountName: ref,
      store,
      ownerPid: parseOwnerPid(ownerPid),
    });
    debugLog?.(
      `overlay:create account=${overlay.account.name} run_id=${overlay.runId} owner_pid=${overlay.ownerPid}`,
    );

    if (json) {
      writeJson(stdout, {
        ok: true,
        action: "overlay-create",
        overlay: {
          account_name: overlay.account.name,
          codex_home_path: overlay.codexHomePath,
          auth_file_path: overlay.authFilePath,
          run_id: overlay.runId,
          owner_pid: overlay.ownerPid,
        },
      });
    } else {
      stdout.write(`${overlay.codexHomePath}\n`);
    }
    return 0;
  }

  if (subcommand === "delete") {
    if (!ref) {
      throw new Error(`Usage: ${getUsage("overlay", "delete")}`);
    }

    const deleted = await deleteCodexOverlay({ store, ref });
    debugLog?.(`overlay:delete ref=${ref} deleted=${deleted.length}`);
    if (json) {
      writeJson(stdout, {
        ok: true,
        action: "overlay-delete",
        deleted,
      });
    } else {
      for (const path of deleted) {
        stdout.write(`${path}\n`);
      }
    }
    return 0;
  }

  if (subcommand === "gc") {
    const deleted = await garbageCollectCodexOverlays({ store });
    debugLog?.(`overlay:gc deleted=${deleted.length}`);
    if (json) {
      writeJson(stdout, {
        ok: true,
        action: "overlay-gc",
        deleted,
      });
    } else {
      for (const path of deleted) {
        stdout.write(`${path}\n`);
      }
    }
    return 0;
  }

  throw new Error(`Usage: ${getUsage("overlay")}`);
}
