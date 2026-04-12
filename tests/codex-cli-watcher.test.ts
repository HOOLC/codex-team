import { describe, expect, test } from "@rstest/core";
import {
  createCliProcessManager,
  type ExecFileLike,
} from "../src/codex-cli-watcher.js";
import type { CodexDirectClient } from "../src/codex-direct-client.js";

function createMockExecFile(
  responses: Record<string, { stdout: string; stderr: string }>,
): ExecFileLike {
  return async (file, args) => {
    const key = `${file} ${(args ?? []).join(" ")}`;
    const response = responses[key];
    if (response) {
      return response;
    }
    // Check partial matches
    for (const [pattern, resp] of Object.entries(responses)) {
      if (key.startsWith(pattern)) {
        return resp;
      }
    }
    throw new Error(`Mock execFile: no response for "${key}"`);
  };
}

function createMockDirectClient(
  quotaResult: unknown = null,
  accountResult: unknown = null,
): () => Promise<CodexDirectClient> {
  return async () => ({
    request: async (method: string) => {
      if (method === "account/rateLimits/read") {
        return quotaResult;
      }
      if (method === "account/read") {
        return accountResult;
      }
      return null;
    },
    close: async () => {},
  });
}

describe("createCliProcessManager", () => {
  describe("findRunningCliProcesses", () => {
    test("finds codex CLI processes", async () => {
      const execFileImpl = createMockExecFile({
        "ps -Ao pid=,command=": {
          stdout: [
            "  1234 /usr/local/bin/codex --model o4-mini",
            "  5678 /usr/bin/codex",
            "  9999 /usr/bin/node /app/server.js",
            " 11111 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223",
          ].join("\n"),
          stderr: "",
        },
      });

      const manager = createCliProcessManager({ execFileImpl });
      const processes = await manager.findRunningCliProcesses();

      expect(processes.length).toBe(2);
      expect(processes[0]!.pid).toBe(1234);
      expect(processes[1]!.pid).toBe(5678);
    });

    test("excludes Desktop processes with --remote-debugging-port", async () => {
      const execFileImpl = createMockExecFile({
        "ps -Ao pid=,command=": {
          stdout: "  1234 /usr/bin/codex --remote-debugging-port=9223\n",
          stderr: "",
        },
      });

      const manager = createCliProcessManager({ execFileImpl });
      const processes = await manager.findRunningCliProcesses();

      expect(processes.length).toBe(0);
    });

    test("returns empty array when ps fails", async () => {
      const execFileImpl: ExecFileLike = async () => {
        throw new Error("ps not found");
      };

      const manager = createCliProcessManager({ execFileImpl });
      const processes = await manager.findRunningCliProcesses();

      expect(processes.length).toBe(0);
    });

    test("returns empty array when no execFileImpl provided", async () => {
      const manager = createCliProcessManager({});
      const processes = await manager.findRunningCliProcesses();

      expect(processes.length).toBe(0);
    });
  });

  describe("readDirectQuota", () => {
    test("returns normalized quota snapshot", async () => {
      const quotaResult = {
        rateLimits: {
          planType: "plus",
          credits: { balance: "100.00", unlimited: false },
          primary: {
            usedPercent: 45,
            windowDurationMins: 300,
            resetsAt: 1700000000,
          },
          secondary: {
            usedPercent: 20,
            windowDurationMins: 10080,
            resetsAt: 1700500000,
          },
        },
      };

      const manager = createCliProcessManager({
        createDirectClientImpl: createMockDirectClient(quotaResult),
      });

      const quota = await manager.readDirectQuota();

      expect(quota).not.toBeNull();
      expect(quota!.plan_type).toBe("plus");
      expect(quota!.credits_balance).toBe(100);
      expect(quota!.five_hour).not.toBeNull();
      expect(quota!.five_hour!.used_percent).toBe(45);
      expect(quota!.one_week).not.toBeNull();
      expect(quota!.one_week!.used_percent).toBe(20);
    });

    test("returns null when client fails", async () => {
      const manager = createCliProcessManager({
        createDirectClientImpl: async () => {
          throw new Error("connection refused");
        },
      });

      const quota = await manager.readDirectQuota();
      expect(quota).toBeNull();
    });
  });

  describe("readDirectAccount", () => {
    test("returns normalized account snapshot", async () => {
      const accountResult = {
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: false,
      };

      const manager = createCliProcessManager({
        createDirectClientImpl: createMockDirectClient(null, accountResult),
      });

      const account = await manager.readDirectAccount();

      expect(account).not.toBeNull();
      expect(account!.auth_mode).toBe("chatgpt");
      expect(account!.email).toBe("user@example.com");
      expect(account!.plan_type).toBe("plus");
    });

    test("returns null when client fails", async () => {
      const manager = createCliProcessManager({
        createDirectClientImpl: async () => {
          throw new Error("connection refused");
        },
      });

      const account = await manager.readDirectAccount();
      expect(account).toBeNull();
    });
  });

  describe("watchCliQuotaSignals", () => {
    test("polls and emits quota signals on change", async () => {
      let callCount = 0;
      const quotaResults = [
        {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 30, windowDurationMins: 300 },
            secondary: { usedPercent: 10, windowDurationMins: 10080 },
          },
        },
        {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 60, windowDurationMins: 300 },
            secondary: { usedPercent: 10, windowDurationMins: 10080 },
          },
        },
      ];

      const mockCreateClient = async () => ({
        request: async () => {
          const result = quotaResults[Math.min(callCount, quotaResults.length - 1)];
          callCount++;
          return result;
        },
        close: async () => {},
      });

      const signals: unknown[] = [];
      const controller = new AbortController();

      const manager = createCliProcessManager({
        createDirectClientImpl: mockCreateClient,
        pollIntervalMs: 50,
      });

      // Run watcher briefly
      const watchPromise = manager.watchCliQuotaSignals({
        pollIntervalMs: 50,
        signal: controller.signal,
        onQuotaSignal: async (signal) => {
          signals.push(signal);
          if (signals.length >= 2) {
            controller.abort();
          }
        },
      });

      // Give it time to poll
      await new Promise((resolve) => setTimeout(resolve, 500));
      controller.abort();

      try {
        await watchPromise;
      } catch {
        // Expected — abort
      }

      expect(signals.length).toBeGreaterThanOrEqual(1);
    });

    test("handles client creation failure with reconnect", async () => {
      let attempts = 0;
      const statusEvents: unknown[] = [];
      const controller = new AbortController();

      const manager = createCliProcessManager({
        createDirectClientImpl: async () => {
          attempts++;
          if (attempts <= 2) {
            throw new Error("connection refused");
          }
          controller.abort();
          throw new Error("done");
        },
        pollIntervalMs: 50,
      });

      const watchPromise = manager.watchCliQuotaSignals({
        pollIntervalMs: 50,
        signal: controller.signal,
        onStatus: async (event) => {
          statusEvents.push(event);
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      controller.abort();

      try {
        await watchPromise;
      } catch {
        // Expected
      }

      // Should have received disconnected events
      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("restartCliProcess", () => {
    test("returns false when no CLI processes found", async () => {
      const execFileImpl = createMockExecFile({
        "ps -Ao pid=,command=": { stdout: "", stderr: "" },
      });

      const manager = createCliProcessManager({ execFileImpl });
      const result = await manager.restartCliProcess();

      expect(result).toBe(false);
    });
  });
});
