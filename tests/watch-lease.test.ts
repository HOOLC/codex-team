import { spawn } from "node:child_process";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createWatchLeaseManager } from "../src/watch/lease.js";
import {
  cleanupTempHome,
  createTempHome,
} from "./test-helpers.js";

describe("Watch Lease Manager", () => {
  test("allows only one foreground owner at a time", async () => {
    const homeDir = await createTempHome();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: "ignore",
    });

    try {
      const manager = createWatchLeaseManager(join(homeDir, ".codex-team"));
      if (!holder.pid) {
        throw new Error("Expected lease holder process to have a pid.");
      }

      const firstClaim = await manager.claimForeground({
        autoSwitch: true,
        debug: false,
        pid: holder.pid,
      });
      const secondClaim = await manager.claimForeground({
        autoSwitch: true,
        debug: false,
        pid: process.pid,
      });

      expect(firstClaim.acquired).toBe(true);
      expect(secondClaim).toMatchObject({
        acquired: false,
        state: {
          owner_kind: "tui-foreground",
          pid: holder.pid,
        },
      });

      await manager.release({
        ownerKind: "tui-foreground",
        pid: holder.pid,
      });

      await expect(manager.getStatus()).resolves.toEqual({
        active: false,
        state: null,
      });
    } finally {
      holder.kill("SIGKILL");
      await cleanupTempHome(homeDir);
    }
  });

  test("clears stale detached leases for dead pids", async () => {
    const homeDir = await createTempHome();

    try {
      const manager = createWatchLeaseManager(join(homeDir, ".codex-team"));
      await manager.recordDetached({
        pid: 999_999,
        started_at: "2026-04-17T00:00:00.000Z",
        auto_switch: true,
        debug: false,
      });

      await expect(manager.getStatus()).resolves.toEqual({
        active: false,
        state: null,
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
