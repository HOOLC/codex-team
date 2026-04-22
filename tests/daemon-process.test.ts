import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import {
  cleanupStaleDaemonPortConflict,
  createDaemonProcessManager,
  type StaleDaemonPortConflict,
  StaleDaemonProcessError,
} from "../src/daemon/process.js";
import { cleanupTempHome, createTempHome } from "./test-helpers.js";

describe("daemon-process", () => {
  test("refuses to start proxy mode when a stale codexm proxy listener already owns the port", async () => {
    const homeDir = await createTempHome();
    const codexTeamDir = join(homeDir, ".codex-team");
    let spawnCalled = false;

    try {
      const manager = createDaemonProcessManager(codexTeamDir, {
        execFileImpl: async (file, args = []) => {
          if (file === "lsof") {
            expect(args).toContain("-iTCP:14555");
            return {
              stdout: "p8846\n",
              stderr: "",
            };
          }

          if (
            file === "ps"
            && args[0] === "-o"
            && args[1] === "command="
            && args[2] === "-p"
            && args[3] === "8846"
          ) {
            return {
              stdout: "node /opt/homebrew/bin/codexm proxy serve --host 127.0.0.1 --port 14555\n",
              stderr: "",
            };
          }

          throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
        },
        spawnImpl: ((..._args: unknown[]) => {
          spawnCalled = true;
          throw new Error("spawn should not be called for stale daemon conflicts");
        }) as never,
      });

      const startPromise = manager.ensureConfig({
        stayalive: true,
        watch: false,
        auto_switch: false,
        proxy: true,
        host: "127.0.0.1",
        port: 14555,
        debug: false,
        base_url: "http://127.0.0.1:14555/backend-api",
        openai_base_url: "http://127.0.0.1:14555/v1",
      });

      await expect(startPromise).rejects.toEqual(expect.objectContaining({
        name: "StaleDaemonProcessError",
      }));
      await expect(startPromise).rejects.toBeInstanceOf(StaleDaemonProcessError);
      expect(spawnCalled).toBe(false);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("cleanupStaleDaemonPortConflict terminates the stale pid", async () => {
    const conflict: StaleDaemonPortConflict = {
      host: "127.0.0.1",
      port: 14555,
      pid: 8846,
      command: "node /opt/homebrew/bin/codexm proxy serve --host 127.0.0.1 --port 14555",
      kind: "proxy",
    };
    let alive = true;
    const killCalls: string[][] = [];

    await cleanupStaleDaemonPortConflict(conflict, async (file, args = []) => {
      if (file === "ps") {
        return {
          stdout: alive ? "8846\n" : "",
          stderr: "",
        };
      }

      if (file === "kill") {
        killCalls.push([...args]);
        if (args[0] === "-TERM" && args[1] === "8846") {
          alive = false;
        }
        return {
          stdout: "",
          stderr: "",
        };
      }

      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    expect(killCalls).toEqual([["-TERM", "8846"]]);
  });
});
