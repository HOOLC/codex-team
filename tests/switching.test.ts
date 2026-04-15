import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import { tryAcquireSwitchLock } from "../src/switching.js";
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
});
