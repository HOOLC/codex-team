import { PassThrough } from "node:stream";

import { describe, expect, test } from "@rstest/core";

import { createCodexLoginProvider } from "../src/codex-login.js";
import { createAuthPayload, jsonResponse } from "./test-helpers.js";

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

describe("Codex login provider", () => {
  test("completes device login using Codex device endpoints", async () => {
    const auth = createAuthPayload("acct-device-provider", "chatgpt_auth_tokens", "plus", "user-device-provider");
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      requests.push({ url, body });

      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-EFGH",
          interval: "1",
        });
      }

      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return jsonResponse({
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
          code_challenge: "code-challenge",
        });
      }

      if (url.endsWith("/oauth/token")) {
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
        expect(body).toContain("code=authorization-code");
        expect(body).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
        expect(body).toContain("code_verifier=code-verifier");
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };
    const stdout = captureWritable();
    const stderr = captureWritable();

    const snapshot = await createCodexLoginProvider(fetchMock).login({
      mode: "device",
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(snapshot).toMatchObject({
      auth_mode: "chatgpt_auth_tokens",
      tokens: {
        account_id: "acct-device-provider",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("ABCD-EFGH");
  });
});
