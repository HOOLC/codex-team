import type { AccountStore } from "../account-store/index.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import { LocalUsageService } from "../local-usage/service.js";
import {
  LOCAL_USAGE_WINDOWS,
  type LocalUsageWindowName,
  formatLocalUsageDailyLine,
  formatLocalUsageWindowLine,
} from "../local-usage/format.js";

type DebugLogger = (message: string) => void;

function isLocalUsageWindowName(value: string): value is LocalUsageWindowName {
  return LOCAL_USAGE_WINDOWS.includes(value as LocalUsageWindowName);
}

export async function handleUsageCommand(options: {
  positionals: string[];
  window: string | undefined;
  daily: boolean;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  if (options.positionals.length !== 0) {
    throw new Error(`Usage: ${getUsage("usage")}`);
  }

  const selectedWindow = options.window;
  if (selectedWindow !== undefined && !isLocalUsageWindowName(selectedWindow)) {
    throw new Error(`Usage window must be one of: ${LOCAL_USAGE_WINDOWS.join(", ")}.`);
  }

  const service = new LocalUsageService({
    homeDir: options.store.paths.homeDir,
  });
  const summary = await service.load();

  options.debugLog?.(
    `usage: windows=${selectedWindow ?? "all"} daily=${options.daily} timezone=${summary.timezone}`,
  );

  if (options.json) {
    const windows = selectedWindow
      ? { [selectedWindow]: summary.windows[selectedWindow] }
      : summary.windows;
    writeJson(options.stdout, {
      generated_at: summary.generated_at,
      timezone: summary.timezone,
      ...(selectedWindow ? { selected_window: selectedWindow } : {}),
      windows,
      ...(options.daily ? { daily: summary.daily } : {}),
    });
    return 0;
  }

  const windowsToRender = selectedWindow ? [selectedWindow] : LOCAL_USAGE_WINDOWS;
  for (const windowName of windowsToRender) {
    options.stdout.write(`${formatLocalUsageWindowLine(windowName, summary.windows[windowName])}\n`);
  }

  if (options.daily) {
    options.stdout.write("\nDaily:\n");
    for (const entry of summary.daily) {
      options.stdout.write(`${formatLocalUsageDailyLine(entry)}\n`);
    }
  }

  return 0;
}
