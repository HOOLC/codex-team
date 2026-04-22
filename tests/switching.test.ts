import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import {
  refreshManagedDesktopAfterSwitch,
  tryAcquireSwitchLock,
} from "../src/switching.js";
import { createDesktopLauncherStub } from "./cli-fixtures.js";
import { cleanupTempHome, createTempHome } from "./test-helpers.js";

describe("switching lock", () => {
  test("does not steal an existing switch lock when owner metadata is missing", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });

      const result = await tryAcquireSwitchLock(store, "switch target");

      expect(result).toEqual({
        acquired: false,
        lockPath,
        owner: null,
      });
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not steal an existing switch lock when owner metadata is malformed", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, "owner.json"), "{not-json}\n");

      const result = await tryAcquireSwitchLock(store, "switch target");

      expect(result).toEqual({
        acquired: false,
        lockPath,
        owner: null,
      });
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reports managed Desktop wait progress through the status callback", async () => {
    const messages: string[] = [];

    const outcome = await refreshManagedDesktopAfterSwitch(
      [],
      createDesktopLauncherStub({
        isManagedDesktopRunning: async () => true,
        applyManagedSwitch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        },
      }),
      {
        statusDelayMs: 1,
        statusIntervalMs: 5,
        onStatusMessage: (message) => {
          messages.push(message);
        },
      },
    );

    expect(outcome).toBe("applied");
    expect(messages).toContain(
      "Waiting for the current Codex Desktop thread to finish before applying the switch...",
    );
    expect(messages.some((message) => message.startsWith(
      "Still waiting for the current Codex Desktop thread to finish (",
    ))).toBe(true);
    expect(messages).toContain("Applied the switch to the managed Codex Desktop session.");
  });

  test("warns instead of hot-refreshing when the managed Desktop base URL differs from the desired proxy route", async () => {
    const warnings: string[] = [];
    let applyManagedSwitchCalls = 0;

    const outcome = await refreshManagedDesktopAfterSwitch(
      warnings,
      createDesktopLauncherStub({
        readManagedState: async () => ({
          pid: 123,
          app_path: "/Applications/Codex.app",
          remote_debugging_port: 39223,
          managed_by_codexm: true,
          started_at: "2026-04-22T00:00:00.000Z",
          desktop_api_base_url: null,
        }),
        applyManagedSwitch: async () => {
          applyManagedSwitchCalls += 1;
          return true;
        },
      }),
      {
        desiredDesktopApiBaseUrl: "http://127.0.0.1:14555/backend-api",
      },
    );

    expect(outcome).toBe("failed");
    expect(applyManagedSwitchCalls).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Relaunch Codex Desktop via \"codexm launch\"");
    expect(warnings[0]).toContain("http://127.0.0.1:14555/backend-api");
  });
});
