import { readFile } from "node:fs/promises";

import { describe, expect, test } from "@rstest/core";

import packageJson from "../package.json";
import {
  appendEventLog,
  appendProxyErrorLog,
  appendProxyRequestLog,
  resolveEventLogPath,
  resolveProxyErrorLogPath,
  resolveProxyRequestLogPath,
} from "../src/logging.js";
import {
  cleanupTempHome,
  createTempHome,
} from "./test-helpers.js";

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("structured codexm logs", () => {
  test("records the running codexm version in structured JSONL logs", async () => {
    const homeDir = await createTempHome();
    const codexTeamDir = `${homeDir}/.codex-team`;

    try {
      await appendEventLog(codexTeamDir, {
        event: "test.event",
        component: "test",
        codexm_version: "stale",
      });
      await appendProxyRequestLog(codexTeamDir, {
        route: "/v1/responses",
        status_code: 200,
      });
      await appendProxyErrorLog(codexTeamDir, {
        route: "/v1/responses",
        status_code: 429,
      });

      const [eventLog] = await readJsonl(resolveEventLogPath(codexTeamDir));
      const [proxyRequestLog] = await readJsonl(resolveProxyRequestLogPath(codexTeamDir));
      const [proxyErrorLog] = await readJsonl(resolveProxyErrorLogPath(codexTeamDir));

      expect(eventLog?.codexm_version).toBe(packageJson.version);
      expect(proxyRequestLog?.codexm_version).toBe(packageJson.version);
      expect(proxyErrorLog?.codexm_version).toBe(packageJson.version);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
