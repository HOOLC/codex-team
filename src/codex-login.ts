import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";

import type { AuthSnapshot } from "./auth-snapshot.js";

const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_LOGIN_PORT = 1455;
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export type CodexLoginMode = "browser" | "device";

export interface CodexLoginRequest {
  mode: CodexLoginMode;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface CodexLoginProvider {
  login(request: CodexLoginRequest): Promise<AuthSnapshot>;
}

interface TokenExchangeResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface DeviceUserCodeResponse {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface DeviceTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
  code_challenge?: string;
}

interface BrowserCallbackResult {
  code: string;
  state: string;
}

type BrowserCallbackWaiter = (
  state: string,
  stderr: NodeJS.WriteStream,
) => Promise<{ result: BrowserCallbackResult; redirectUri: string }>;

type BrowserOpenErrorHandler = (error: Error) => void;
type SpawnLike = typeof spawn;

interface CodexLoginProviderOptions {
  spawnImpl?: SpawnLike;
  waitForBrowserCallback?: BrowserCallbackWaiter;
}

interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

function generateBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function generatePkceCodes(): PkceCodes {
  const codeVerifier = generateBase64Url(96);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  return {
    codeVerifier,
    codeChallenge,
  };
}

function buildAuthorizeUrl(state: string, redirectUri: string, pkce: PkceCodes): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX_ORIGINATOR,
  });

  return `${CODEX_AUTH_BASE_URL}/oauth/authorize?${params.toString()}`;
}

function openBrowser(
  url: string,
  onError: BrowserOpenErrorHandler = () => undefined,
  spawnImpl: SpawnLike = spawn,
): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", onError);
  child.unref();
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new Error("ID token is not a valid JWT.");
  }

  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

function extractAccountIdFromIdToken(idToken: string): string {
  const payload = decodeJwtPayload(idToken);
  const authClaim = payload["https://api.openai.com/auth"];
  if (
    typeof authClaim === "object" &&
    authClaim !== null &&
    !Array.isArray(authClaim) &&
    typeof (authClaim as Record<string, unknown>).chatgpt_account_id === "string"
  ) {
    const accountId = (authClaim as Record<string, string>).chatgpt_account_id;
    if (accountId.trim() !== "") {
      return accountId;
    }
  }

  throw new Error("ID token is missing ChatGPT account id.");
}

function authSnapshotFromTokens(tokens: TokenExchangeResponse): AuthSnapshot {
  if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
    throw new Error("Token response is missing required fields.");
  }

  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: extractAccountIdFromIdToken(tokens.id_token),
    },
    last_refresh: new Date().toISOString(),
  };
}

async function readJsonResponse<T>(response: Response, context: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${context} failed with status ${response.status}: ${body.trim() || "empty response"}`);
  }

  return JSON.parse(body) as T;
}

async function exchangeCodeForTokens(
  fetchImpl: typeof fetch,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenExchangeResponse> {
  const response = await fetchImpl(`${CODEX_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  return readJsonResponse<TokenExchangeResponse>(response, "Codex token exchange");
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

async function waitForBrowserCallback(
  state: string,
  stderr: NodeJS.WriteStream,
): Promise<{ result: BrowserCallbackResult; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const rawUrl = request.url ?? "/";
      const url = new URL(rawUrl, `http://localhost:${CODEX_LOGIN_PORT}`);

      if (url.pathname !== "/auth/callback") {
        writeHtml(response, 404, "<h1>Not found</h1>");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        writeHtml(response, 400, "<h1>Codex login failed</h1><p>You can close this window.</p>");
        reject(new Error(`Codex login failed: ${error}`));
        server.close();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (!code || !returnedState) {
        writeHtml(response, 400, "<h1>Codex login failed</h1><p>Missing callback parameters.</p>");
        reject(new Error("Codex login callback is missing code or state."));
        server.close();
        return;
      }

      if (returnedState !== state) {
        writeHtml(response, 400, "<h1>Codex login failed</h1><p>Invalid state.</p>");
        reject(new Error("Codex login callback state mismatch."));
        server.close();
        return;
      }

      writeHtml(response, 200, "<h1>Codex login complete</h1><p>You can close this window.</p>");
      resolve({
        result: {
          code,
          state: returnedState,
        },
        redirectUri: `http://localhost:${CODEX_LOGIN_PORT}/auth/callback`,
      });
      server.close();
    });

    server.on("error", (error) => {
      reject(error);
    });

    server.listen(CODEX_LOGIN_PORT, "127.0.0.1", () => {
      stderr.write(`Waiting for Codex login callback on http://localhost:${CODEX_LOGIN_PORT}.\n`);
    });
  });
}

function parseDeviceInterval(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 5;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCodexLoginProvider(
  fetchImpl: typeof fetch = globalThis.fetch,
  options: CodexLoginProviderOptions = {},
): CodexLoginProvider {
  const spawnImpl = options.spawnImpl ?? spawn;
  const waitForBrowserCallbackImpl = options.waitForBrowserCallback ?? waitForBrowserCallback;

  return {
    async login(request: CodexLoginRequest): Promise<AuthSnapshot> {
      if (request.mode === "browser") {
        const state = generateBase64Url(32);
        const pkce = generatePkceCodes();
        const redirectUri = `http://localhost:${CODEX_LOGIN_PORT}/auth/callback`;
        const authUrl = buildAuthorizeUrl(state, redirectUri, pkce);

        request.stderr.write(`Open this URL to authenticate Codex:\n${authUrl}\n`);
        try {
          openBrowser(authUrl, (error) => {
            request.stderr.write(`Failed to open browser automatically: ${error.message}\n`);
          }, spawnImpl);
        } catch (error) {
          request.stderr.write(`Failed to open browser automatically: ${(error as Error).message}\n`);
        }

        const { result } = await waitForBrowserCallbackImpl(state, request.stderr);
        const tokens = await exchangeCodeForTokens(fetchImpl, result.code, redirectUri, pkce.codeVerifier);
        return authSnapshotFromTokens(tokens);
      }

      const userCodeResponse = await fetchImpl(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      });
      const deviceCode = await readJsonResponse<DeviceUserCodeResponse>(
        userCodeResponse,
        "Codex device code request",
      );
      const userCode = (deviceCode.user_code ?? deviceCode.usercode ?? "").trim();
      const deviceAuthId = (deviceCode.device_auth_id ?? "").trim();
      if (!userCode || !deviceAuthId) {
        throw new Error("Codex device code response is missing required fields.");
      }

      request.stderr.write(
        `Open ${CODEX_AUTH_BASE_URL}/codex/device and enter code ${userCode}.\n`,
      );

      const intervalMs = parseDeviceInterval(deviceCode.interval) * 1000;
      const deadline = Date.now() + DEVICE_LOGIN_TIMEOUT_MS;
      let tokenResponse: DeviceTokenResponse | null = null;
      while (Date.now() < deadline) {
        const response = await fetchImpl(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device_auth_id: deviceAuthId,
            user_code: userCode,
          }),
        });

        if (response.ok) {
          tokenResponse = await response.json() as DeviceTokenResponse;
          break;
        }

        if (response.status !== 403 && response.status !== 404) {
          const body = await response.text();
          throw new Error(`Codex device token polling failed with status ${response.status}: ${body.trim() || "empty response"}`);
        }

        await sleep(intervalMs);
      }

      if (!tokenResponse) {
        throw new Error("Codex device authentication timed out after 15 minutes.");
      }

      if (!tokenResponse.authorization_code || !tokenResponse.code_verifier) {
        throw new Error("Codex device token response is missing required fields.");
      }

      const tokens = await exchangeCodeForTokens(
        fetchImpl,
        tokenResponse.authorization_code,
        `${CODEX_AUTH_BASE_URL}/deviceauth/callback`,
        tokenResponse.code_verifier,
      );
      return authSnapshotFromTokens(tokens);
    },
  };
}
