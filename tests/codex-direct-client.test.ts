import { PassThrough } from "node:stream";

import { describe, expect, test } from "@rstest/core";

import {
  createCodexDirectClient,
  type CodexDirectClientProcess,
} from "../src/codex-direct-client.js";

function createFakeDirectClientProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;

  const processLike: CodexDirectClientProcess = {
    stdin,
    stdout,
    stderr,
    pid: 123,
    killed: false,
    exitCode: null,
    kill() {
      killed = true;
      processLike.killed = true;
      return true;
    },
    on(event, handler) {
      if (event === "error") {
        stderr.on("error", handler as (error: Error) => void);
      }
      if (event === "close") {
        stdout.on("close", handler as (code: number | null, signal: NodeJS.Signals | null) => void);
      }
      return processLike;
    },
    once(event, handler) {
      if (event === "error") {
        stderr.once("error", handler as (error: Error) => void);
      }
      if (event === "close") {
        stdout.once("close", handler as (code: number | null, signal: NodeJS.Signals | null) => void);
      }
      return processLike;
    },
  };

  return {
    processLike,
    stdin,
    stdout,
    stderr,
    wasKilled() {
      return killed;
    },
    close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      processLike.exitCode = code;
      stdout.emit("close", code, signal);
    },
  };
}

describe("codex-direct-client", () => {
  test("initializes the app server and reads account info over stdio", async () => {
    const launched = createFakeDirectClientProcess();
    const sentPayloads: string[] = [];
    launched.stdin.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim();
      if (!line) {
        return;
      }

      sentPayloads.push(line);
      const payload = JSON.parse(line) as { id?: string; method?: string };
      if (payload.method === "initialize" && payload.id) {
        launched.stdout.write(
          `${JSON.stringify({
            id: payload.id,
            result: {
              codexHome: "/tmp/.codex",
            },
          })}\n`,
        );
        return;
      }

      if (payload.method === "account/read" && payload.id) {
        launched.stdout.write(
          `${JSON.stringify({
            id: payload.id,
            result: {
              account: {
                type: "chatgpt",
                email: "user@example.com",
                planType: "plus",
              },
              requiresOpenaiAuth: true,
            },
          })}\n`,
        );
      }
    });

    const client = await createCodexDirectClient({
      launchProcessImpl: () => launched.processLike,
    });

    try {
      await expect(client.request("account/read", { refreshToken: false })).resolves.toEqual({
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      });
      expect(sentPayloads[0]).toContain('"method":"initialize"');
      expect(sentPayloads.some((payload) => payload.includes('"method":"initialized"'))).toBe(true);
      expect(sentPayloads.some((payload) => payload.includes('"method":"account/read"'))).toBe(true);
    } finally {
      await client.close();
      launched.close(0, null);
    }
  });

  test("surfaces launch failures with stderr context", async () => {
    const launched = createFakeDirectClientProcess();

    const clientPromise = createCodexDirectClient({
      launchProcessImpl: () => {
        queueMicrotask(() => {
          launched.stderr.write("failed to boot");
          launched.close(1, null);
        });
        return launched.processLike;
      },
      requestTimeoutMs: 50,
    });

    await expect(clientPromise).rejects.toThrow("failed to boot");
  });

  test("closes the spawned process", async () => {
    const launched = createFakeDirectClientProcess();
    launched.stdin.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim();
      if (!line) {
        return;
      }

      const payload = JSON.parse(line) as { id?: string; method?: string };
      if (payload.method === "initialize" && payload.id) {
        launched.stdout.write(`${JSON.stringify({ id: payload.id, result: {} })}\n`);
      }
    });

    const client = await createCodexDirectClient({
      launchProcessImpl: () => launched.processLike,
    });

    await client.close();
    expect(launched.wasKilled()).toBe(true);
  });
});
