import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { runCli } from "../src/main.js";
import { createAccountStore } from "../src/account-store/index.js";
import { captureWritable } from "./cli-fixtures.js";
import { cleanupTempHome, createTempHome, writeCurrentAuth } from "./test-helpers.js";

async function writeUsageSession(options: {
  homeDir: string;
  relativePath: string;
  lines: string[];
  archived?: boolean;
}): Promise<void> {
  const directory = join(
    options.homeDir,
    ".codex",
    options.archived ? "archived_sessions" : "sessions",
  );
  const filePath = join(directory, options.relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${options.lines.join("\n")}\n`);
}

function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

function relativeSessionPath(timestamp: string, fileName: string): string {
  const date = new Date(timestamp);
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    fileName,
  ].join("/");
}

describe("CLI Usage Commands", () => {
  test("usage --json prints window summaries and daily buckets", async () => {
    const homeDir = await createTempHome();

    try {
      const todayTimestamp = isoDaysAgo(0);
      const recentTimestamp = isoDaysAgo(2);
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      await writeUsageSession({
        homeDir,
        relativePath: relativeSessionPath(todayTimestamp, "today-fast.jsonl"),
        lines: [
          `{"payload":{"type":"session_meta","id":"today-fast","timestamp":"${todayTimestamp}"}}`,
          '{"payload":{"type":"turn_context","model":"gpt-5.4"}}',
          '{"payload":{"type":"event_msg","kind":"token_count","total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":50}}}',
        ],
      });
      await writeUsageSession({
        homeDir,
        archived: true,
        relativePath: relativeSessionPath(recentTimestamp, "recent-slow.jsonl"),
        lines: [
          `{"payload":{"type":"session_meta","id":"recent-slow","timestamp":"${recentTimestamp}"}}`,
          '{"payload":{"type":"turn_context","model":"gpt-5-mini"}}',
          '{"wrapper":{"type":"event_msg"},"payload":{"type":"token_count","kind":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":40}}}}',
        ],
      });

      const exitCode = await runCli(["usage", "--json", "--daily"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stderr.read()).toBe("");
      expect(JSON.parse(stdout.read())).toMatchObject({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        windows: {
          today: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 50,
            total_tokens: 150,
          },
          "7d": {
            input_tokens: 300,
            cached_input_tokens: 70,
            output_tokens: 90,
            total_tokens: 390,
          },
        },
        daily: [
          {
            total_tokens: 150,
          },
          {
            total_tokens: 240,
          },
        ],
      });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("usage --window today prints only the selected window", async () => {
    const homeDir = await createTempHome();

    try {
      const todayTimestamp = isoDaysAgo(0);
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      await writeUsageSession({
        homeDir,
        relativePath: relativeSessionPath(todayTimestamp, "today-fast.jsonl"),
        lines: [
          `{"payload":{"type":"session_meta","id":"today-fast","timestamp":"${todayTimestamp}"}}`,
          '{"payload":{"type":"turn_context","model":"gpt-5.4"}}',
          '{"payload":{"type":"event_msg","kind":"token_count","total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":50}}}',
        ],
      });

      const exitCode = await runCli(["usage", "--window", "today"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      const output = stdout.read();
      expect(output).toContain("Usage today:");
      expect(output).not.toContain("Usage 7d:");
      expect(output).toContain("in 100/");
      expect(output).toContain("out 50/");
      expect(output).toContain("total 150/");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("list embeds a usage summary line and respects --usage-window", async () => {
    const homeDir = await createTempHome();

    try {
      const todayTimestamp = isoDaysAgo(0);
      const store = createAccountStore(homeDir);
      const stdout = captureWritable();
      const stderr = captureWritable();

      await writeCurrentAuth(homeDir, "acct-list-usage", "chatgpt", "plus", "user-list-usage");
      await runCli(["save", "list-usage-main", "--json"], {
        store,
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
      await writeUsageSession({
        homeDir,
        relativePath: relativeSessionPath(todayTimestamp, "list-fast.jsonl"),
        lines: [
          `{"payload":{"type":"session_meta","id":"list-fast","timestamp":"${todayTimestamp}"}}`,
          '{"payload":{"type":"turn_context","model":"gpt-5.4"}}',
          '{"payload":{"type":"event_msg","kind":"token_count","total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":50}}}',
        ],
      });

      const exitCode = await runCli(["list", "--usage-window", "today"], {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      const output = stdout.read();
      expect(exitCode).toBeGreaterThanOrEqual(0);
      expect(output).toContain("Usage today:");
      expect(output).not.toContain("Usage 7d:");
      expect(stderr.read()).toBe("");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
