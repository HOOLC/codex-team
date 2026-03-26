import { PassThrough } from "node:stream";

import { describe, expect, test } from "@rstest/core";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import packageJson from "../package.json";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store.js";
import {
  cleanupTempHome,
  createTempHome,
  jsonResponse,
  readCurrentAuth,
  textResponse,
  writeCurrentConfig,
  writeCurrentApiKeyAuth,
  writeCurrentAuth,
} from "./test-helpers.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function captureWritable(): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => output,
  };
}

function createInteractiveStdin(): NodeJS.ReadStream & {
  emitInput: (value: string) => void;
  pauseCalls: number;
  resumeCalls: number;
} {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    emitInput: (value: string) => void;
    pauseCalls: number;
    resumeCalls: number;
  };

  stream.isTTY = true;
  stream.pauseCalls = 0;
  stream.resumeCalls = 0;

  const originalPause = stream.pause.bind(stream);
  stream.pause = (() => {
    stream.pauseCalls += 1;
    return originalPause();
  }) as typeof stream.pause;

  const originalResume = stream.resume.bind(stream);
  stream.resume = (() => {
    stream.resumeCalls += 1;
    return originalResume();
  }) as typeof stream.resume;

  stream.emitInput = (value: string) => {
    stream.write(value);
  };

  return stream;
}

describe("CLI", () => {
  test("prints version from --version", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["--version"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toBe(`${packageJson.version}\n`);
    expect(stderr.read()).toBe("");
  });

  test("includes version flag in help output", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await runCli(["--help"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("codexm --version");
    expect(stderr.read()).toBe("");
  });

  test("supports save and current in json mode", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli");

      const stdout = captureWritable();
      const stderr = captureWritable();

      const saveCode = await runCli(["save", "cli-main", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(saveCode).toBe(0);
      expect(JSON.parse(stdout.read()).account.name).toBe("cli-main");

      const currentStdout = captureWritable();
      const currentCode = await runCli(["current", "--json"], {
        store,
        stdout: currentStdout.stream,
        stderr: stderr.stream,
      });

      expect(currentCode).toBe(0);
      expect(JSON.parse(currentStdout.read())).toMatchObject({
        exists: true,
        managed: true,
        matched_accounts: ["cli-main"],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports current and list for apikey auth snapshots", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentApiKeyAuth(homeDir, "sk-cli-primary");
      await writeCurrentConfig(
        homeDir,
        `model_provider = "custom"

[model_providers.custom]
base_url = "https://proxy-cli.example/v1"
wire_api = "responses"
`,
      );

      const saveCode = await runCli(["save", "cli-key", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      expect(saveCode).toBe(0);

      const currentStdout = captureWritable();
      const currentCode = await runCli(["current", "--json"], {
        store,
        stdout: currentStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(currentCode).toBe(0);
      expect(JSON.parse(currentStdout.read())).toMatchObject({
        exists: true,
        auth_mode: "apikey",
        managed: true,
        matched_accounts: ["cli-key"],
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);
      expect(JSON.parse(listStdout.read())).toMatchObject({
        successes: [
          {
            name: "cli-key",
            refresh_status: "unsupported",
            available: null,
            plan_type: null,
            credits_balance: null,
            five_hour: null,
            one_week: null,
          },
        ],
        failures: [],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports update and rejects unmanaged current auth", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "3",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-update");
      await runCli(["save", "cli-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-cli-update", "chatgpt", "pro");
      const updateStdout = captureWritable();
      const updateStderr = captureWritable();
      const updateCode = await runCli(["update", "--json"], {
        store,
        stdout: updateStdout.stream,
        stderr: updateStderr.stream,
      });

      expect(updateCode).toBe(0);
      expect(JSON.parse(updateStdout.read())).toMatchObject({
        ok: true,
        action: "update",
        account: {
          name: "cli-main",
          auth_mode: "chatgpt",
        },
        quota: {
          refresh_status: "ok",
          credits_balance: 3,
          plan_type: "plus",
          five_hour: {
            used_percent: 20,
          },
          one_week: {
            used_percent: 70,
          },
        },
      });

      await writeCurrentAuth(homeDir, "acct-unmanaged");
      const unmanagedStdout = captureWritable();
      const unmanagedStderr = captureWritable();
      const unmanagedCode = await runCli(["update", "--json"], {
        store,
        stdout: unmanagedStdout.stream,
        stderr: unmanagedStderr.stream,
      });

      expect(unmanagedCode).toBe(1);
      expect(JSON.parse(unmanagedStderr.read())).toMatchObject({
        ok: false,
        error: "Current account is not managed.",
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports interactive remove without leaving stdin active", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await writeCurrentAuth(homeDir, "acct-cli-remove");
      await runCli(["save", "remove-me", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdin = createInteractiveStdin();
      const stdout = captureWritable();
      const stderr = captureWritable();
      const removePromise = runCli(["remove", "remove-me"], {
        store,
        stdin,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      stdin.emitInput("y\n");

      const removeCode = await removePromise;
      expect(removeCode).toBe(0);
      expect(stdout.read()).toBe('Remove saved account "remove-me"? [y/N] \nRemoved account "remove-me".\n');
      expect(stderr.read()).toBe("");
      expect(stdin.resumeCalls).toBeGreaterThanOrEqual(1);
      expect(stdin.pauseCalls).toBeGreaterThanOrEqual(1);

      const accounts = await store.listAccounts();
      expect(accounts.accounts).toHaveLength(0);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports list as quota refresh in json mode", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 15,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota");
      await runCli(["save", "quota-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list", "--json"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });
      expect(listCode).toBe(0);
      expect(JSON.parse(listStdout.read())).toMatchObject({
        successes: [
          {
            name: "quota-main",
            available: "available",
            credits_balance: 11,
            refresh_status: "ok",
            five_hour: {
              used_percent: 15,
            },
            one_week: {
              used_percent: 45,
            },
          },
        ],
        failures: [],
      });

      const removedStdout = captureWritable();
      const removedStderr = captureWritable();
      const removedCode = await runCli(["quota", "refresh", "--json"], {
        store,
        stdout: removedStdout.stream,
        stderr: removedStderr.stream,
      });
      expect(removedCode).toBe(1);
      expect(JSON.parse(removedStderr.read())).toMatchObject({
        ok: false,
        error: 'Unknown command "quota".',
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("formats list output with local reset times and hides credits in text mode", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 15,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 400,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 4_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "11",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-cli-quota-text");
      await runCli(["save", "quota-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await runCli(["list", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const listStdout = captureWritable();
      const listCode = await runCli(["list"], {
        store,
        stdout: listStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(listCode).toBe(0);

      const output = listStdout.read();
      expect(output).not.toContain("CREDITS");
      expect(output).toContain("AVAILABLE");
      expect(output).toContain("available");
      expect(output).toContain(
        dayjs.utc("2026-03-18T21:17:21.000Z").tz(dayjs.tz.guess()).format("MM-DD HH:mm"),
      );
      expect(output).toContain(
        dayjs.utc("2026-03-19T03:14:00.000Z").tz(dayjs.tz.guess()).format("MM-DD HH:mm"),
      );
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refreshes quota automatically after switch", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/backend-api/wham/usage")) {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 9,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 300,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 66,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 3_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "8",
              },
            });
          }

          return textResponse("not found", 404);
        },
      });
      await writeCurrentAuth(homeDir, "acct-switch-a");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-switch-b");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const switchStdout = captureWritable();
      const switchCode = await runCli(["switch", "alpha", "--json"], {
        store,
        stdout: switchStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(switchCode).toBe(0);
      expect(JSON.parse(switchStdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        account: {
          name: "alpha",
        },
        quota: {
          available: "available",
          refresh_status: "ok",
          credits_balance: 8,
          five_hour: {
            used_percent: 9,
          },
          one_week: {
            used_percent: 66,
          },
        },
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("marks availability from 5h and 1w usage thresholds", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-threshold-a") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 91,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 45,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "5",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 15,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 100,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-threshold-a");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-threshold-b");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const stdout = captureWritable();
      const code = await runCli(["list", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        successes: [
          {
            name: "alpha",
            available: "almost unavailable",
          },
          {
            name: "beta",
            available: "unavailable",
          },
        ],
        failures: [],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("supports auto switch and dry-run selection", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-auto-alpha") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 60,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_868_641,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_890_040,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "3",
              },
            });
          }

          if (accountId === "acct-auto-beta") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 50,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_860_000,
                },
                secondary_window: {
                  used_percent: 80,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_880_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 100,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 10,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-auto-alpha");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-beta");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-auto-gamma");
      await runCli(["save", "gamma", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      const dryRunStdout = captureWritable();
      const dryRunCode = await runCli(["switch", "--auto", "--dry-run", "--json"], {
        store,
        stdout: dryRunStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(dryRunCode).toBe(0);
      expect(JSON.parse(dryRunStdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        dry_run: true,
        selected: {
          name: "beta",
          available: "available",
          effective_score: 50,
          remain_5h: 50,
          remain_1w_eq_5h: 60,
        },
      });

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-gamma");

      const switchStdout = captureWritable();
      const switchCode = await runCli(["switch", "--auto", "--json"], {
        store,
        stdout: switchStdout.stream,
        stderr: captureWritable().stream,
      });

      expect(switchCode).toBe(0);
      expect(JSON.parse(switchStdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        account: {
          name: "beta",
          account_id: "acct-auto-beta",
        },
        selected: {
          name: "beta",
          effective_score: 50,
        },
        quota: {
          available: "available",
          refresh_status: "ok",
          five_hour: {
            used_percent: 50,
          },
          one_week: {
            used_percent: 80,
          },
        },
      });

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-auto-beta");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("skips auto switch when current account is already the best available account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/backend-api/wham/usage")) {
            return textResponse("not found", 404);
          }

          const headers = new Headers(init?.headers);
          const accountId = headers.get("ChatGPT-Account-Id");

          if (accountId === "acct-best-current") {
            return jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 500,
                  reset_at: 1_773_860_000,
                },
                secondary_window: {
                  used_percent: 20,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 6_000,
                  reset_at: 1_773_880_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9",
              },
            });
          }

          return jsonResponse({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 40,
                limit_window_seconds: 18_000,
                reset_after_seconds: 500,
                reset_at: 1_773_868_641,
              },
              secondary_window: {
                used_percent: 70,
                limit_window_seconds: 604_800,
                reset_after_seconds: 6_000,
                reset_at: 1_773_890_040,
              },
            },
            credits: {
              has_credits: true,
              unlimited: false,
              balance: "1",
            },
          });
        },
      });

      await writeCurrentAuth(homeDir, "acct-best-current");
      await runCli(["save", "alpha", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-other");
      await runCli(["save", "beta", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });

      await writeCurrentAuth(homeDir, "acct-best-current");

      const stdout = captureWritable();
      const code = await runCli(["switch", "--auto", "--json"], {
        store,
        stdout: stdout.stream,
        stderr: captureWritable().stream,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.read())).toMatchObject({
        ok: true,
        action: "switch",
        mode: "auto",
        skipped: true,
        reason: "already_current_best",
        account: {
          name: "alpha",
          account_id: "acct-best-current",
        },
        selected: {
          name: "alpha",
          available: "available",
        },
      });

      expect((await readCurrentAuth(homeDir)).tokens?.account_id).toBe("acct-best-current");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
