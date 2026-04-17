import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { LocalUsageService } from "../src/local-usage/service.js";
import { cleanupTempHome, createTempHome } from "./test-helpers.js";

async function writeSessionFile(options: {
  homeDir: string;
  archived?: boolean;
  relativePath: string;
  lines: string[];
}): Promise<string> {
  const root = join(
    options.homeDir,
    ".codex",
    options.archived ? "archived_sessions" : "sessions",
  );
  const filePath = join(root, options.relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${options.lines.join("\n")}\n`);
  return filePath;
}

describe("LocalUsageService", () => {
  test("aggregates fast and slow token-count paths into windows and daily buckets", async () => {
    const homeDir = await createTempHome();

    try {
      await writeSessionFile({
        homeDir,
        relativePath: "2026/04/05/today-fast.jsonl",
        lines: [
          '{"payload":{"type":"session_meta","id":"today-fast","timestamp":"2026-04-05T08:00:00Z"}}',
          '{"payload":{"type":"turn_context","model":"gpt-5.4"}}',
          '{"payload":{"type":"event_msg","kind":"token_count","total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":50}}}',
        ],
      });
      await writeSessionFile({
        homeDir,
        archived: true,
        relativePath: "recent-slow.jsonl",
        lines: [
          '{"payload":{"type":"session_meta","id":"recent-slow","timestamp":"2026-04-03T09:00:00Z"}}',
          '{"payload":{"type":"turn_context","model":"gpt-5-mini"}}',
          '{"wrapper":{"type":"event_msg"},"payload":{"type":"token_count","kind":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":40}}}}',
        ],
      });
      await writeSessionFile({
        homeDir,
        archived: true,
        relativePath: "unsupported.jsonl",
        lines: [
          '{"payload":{"type":"session_meta","id":"unsupported","timestamp":"2026-03-01T09:00:00Z"}}',
          '{"payload":{"type":"turn_context","model":"unknown-model"}}',
          '{"payload":{"type":"event_msg","kind":"token_count","total_token_usage":{"input_tokens":999,"cached_input_tokens":0,"output_tokens":999}}}',
        ],
      });

      const service = new LocalUsageService({ homeDir, timezone: "UTC" });
      const summary = await service.load({ now: new Date("2026-04-05T12:00:00Z") });

      expect(summary.timezone).toBe("UTC");
      expect(summary.windows.today).toMatchObject({
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        total_tokens: 150,
        priced_tokens: 150,
        unpriced_tokens: 0,
      });
      expect(summary.windows.today.estimated_input_cost_usd).toBeCloseTo(0.000205, 12);
      expect(summary.windows.today.estimated_output_cost_usd).toBeCloseTo(0.00075, 12);
      expect(summary.windows.today.estimated_total_cost_usd).toBeCloseTo(0.000955, 12);

      expect(summary.windows["7d"]).toMatchObject({
        input_tokens: 300,
        cached_input_tokens: 70,
        output_tokens: 90,
        total_tokens: 390,
        priced_tokens: 390,
        unpriced_tokens: 0,
      });
      expect(summary.windows["7d"].estimated_total_cost_usd).toBeCloseTo(0.00107375, 12);

      expect(summary.windows["all-time"]).toMatchObject({
        input_tokens: 1299,
        cached_input_tokens: 70,
        output_tokens: 1089,
        total_tokens: 2388,
        priced_tokens: 390,
        unpriced_tokens: 1998,
      });
      expect(summary.windows["all-time"].estimated_total_cost_usd).toBeCloseTo(0.00107375, 12);

      expect(summary.daily).toHaveLength(2);
      expect(summary.daily[0]).toMatchObject({
        date: "2026-04-05",
        total_tokens: 150,
      });
      expect(summary.daily[0].estimated_total_cost_usd).toBeCloseTo(0.000955, 12);
      expect(summary.daily[1]).toMatchObject({
        date: "2026-04-03",
        total_tokens: 240,
      });
      expect(summary.daily[1].estimated_total_cost_usd).toBeCloseTo(0.00011875, 12);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("attributes cross-day session usage to the event day instead of the session start day", async () => {
    const homeDir = await createTempHome();

    try {
      await writeSessionFile({
        homeDir,
        relativePath: "2026/04/05/cross-day.jsonl",
        lines: [
          '{"payload":{"type":"session_meta","id":"cross-day","timestamp":"2026-04-04T23:50:00Z"}}',
          '{"payload":{"type":"turn_context","model":"gpt-5.4"}}',
          '{"timestamp":"2026-04-04T23:55:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":20}}}}',
          '{"timestamp":"2026-04-05T01:10:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":170,"cached_input_tokens":30,"output_tokens":30},"last_token_usage":{"input_tokens":70,"cached_input_tokens":10,"output_tokens":10}}}}',
        ],
      });

      const service = new LocalUsageService({ homeDir, timezone: "UTC" });
      const summary = await service.load({ now: new Date("2026-04-05T12:00:00Z") });

      expect(summary.windows.today.total_tokens).toBe(80);
      expect(summary.windows["7d"].total_tokens).toBe(200);
      expect(summary.daily).toHaveLength(2);
      expect(summary.daily[0]).toMatchObject({ date: "2026-04-05", total_tokens: 80 });
      expect(summary.daily[1]).toMatchObject({ date: "2026-04-04", total_tokens: 120 });
      expect(summary.windows.today.estimated_total_cost_usd).toBeCloseTo(0.0003025, 12);
      expect(summary.windows["7d"].estimated_total_cost_usd).toBeCloseTo(0.0008075, 12);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reuses the persisted file cache and refreshes changed session files", async () => {
    const homeDir = await createTempHome();

    try {
      const relativePath = "2026/04/05/mutable.jsonl";
      const filePath = await writeSessionFile({
        homeDir,
        relativePath,
        lines: [
          '{"payload":{"type":"session_meta","id":"mutable","timestamp":"2026-04-05T08:00:00Z"}}',
          '{"payload":{"type":"turn_context","model":"gpt-5.4-mini"}}',
          '{"payload":{"type":"event_msg","kind":"token_count","total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20}}}',
        ],
      });

      const service = new LocalUsageService({ homeDir, timezone: "UTC" });
      const initialSummary = await service.load({ now: new Date("2026-04-05T12:00:00Z") });
      expect(initialSummary.windows.today.total_tokens).toBe(120);
      expect(initialSummary.windows.today.estimated_total_cost_usd).toBeCloseTo(0.00015825, 12);

      await writeSessionFile({
        homeDir,
        relativePath,
        lines: [
          '{"payload":{"type":"session_meta","id":"mutable","timestamp":"2026-04-05T08:00:00Z"}}',
          '{"payload":{"type":"turn_context","model":"gpt-5.4-mini"}}',
          '{"payload":{"type":"event_msg","kind":"token_count","total_token_usage":{"input_tokens":200,"cached_input_tokens":10,"output_tokens":50}}}',
        ],
      });

      const updatedSummary = await service.load({ now: new Date("2026-04-05T12:00:00Z") });
      expect(updatedSummary.windows.today.total_tokens).toBe(250);
      expect(updatedSummary.windows.today.estimated_total_cost_usd).toBeCloseTo(0.00036825, 12);

      const cacheStat = await stat(join(homeDir, ".codex-team", "local-usage-file-cache.json"));
      expect(cacheStat.isFile()).toBe(true);
      const fileStat = await stat(filePath);
      expect(fileStat.isFile()).toBe(true);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
