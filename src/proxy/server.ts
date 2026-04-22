import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { AccountStore, ManagedAccount } from "../account-store/index.js";
import {
  readAuthSnapshotFile,
  type AuthSnapshot,
} from "../auth-snapshot.js";
import { rankAutoSwitchCandidates } from "../cli/quota.js";
import { readDaemonState } from "../daemon/state.js";
import { normalizeDisplayedScore } from "../plan-quota-profile.js";
import { extractChatGPTAuth } from "../quota-client.js";
import {
  CHATGPT_UPSTREAM_BASE_URL,
  DEFAULT_PROXY_HOST,
  OPENAI_UPSTREAM_BASE_URL,
} from "./constants.js";
import {
  persistProxyUpstreamAccountSelection,
  resolveProxyManualUpstreamAccountName,
} from "./runtime.js";
import { isSyntheticProxyBearerToken } from "./synthetic-auth.js";
import {
  buildProxyAccountCheckV4Payload,
  buildProxyAutoTopUpSettingsPayload,
  buildProxyUsagePayloadForStore,
  buildProxyWhamAccountsCheckPayloadForStore,
} from "./quota.js";
import {
  hasExhaustedRateLimitSignal,
  hasQuotaExhaustionSignal,
} from "../quota-exhaustion-signals.js";

interface ProxyUpstreamAccount {
  account: ManagedAccount;
  snapshot: AuthSnapshot;
  displayedScore: number | null;
  forceFastServiceTier: boolean;
}

export interface StartedProxyServer {
  baseUrl: string;
  backendBaseUrl: string;
  openaiBaseUrl: string;
  close(): Promise<void>;
}

export interface StartProxyServerOptions {
  store: AccountStore;
  host?: string;
  port?: number;
  fetchImpl?: typeof fetch;
  debugLog?: (message: string) => void;
  requestLogger?: (payload: Record<string, unknown>) => Promise<void> | void;
  errorRequestLogger?: (payload: Record<string, unknown>) => Promise<void> | void;
  connectWebSocketImpl?: (options: {
    url: string;
    headers: OutgoingHttpHeaders;
  }) => Promise<WebSocket>;
}

interface ProxyForwardResult {
  statusCode: number;
  responseBytes: number;
  authKind: string;
  selectedAccount: string | null;
  selectedAuthMode: string | null;
  upstreamKind: "chatgpt" | "openai";
  requestSpeed?: ProxyRequestSpeed;
  syntheticUsage?: boolean;
  diagnostic?: Record<string, unknown>;
  errorPayload?: Record<string, unknown>;
}

interface ProxyStoredConversation {
  accountName: string;
  conversationItems: unknown[];
}

interface ProxyActiveTurn {
  accountName: string;
  bufferedMessages: string[];
  fullInput: unknown[];
  outputItems: unknown[];
  replayCount: number;
  replayLocked: boolean;
  replayedFromAccountNames: string[];
  requestBody: Record<string, unknown>;
  requestId: string;
  requestSpeed: ProxyRequestSpeed;
  responseId: string | null;
  startedAt: number;
}

interface ProxyWebSocketContext {
  activeTurn: ProxyActiveTurn | null;
  connectionRequestId: string;
  downstreamAuthKind: string;
  historyByResponseId: Map<string, ProxyStoredConversation>;
  upstreamAccount: ProxyUpstreamAccount | null;
  upstreamSocket: WebSocket | null;
}

type ProxyRequestSpeed = "normal" | "fast";

const DEFAULT_CODEX_INSTRUCTIONS = "You are Codex.";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizePathname(pathname: string): string {
  return pathname
    .replace(/\/{2,}/gu, "/")
    .replace(/^(?:\/backend-api){2,}(?=\/|$)/u, "/backend-api");
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function requestHeadersToFetchHeaders(
  request: IncomingMessage,
  overrides: Record<string, string | null> = {},
): Headers {
  const headers = new Headers();
  for (const [key, rawValue] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || lowerKey === "content-length" || lowerKey === "connection") {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        headers.append(key, value);
      }
    } else if (typeof rawValue === "string") {
      headers.set(key, rawValue);
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      headers.delete(key);
    } else {
      headers.set(key, value);
    }
  }

  return headers;
}

function requestHeadersToWebSocketHeaders(
  request: IncomingMessage,
  overrides: Record<string, string | null> = {},
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};

  for (const [key, rawValue] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host"
      || lowerKey === "connection"
      || lowerKey === "upgrade"
      || lowerKey === "content-length"
      || lowerKey.startsWith("sec-websocket-")
    ) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      headers[key] = rawValue.join(", ");
    } else if (typeof rawValue === "string") {
      headers[key] = rawValue;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete headers[key];
    } else {
      headers[key] = value;
    }
  }

  return headers;
}

function incomingHeadersToRecord(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, rawValue] of Object.entries(request.headers)) {
    if (Array.isArray(rawValue)) {
      headers[key] = [...rawValue];
    } else if (typeof rawValue === "string") {
      headers[key] = rawValue;
    }
  }
  return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function upstreamResponseHeadersToRecord(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  return headers;
}

function shouldCaptureDiagnosticPayload(pathname: string): boolean {
  return pathname === "/backend-api/wham/usage"
    || pathname === "/backend-api/wham/accounts/check"
    || pathname === "/backend-api/subscriptions/auto_top_up/settings"
    || /^\/backend-api\/accounts\/check\/.+/u.test(pathname);
}

function isCodexDesktopRequest(request: IncomingMessage): boolean {
  const rawUserAgent = request.headers["user-agent"] as string | string[] | undefined;
  const userAgent = Array.isArray(rawUserAgent)
    ? rawUserAgent.join(" ")
    : rawUserAgent ?? "";
  return /Codex Desktop\//u.test(userAgent);
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shouldUseSyntheticDesktopUsageSurface(request: IncomingMessage): boolean {
  const authorization = typeof request.headers.authorization === "string"
    ? request.headers.authorization
    : null;
  return authorization === null
    || isSyntheticProxyBearerToken(authorization)
    || isCodexDesktopRequest(request);
}

function buildJsonBodyText(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function buildProxyErrorResponsePayload(message: string): Record<string, unknown> {
  return {
    error: {
      message,
      type: "codexm_proxy_error",
    },
  };
}

function buildProxyErrorResponseText(message: string): string {
  return buildJsonBodyText(buildProxyErrorResponsePayload(message));
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): number {
  const body = buildJsonBodyText(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(body);
  return Buffer.byteLength(body);
}

function writeError(response: ServerResponse, statusCode: number, message: string): number {
  return writeJson(response, statusCode, buildProxyErrorResponsePayload(message));
}

async function writeUpstreamResponse(response: ServerResponse, upstream: Response): Promise<number> {
  const headers = upstreamResponseHeadersToRecord(upstream);
  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return 0;
  }
  const reader = upstream.body.getReader();
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        response.end();
        return totalBytes;
      }
      totalBytes += value.byteLength;
      response.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeBufferedUpstreamResponse(response: ServerResponse, upstream: Response): Promise<{
  responseBytes: number;
  responseHeaders: Record<string, string>;
  responseBodyText: string;
}> {
  const responseHeaders = upstreamResponseHeadersToRecord(upstream);
  const responseBodyText = await upstream.text();
  response.writeHead(upstream.status, responseHeaders);
  response.end(responseBodyText);
  return {
    responseBytes: Buffer.byteLength(responseBodyText),
    responseHeaders,
    responseBodyText,
  };
}

function writeBufferedResponse(
  response: ServerResponse,
  statusCode: number,
  headers: Record<string, string>,
  bodyText: string,
): number {
  response.writeHead(statusCode, headers);
  response.end(bodyText);
  return Buffer.byteLength(bodyText);
}

function upstreamRequestHeadersToRecord(
  headers: Headers | Record<string, string> | null,
): Record<string, string> | null {
  if (!headers) {
    return null;
  }

  if (headers instanceof Headers) {
    return headersToRecord(headers);
  }

  return { ...headers };
}

function shouldRecordErrorPayload(statusCode: number): boolean {
  return statusCode !== 200;
}

function buildRequestResponseLogPayload(options: {
  request: IncomingMessage;
  bodyText: string;
  upstreamUrl: string | null;
  upstreamRequestHeaders: Headers | Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  responseBodyText: string;
}): Record<string, unknown> {
  return {
    request_headers: incomingHeadersToRecord(options.request),
    request_body_text: options.bodyText,
    upstream_url: options.upstreamUrl,
    upstream_request_headers: upstreamRequestHeadersToRecord(options.upstreamRequestHeaders),
    response_headers: options.responseHeaders,
    response_body_text: options.responseBodyText,
  };
}

function buildLocalErrorLogPayload(options: {
  request: IncomingMessage;
  bodyText: string;
  responseBodyText: string;
  responseHeaders?: Record<string, string> | null;
}): Record<string, unknown> {
  return buildRequestResponseLogPayload({
    request: options.request,
    bodyText: options.bodyText,
    upstreamUrl: null,
    upstreamRequestHeaders: null,
    responseHeaders: options.responseHeaders ?? {
      "content-type": "application/json",
    },
    responseBodyText: options.responseBodyText,
  });
}

async function writeUpstreamResponseWithLogging(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  upstream: Response;
  upstreamUrl: string;
  upstreamRequestHeaders: Headers | Record<string, string>;
  captureDiagnostic?: boolean;
}): Promise<{
  responseBytes: number;
  diagnostic?: Record<string, unknown>;
  errorPayload?: Record<string, unknown>;
}> {
  const captureDiagnostic = options.captureDiagnostic === true;
  const captureError = shouldRecordErrorPayload(options.upstream.status);
  if (!captureDiagnostic && !captureError) {
    return {
      responseBytes: await writeUpstreamResponse(options.response, options.upstream),
    };
  }

  const buffered = await writeBufferedUpstreamResponse(options.response, options.upstream);
  const payload = buildRequestResponseLogPayload({
    request: options.request,
    bodyText: options.bodyText,
    upstreamUrl: options.upstreamUrl,
    upstreamRequestHeaders: options.upstreamRequestHeaders,
    responseHeaders: buffered.responseHeaders,
    responseBodyText: buffered.responseBodyText,
  });

  return {
    responseBytes: buffered.responseBytes,
    diagnostic: captureDiagnostic ? payload : undefined,
    errorPayload: captureError ? payload : undefined,
  };
}

function parseJsonBody(bodyText: string): Record<string, unknown> {
  if (bodyText.trim() === "") {
    return {};
  }

  const parsed = JSON.parse(bodyText) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON request body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function parseMaybeJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isApiKeyAccount(account: ManagedAccount): boolean {
  return account.auth_mode === "apikey";
}

function isChatGPTAccount(account: ManagedAccount): boolean {
  return account.auth_mode === "chatgpt";
}

async function toProxyUpstreamAccount(
  account: ManagedAccount,
  selectedCandidate: {
    current_score: number;
    plan_type: string | null;
    available: string | null;
  } | null,
): Promise<ProxyUpstreamAccount> {
  const displayedScore = selectedCandidate
    ? normalizeDisplayedScore(selectedCandidate.current_score, selectedCandidate.plan_type, { clamp: false })
    : null;
  return {
    account,
    snapshot: await readAuthSnapshotFile(account.authPath),
    displayedScore,
    forceFastServiceTier: selectedCandidate?.available === "unavailable",
  };
}

interface SelectProxyAccountOptions {
  excludeAccountNames?: Iterable<string>;
  ignoreManualSelection?: boolean;
  requireAutoSwitch?: boolean;
}

async function selectProxyAccount(
  store: AccountStore,
  preference: "chatgpt" | "apikey" | "any",
  options: SelectProxyAccountOptions = {},
): Promise<ProxyUpstreamAccount | null> {
  const [{ accounts }, quotaList, daemonState] = await Promise.all([
    store.listAccounts(),
    store.listQuotaSummaries(),
    readDaemonState(store.paths.codexTeamDir),
  ]);
  const eligibleAccounts = accounts.filter((account) => account.auto_switch_eligible !== false);
  const excludedNames = new Set(options.excludeAccountNames ?? []);
  const accountByName = new Map(eligibleAccounts.map((account) => [account.name, account] as const));
  const quotaByName = new Map(
    quotaList.accounts
      .filter((account) => account.auto_switch_eligible !== false)
      .map((account) => [account.name, account] as const),
  );

  const typeMatches = (account: ManagedAccount) => {
    if (preference === "chatgpt") {
      return isChatGPTAccount(account);
    }
    if (preference === "apikey") {
      return isApiKeyAccount(account);
    }
    return true;
  };

  const matchingFallbackNames = eligibleAccounts
    .filter(typeMatches)
    .filter((account) => !excludedNames.has(account.name))
    .map((account) => account.name);
  const manualAccountName = options.ignoreManualSelection
    ? null
    : await resolveProxyManualUpstreamAccountName(store, eligibleAccounts);
  if (manualAccountName && matchingFallbackNames.includes(manualAccountName)) {
    const selectedAccount = accountByName.get(manualAccountName) ?? null;
    if (!selectedAccount) {
      return null;
    }

    const selectedQuota = quotaByName.get(manualAccountName) ?? null;
    const selectedCandidate = selectedQuota
      ? rankAutoSwitchCandidates([selectedQuota]).find((candidate) => candidate.name === manualAccountName) ?? null
      : null;
    return await toProxyUpstreamAccount(selectedAccount, selectedCandidate);
  }

  const autoswitchEnabled = daemonState?.auto_switch === true;
  if (options.requireAutoSwitch && !autoswitchEnabled) {
    return null;
  }
  if (!autoswitchEnabled) {
    const selectedName = matchingFallbackNames[0] ?? null;
    const selectedAccount = selectedName ? accountByName.get(selectedName) ?? null : null;
    if (!selectedAccount) {
      return null;
    }

    const selectedQuota = selectedName ? quotaByName.get(selectedName) ?? null : null;
    const selectedCandidate = selectedQuota
      ? rankAutoSwitchCandidates([selectedQuota]).find((candidate) => candidate.name === selectedName) ?? null
      : null;
    return await toProxyUpstreamAccount(selectedAccount, selectedCandidate);
  }

  const rankedCandidates = rankAutoSwitchCandidates([...quotaByName.values()])
    .filter((candidate) => {
      const account = accountByName.get(candidate.name);
      return account ? typeMatches(account) && !excludedNames.has(candidate.name) : false;
    });
  const rankedCandidateByName = new Map(rankedCandidates.map((candidate) => [candidate.name, candidate] as const));
  const selectedName = [...rankedCandidates.map((candidate) => candidate.name), ...matchingFallbackNames][0];
  const selectedAccount = selectedName ? accountByName.get(selectedName) ?? null : null;
  if (!selectedAccount) {
    return null;
  }

  const selectedCandidate = selectedName ? rankedCandidateByName.get(selectedName) ?? null : null;
  return await toProxyUpstreamAccount(selectedAccount, selectedCandidate);
}

async function selectProxyReplayAccount(
  store: AccountStore,
  preference: "chatgpt" | "apikey" | "any",
  attemptedAccountNames: Iterable<string>,
): Promise<ProxyUpstreamAccount | null> {
  return await selectProxyAccount(store, preference, {
    excludeAccountNames: attemptedAccountNames,
    ignoreManualSelection: true,
    requireAutoSwitch: true,
  });
}

function upstreamChatGPTUrl(pathname: string, search: string): string {
  return `${CHATGPT_UPSTREAM_BASE_URL}${pathname}${search}`;
}

function toChatGPTCodexUrl(pathname: string, search: string): string {
  const suffix = pathname.replace(/^\/v1/u, "");
  return `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex${suffix}${search}`;
}

async function readOpenAIBaseUrl(account: ManagedAccount): Promise<string> {
  if (!account.configPath) {
    return OPENAI_UPSTREAM_BASE_URL;
  }

  try {
    const config = await readFile(account.configPath, "utf8");
    for (const line of config.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("base_url") && !trimmed.startsWith("openai_base_url")) {
        continue;
      }
      const [, rawValue] = trimmed.split("=", 2);
      const value = rawValue?.trim().replace(/^['"]|['"]$/gu, "");
      if (value) {
        return stripTrailingSlash(value);
      }
    }
  } catch {
    return OPENAI_UPSTREAM_BASE_URL;
  }

  return OPENAI_UPSTREAM_BASE_URL;
}

function toOpenAIUrl(baseUrl: string, pathname: string, search: string): string {
  const suffix = pathname.replace(/^\/v1/u, "");
  return `${stripTrailingSlash(baseUrl)}${suffix}${search}`;
}

function fetchInitForRequest(
  request: IncomingMessage,
  headers: Headers,
  bodyText: string,
): RequestInit {
  const method = request.method ?? "GET";
  return {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: bodyText }),
  };
}

function buildChatGPTAuthHeaders(request: IncomingMessage, selected: ProxyUpstreamAccount | null): Headers {
  if (!selected) {
    return requestHeadersToFetchHeaders(request);
  }

  const auth = extractChatGPTAuth(selected.snapshot);
  return requestHeadersToFetchHeaders(request, {
    authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
  });
}

function buildApiKeyHeaders(request: IncomingMessage, selected: ProxyUpstreamAccount): Headers {
  const apiKey = selected.snapshot.OPENAI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(`API key account "${selected.account.name}" is missing OPENAI_API_KEY.`);
  }

  return requestHeadersToFetchHeaders(request, {
    authorization: `Bearer ${apiKey}`,
  });
}

function buildChatGPTWebSocketHeaders(
  request: IncomingMessage,
  selected: ProxyUpstreamAccount,
): OutgoingHttpHeaders {
  const auth = extractChatGPTAuth(selected.snapshot);
  return requestHeadersToWebSocketHeaders(request, {
    authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
  });
}

function maybeInjectFastServiceTier<T extends Record<string, unknown>>(
  body: T,
  selected: ProxyUpstreamAccount | null,
): T {
  if (!selected?.forceFastServiceTier || body.service_tier !== undefined) {
    return body;
  }

  return {
    ...body,
    service_tier: "priority",
  };
}

function resolveProxyRequestSpeed(body: Record<string, unknown> | null | undefined): ProxyRequestSpeed {
  return body?.service_tier === "priority" ? "fast" : "normal";
}

function resolveProxyRequestSpeedFromBodyText(bodyText: string): ProxyRequestSpeed {
  try {
    return resolveProxyRequestSpeed(parseJsonBody(bodyText));
  } catch {
    return "normal";
  }
}

function isRetryableQuotaFailure(statusCode: number, payload: unknown): boolean {
  if (hasQuotaExhaustionSignal(payload)) {
    return true;
  }

  return statusCode === 429 && hasExhaustedRateLimitSignal(payload);
}

function isProxyWebSocketTerminalEvent(payloadType: string | null): boolean {
  return payloadType === "response.completed"
    || payloadType === "response.done"
    || payloadType === "response.failed"
    || payloadType === "error";
}

function doesProxyWebSocketEventLockReplay(
  payloadType: string | null,
  payload: Record<string, unknown> | null,
): boolean {
  if (payloadType === null) {
    return true;
  }

  if (payloadType === "response.output_text.delta") {
    return typeof payload?.delta === "string" && payload.delta !== "";
  }

  if (payloadType === "response.output_text.done") {
    return typeof payload?.text === "string" && payload.text !== "";
  }

  if (payloadType === "response.output_item.done" && payload?.item !== undefined) {
    return normalizeResponseOutputItem(payload.item) !== null;
  }

  return false;
}

function shouldBufferProxyWebSocketPreludeEvent(
  payloadType: string | null,
  payload: Record<string, unknown> | null,
): boolean {
  return !isProxyWebSocketTerminalEvent(payloadType) && !doesProxyWebSocketEventLockReplay(payloadType, payload);
}

async function forwardChatGPTBackend(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  pathname: string;
  search: string;
  store: AccountStore;
  fetchImpl: typeof fetch;
}): Promise<ProxyForwardResult> {
  const authorization = typeof options.request.headers.authorization === "string"
    ? options.request.headers.authorization
    : null;
  const shouldReplaceAuth = authorization === null || isSyntheticProxyBearerToken(authorization);
  const selected = shouldReplaceAuth
    ? await selectProxyAccount(options.store, "chatgpt")
    : null;
  const outgoingHeaders = shouldReplaceAuth
    ? buildChatGPTAuthHeaders(options.request, selected)
    : requestHeadersToFetchHeaders(options.request);

  if (shouldReplaceAuth && !selected) {
    const errorMessage = "No eligible ChatGPT account is available for proxy upstream.";
    return {
      statusCode: 503,
      responseBytes: writeError(options.response, 503, errorMessage),
      authKind: "synthetic-chatgpt",
      selectedAccount: null,
      selectedAuthMode: null,
      upstreamKind: "chatgpt",
      errorPayload: buildLocalErrorLogPayload({
        request: options.request,
        bodyText: options.bodyText,
        responseBodyText: buildProxyErrorResponseText(errorMessage),
      }),
    };
  }

  const upstreamUrl = upstreamChatGPTUrl(options.pathname, options.search);
  const upstream = await options.fetchImpl(
    upstreamUrl,
    fetchInitForRequest(
      options.request,
      outgoingHeaders,
      options.bodyText,
    ),
  );
  const logged = await writeUpstreamResponseWithLogging({
    request: options.request,
    response: options.response,
    bodyText: options.bodyText,
    upstream,
    upstreamUrl,
    upstreamRequestHeaders: outgoingHeaders,
    captureDiagnostic: shouldCaptureDiagnosticPayload(options.pathname),
  });
  return {
    statusCode: upstream.status,
    responseBytes: logged.responseBytes,
    authKind: shouldReplaceAuth ? "synthetic-chatgpt" : "direct-chatgpt",
    selectedAccount: selected?.account.name ?? null,
    selectedAuthMode: selected?.account.auth_mode ?? null,
    upstreamKind: "chatgpt",
    diagnostic: logged.diagnostic,
    errorPayload: logged.errorPayload,
  };
}

function resolveInstructions(value: unknown): string {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : DEFAULT_CODEX_INSTRUCTIONS;
}

function normalizeInputContent(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  if (!Array.isArray(content)) {
    return content;
  }

  return content.map((part) => {
    if (typeof part === "string") {
      return { type: "input_text", text: part };
    }
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      return part;
    }
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return {
        ...record,
        type: "input_text",
      };
    }
    return record;
  });
}

function normalizeResponsesInputItem(item: unknown): unknown {
  if (typeof item === "string") {
    return {
      role: "user",
      content: [{ type: "input_text", text: item }],
    };
  }

  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return item;
  }

  const record = item as Record<string, unknown>;
  return {
    ...record,
    role: typeof record.role === "string" ? record.role : "user",
    content: normalizeInputContent(record.content ?? ""),
  };
}

function normalizeResponsesInput(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeResponsesInputItem(item));
  }
  if (input === undefined) {
    return [];
  }
  return [normalizeResponsesInputItem(input)];
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeWebSocketInput(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return cloneJsonValue(input);
  }
  if (input === undefined) {
    return [];
  }
  return [cloneJsonValue(input)];
}

function normalizeResponseOutputContentPart(
  part: unknown,
  role: string,
): Record<string, unknown> | null {
  if (typeof part === "string") {
    return {
      type: role === "assistant" ? "output_text" : "input_text",
      text: part,
    };
  }

  if (typeof part !== "object" || part === null || Array.isArray(part)) {
    return null;
  }

  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  const text = typeof record.text === "string"
    ? record.text
    : typeof record.output_text === "string"
      ? record.output_text
      : null;
  const refusal = typeof record.refusal === "string"
    ? record.refusal
    : null;
  if (
    (type === null || type === "text" || type === "input_text" || type === "output_text")
    && text !== null
  ) {
    return {
      type: role === "assistant" ? "output_text" : "input_text",
      text,
    };
  }

  if (role === "assistant" && type === "refusal" && refusal !== null) {
    return {
      type: "refusal",
      refusal,
    };
  }

  if (type === "input_image" && typeof record.image_url === "string") {
    return {
      type: "input_image",
      image_url: record.image_url,
    };
  }

  return null;
}

function normalizeResponseOutputMessageItem(record: Record<string, unknown>): Record<string, unknown> | null {
  const role = typeof record.role === "string" ? record.role : "assistant";
  const content = Array.isArray(record.content)
    ? record.content
      .map((part) => normalizeResponseOutputContentPart(part, role))
      .filter((part): part is Record<string, unknown> => part !== null)
    : [];
  if (content.length === 0) {
    return null;
  }

  return {
    role,
    content,
  };
}

function normalizeResponseOutputItem(item: unknown): unknown | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return null;
  }

  const record = item as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || type.trim() === "") {
    return null;
  }

  if (type === "message") {
    return normalizeResponseOutputMessageItem(record);
  }

  if (type === "function_call") {
    if (
      typeof record.call_id !== "string"
      || typeof record.name !== "string"
      || typeof record.arguments !== "string"
    ) {
      return null;
    }
    return {
      type,
      call_id: record.call_id,
      name: record.name,
      arguments: record.arguments,
    };
  }

  if (type === "function_call_output" || type === "mcp_tool_call_output") {
    if (typeof record.call_id !== "string" || record.output === undefined) {
      return null;
    }
    return {
      type,
      call_id: record.call_id,
      output: cloneJsonValue(record.output),
    };
  }

  if (type === "custom_tool_call_output") {
    if (typeof record.call_id !== "string" || record.output === undefined) {
      return null;
    }
    return {
      type,
      call_id: record.call_id,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      output: cloneJsonValue(record.output),
    };
  }

  if (type === "tool_search_output") {
    if (
      typeof record.call_id !== "string"
      || typeof record.status !== "string"
      || typeof record.execution !== "string"
      || !Array.isArray(record.tools)
    ) {
      return null;
    }
    return {
      type,
      call_id: record.call_id,
      status: record.status,
      execution: record.execution,
      tools: cloneJsonValue(record.tools),
    };
  }

  return null;
}

function responseOutputItemsToConversationItems(items: unknown): unknown[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => normalizeResponseOutputItem(item))
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function extractChatInstructions(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return DEFAULT_CODEX_INSTRUCTIONS;
  }

  const parts = messages.flatMap((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return [];
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "system") {
      return [];
    }
    const normalized = normalizeInputContent(record.content ?? "");
    if (typeof normalized === "string") {
      return normalized.trim() === "" ? [] : [normalized];
    }
    if (!Array.isArray(normalized)) {
      return [];
    }
    return normalized
      .map((part) => {
        if (typeof part !== "object" || part === null || Array.isArray(part)) {
          return null;
        }
        return typeof (part as Record<string, unknown>).text === "string"
          ? String((part as Record<string, unknown>).text).trim()
          : null;
      })
      .filter((value): value is string => value !== null && value !== "");
  });

  return parts.length > 0 ? parts.join("\n\n") : DEFAULT_CODEX_INSTRUCTIONS;
}

function chatMessagesToResponsesInput(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) {
    return normalizeResponsesInput(messages);
  }

  return messages
    .filter((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        return true;
      }
      return (message as Record<string, unknown>).role !== "system";
    })
    .map((message) => normalizeResponsesInputItem(message));
}

function normalizeResponsesRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    model: body.model,
    instructions: resolveInstructions(body.instructions),
    store: false,
    stream: true,
    input: normalizeResponsesInput(body.input),
  };
  for (const key of ["temperature", "top_p", "tools", "tool_choice", "response_format", "metadata", "service_tier"]) {
    if (body[key] !== undefined) {
      next[key] = body[key];
    }
  }
  if (body.max_output_tokens !== undefined) {
    next.max_output_tokens = body.max_output_tokens;
  }
  return next;
}

function chatCompletionToResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    model: body.model,
    instructions: extractChatInstructions(body.messages),
    store: false,
    stream: true,
    input: chatMessagesToResponsesInput(body.messages),
  };
  for (const key of ["temperature", "top_p", "tools", "tool_choice", "response_format", "service_tier"]) {
    if (body[key] !== undefined) {
      next[key] = body[key];
    }
  }
  if (body.max_completion_tokens !== undefined) {
    next.max_output_tokens = body.max_completion_tokens;
  } else if (body.max_tokens !== undefined) {
    next.max_output_tokens = body.max_tokens;
  }
  return next;
}

function completionToResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    model: body.model,
    instructions: resolveInstructions(body.instructions),
    store: false,
    stream: true,
    input: normalizeResponsesInput(body.prompt ?? ""),
  };
  for (const key of ["temperature", "top_p", "service_tier"]) {
    if (body[key] !== undefined) {
      next[key] = body[key];
    }
  }
  if (body.max_tokens !== undefined) {
    next.max_output_tokens = body.max_tokens;
  }
  return next;
}

function parseResponsePayloadFromSse(text: string): unknown {
  const lines = text.split(/\r?\n/u);
  let currentData: string[] = [];
  let lastPayload: unknown = null;
  let lastResponse: unknown = null;
  let accumulatedOutputText = "";
  const outputItems = new Map<number, unknown>();

  const flush = () => {
    if (currentData.length === 0) {
      return;
    }
    const payloadText = currentData.join("\n").trim();
    currentData = [];
    if (payloadText === "") {
      return;
    }
    try {
      const payload = parseMaybeJson(payloadText);
      lastPayload = payload;
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>;
        const response = record.response;
        if (response !== undefined) {
          lastResponse = response;
        }
        if (record.type === "response.output_text.delta" && typeof record.delta === "string") {
          accumulatedOutputText += record.delta;
        }
        if (record.type === "response.output_text.done" && typeof record.text === "string") {
          accumulatedOutputText = record.text;
        }
        if (record.type === "response.output_item.done" && record.item !== undefined) {
          const outputIndex = typeof record.output_index === "number"
            ? record.output_index
            : outputItems.size;
          outputItems.set(outputIndex, record.item);
        }
      }
    } catch {
      lastPayload = { detail: payloadText };
    }
  };

  for (const line of lines) {
    if (line.startsWith("data:")) {
      currentData.push(line.slice(5).trimStart());
      continue;
    }
    if (line.trim() === "") {
      flush();
    }
  }
  flush();
  if (typeof lastResponse === "object" && lastResponse !== null && !Array.isArray(lastResponse)) {
    const response = { ...(lastResponse as Record<string, unknown>) };
    const currentOutput = Array.isArray(response.output) ? response.output : [];
    if (currentOutput.length === 0 && outputItems.size > 0) {
      response.output = [...outputItems.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, item]) => item);
    }
    const extractedText = extractResponseText(response);
    if (extractedText !== "") {
      response.output_text = extractedText;
    } else if (accumulatedOutputText !== "") {
      response.output_text = accumulatedOutputText;
    }
    return response;
  }
  return lastPayload ?? {};
}

async function readResponsesPayload(upstream: Response): Promise<unknown> {
  const text = await upstream.text();
  if (text.trim() === "") {
    return {};
  }

  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    return parseResponsePayloadFromSse(text);
  }

  try {
    return parseMaybeJson(text);
  } catch {
    return { detail: text };
  }
}

async function readBufferedJsonPayload(upstream: Response): Promise<{
  bodyText: string;
  payload: unknown;
  responseHeaders: Record<string, string>;
}> {
  const bodyText = await upstream.text();
  const responseHeaders = upstreamResponseHeadersToRecord(upstream);
  if (bodyText.trim() === "") {
    return {
      bodyText,
      payload: {},
      responseHeaders,
    };
  }

  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream") || bodyText.startsWith("event:") || bodyText.startsWith("data:")) {
    return {
      bodyText,
      payload: parseResponsePayloadFromSse(bodyText),
      responseHeaders,
    };
  }

  try {
    return {
      bodyText,
      payload: parseMaybeJson(bodyText),
      responseHeaders,
    };
  } catch {
    return {
      bodyText,
      payload: { detail: bodyText },
      responseHeaders,
    };
  }
}

function extractResponseText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text;
  }
  const output = record.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const texts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const partRecord = part as Record<string, unknown>;
      const text = partRecord.text ?? partRecord.output_text;
      if (typeof text === "string") {
        texts.push(text);
      }
    }
  }
  return texts.join("");
}

function responsesPayloadToChatCompletion(payload: unknown, fallbackModel: unknown): Record<string, unknown> {
  const record = typeof payload === "object" && payload !== null
    ? payload as Record<string, unknown>
    : {};
  return {
    id: typeof record.id === "string" ? record.id.replace(/^resp_/u, "chatcmpl_") : `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof record.model === "string" ? record.model : fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: extractResponseText(payload),
        },
        finish_reason: "stop",
      },
    ],
    ...(record.usage ? { usage: record.usage } : {}),
  };
}

function responsesPayloadToCompletion(payload: unknown, fallbackModel: unknown): Record<string, unknown> {
  const record = typeof payload === "object" && payload !== null
    ? payload as Record<string, unknown>
    : {};
  return {
    id: typeof record.id === "string" ? record.id.replace(/^resp_/u, "cmpl_") : `cmpl_${Date.now()}`,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof record.model === "string" ? record.model : fallbackModel,
    choices: [
      {
        index: 0,
        text: extractResponseText(payload),
        finish_reason: "stop",
      },
    ],
    ...(record.usage ? { usage: record.usage } : {}),
  };
}

function rawWebSocketDataToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

function parseWebSocketPayload(data: RawData): Record<string, unknown> {
  const parsed = JSON.parse(rawWebSocketDataToText(data)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("WebSocket payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function openChatGPTUpstreamWebSocket(options: {
  url: string;
  headers: OutgoingHttpHeaders;
  connectWebSocketImpl?: StartProxyServerOptions["connectWebSocketImpl"];
}): Promise<WebSocket> {
  if (options.connectWebSocketImpl) {
    return await options.connectWebSocketImpl({
      url: options.url,
      headers: options.headers,
    });
  }

  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(
      options.url,
      {
        headers: options.headers,
        perMessageDeflate: false,
      },
    );

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleOpen = () => {
      cleanup();
      resolve(socket);
    };
    const cleanup = () => {
      socket.off("error", handleError);
      socket.off("open", handleOpen);
    };

    socket.once("error", handleError);
    socket.once("open", handleOpen);
  });
}

async function closeProxyWebSocket(socket: WebSocket | null): Promise<void> {
  if (!socket) {
    return;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      resolve();
    };

    socket.once("close", finish);
    socket.once("error", finish);
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      finish();
      return;
    }
    socket.close();
    setTimeout(finish, 250);
  });
}

function rewriteWebSocketCreateRequest(options: {
  requestBody: Record<string, unknown>;
  selectedAccountName: string;
  historyByResponseId: Map<string, ProxyStoredConversation>;
}): {
  requestBody: Record<string, unknown>;
  fullInput: unknown[];
  reconstructed: boolean;
} {
  const previousResponseId = typeof options.requestBody.previous_response_id === "string"
    ? options.requestBody.previous_response_id
    : null;
  const deltaInput = normalizeWebSocketInput(options.requestBody.input);

  if (!previousResponseId) {
    return {
      requestBody: options.requestBody,
      fullInput: deltaInput,
      reconstructed: false,
    };
  }

  const priorConversation = options.historyByResponseId.get(previousResponseId);
  if (!priorConversation) {
    return {
      requestBody: options.requestBody,
      fullInput: deltaInput,
      reconstructed: false,
    };
  }

  const fullInput = [
    ...cloneJsonValue(priorConversation.conversationItems),
    ...deltaInput,
  ];

  if (priorConversation.accountName === options.selectedAccountName) {
    return {
      requestBody: options.requestBody,
      fullInput,
      reconstructed: false,
    };
  }

  const rewrittenBody = {
    ...options.requestBody,
    input: fullInput,
  };
  delete (rewrittenBody as Record<string, unknown>).previous_response_id;

  return {
    requestBody: rewrittenBody,
    fullInput,
    reconstructed: true,
  };
}

function hasChatGPTAccountHeader(request: IncomingMessage): boolean {
  const header = request.headers["chatgpt-account-id"];
  if (Array.isArray(header)) {
    return header.some((value) => typeof value === "string" && value.trim() !== "");
  }
  return typeof header === "string" && header.trim() !== "";
}

function upstreamOpenAIWebSocketUrl(): string {
  const url = new URL("/v1/responses", OPENAI_UPSTREAM_BASE_URL);
  return url.toString().replace(/^http/u, "ws");
}

function upstreamChatGPTWebSocketUrl(): string {
  const url = new URL("/backend-api/codex/responses", CHATGPT_UPSTREAM_BASE_URL);
  return url.toString().replace(/^http/u, "ws");
}

async function openTransparentUpstreamWebSocket(options: {
  request: IncomingMessage;
  authKind: "direct-chatgpt" | "apikey" | "unknown";
  connectWebSocketImpl?: StartProxyServerOptions["connectWebSocketImpl"];
}): Promise<WebSocket> {
  const url = options.authKind === "direct-chatgpt"
    ? upstreamChatGPTWebSocketUrl()
    : upstreamOpenAIWebSocketUrl();

  return await openChatGPTUpstreamWebSocket({
    url,
    headers: requestHeadersToWebSocketHeaders(options.request),
    connectWebSocketImpl: options.connectWebSocketImpl,
  });
}

function requestAuthKindForOpenAIRoute(request: IncomingMessage): "synthetic-chatgpt" | "direct-chatgpt" | "apikey" | "unknown" {
  const authorization = typeof request.headers.authorization === "string"
    ? request.headers.authorization
    : null;

  if (authorization === null || isSyntheticProxyBearerToken(authorization)) {
    return "synthetic-chatgpt";
  }

  if (hasChatGPTAccountHeader(request)) {
    return "direct-chatgpt";
  }

  if (/^Bearer\s+/iu.test(authorization)) {
    return "apikey";
  }

  return "unknown";
}

async function forwardTransparentOpenAI(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  pathname: string;
  search: string;
  fetchImpl: typeof fetch;
  authKind: "apikey" | "unknown";
}): Promise<ProxyForwardResult> {
  const upstreamUrl = `${OPENAI_UPSTREAM_BASE_URL}${options.pathname.replace(/^\/v1/u, "")}${options.search}`;
  const outgoingHeaders = requestHeadersToFetchHeaders(options.request);
  const upstream = await options.fetchImpl(
    upstreamUrl,
    fetchInitForRequest(
      options.request,
      outgoingHeaders,
      options.bodyText,
    ),
  );
  const logged = await writeUpstreamResponseWithLogging({
    request: options.request,
    response: options.response,
    bodyText: options.bodyText,
    upstream,
    upstreamUrl,
    upstreamRequestHeaders: outgoingHeaders,
  });

  return {
    statusCode: upstream.status,
    responseBytes: logged.responseBytes,
    authKind: options.authKind,
    selectedAccount: null,
    selectedAuthMode: null,
    upstreamKind: "openai",
    errorPayload: logged.errorPayload,
  };
}

async function forwardRawChatGPTCompatibleRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  pathname: string;
  search: string;
  fetchImpl: typeof fetch;
  headers: Headers;
  authKind: "direct-chatgpt" | "synthetic-chatgpt";
  selected: ProxyUpstreamAccount | null;
}): Promise<ProxyForwardResult> {
  const upstreamUrl = toChatGPTCodexUrl(options.pathname, options.search);
  const upstream = await options.fetchImpl(
    upstreamUrl,
    fetchInitForRequest(
      options.request,
      options.headers,
      options.bodyText,
    ),
  );
  const logged = await writeUpstreamResponseWithLogging({
    request: options.request,
    response: options.response,
    bodyText: options.bodyText,
    upstream,
    upstreamUrl,
    upstreamRequestHeaders: options.headers,
  });

  return {
    statusCode: upstream.status,
    responseBytes: logged.responseBytes,
    authKind: options.authKind,
    selectedAccount: options.selected?.account.name ?? null,
    selectedAuthMode: options.selected?.account.auth_mode ?? (options.authKind === "direct-chatgpt" ? "chatgpt" : null),
    upstreamKind: "chatgpt",
    errorPayload: logged.errorPayload,
  };
}

async function forwardOpenAIViaDirectChatGPT(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  pathname: string;
  search: string;
  fetchImpl: typeof fetch;
}): Promise<ProxyForwardResult> {
  let upstream: Response;
  let responsePayload: unknown;

  if (options.pathname === "/v1/responses") {
    const body = parseJsonBody(options.bodyText);
    const requestBody = normalizeResponsesRequestBody(body);
    const upstreamUrl = `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`;
    const outgoingHeaders = requestHeadersToFetchHeaders(options.request);
    upstream = await options.fetchImpl(
      upstreamUrl,
      {
        method: options.request.method ?? "POST",
        headers: outgoingHeaders,
        body: JSON.stringify(requestBody),
      },
    );
    const shouldStream = body.stream === true;
    if (shouldStream) {
      const logged = await writeUpstreamResponseWithLogging({
        request: options.request,
        response: options.response,
        bodyText: options.bodyText,
        upstream,
        upstreamUrl,
        upstreamRequestHeaders: outgoingHeaders,
      });
      return {
        statusCode: upstream.status,
        responseBytes: logged.responseBytes,
        authKind: "direct-chatgpt",
        selectedAccount: null,
        selectedAuthMode: "chatgpt",
        upstreamKind: "chatgpt",
        requestSpeed: resolveProxyRequestSpeed(requestBody),
        errorPayload: logged.errorPayload,
      };
    }

    const buffered = await readBufferedJsonPayload(upstream);
    return {
      statusCode: upstream.status,
      responseBytes: writeJson(
        options.response,
        upstream.ok ? 200 : upstream.status,
        buffered.payload,
      ),
      authKind: "direct-chatgpt",
      selectedAccount: null,
      selectedAuthMode: "chatgpt",
      upstreamKind: "chatgpt",
      requestSpeed: resolveProxyRequestSpeed(requestBody),
      errorPayload: upstream.ok
        ? undefined
        : buildRequestResponseLogPayload({
            request: options.request,
            bodyText: options.bodyText,
            upstreamUrl,
            upstreamRequestHeaders: outgoingHeaders,
            responseHeaders: buffered.responseHeaders,
            responseBodyText: buffered.bodyText,
          }),
    };
  }

  if (options.pathname === "/v1/chat/completions") {
    const body = parseJsonBody(options.bodyText);
    const requestBody = chatCompletionToResponsesBody(body);
    const upstreamUrl = `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`;
    const outgoingHeaders = requestHeadersToFetchHeaders(options.request);
    upstream = await options.fetchImpl(
      upstreamUrl,
      {
        method: "POST",
        headers: outgoingHeaders,
        body: JSON.stringify(requestBody),
      },
    );
    const buffered = await readBufferedJsonPayload(upstream);
    responsePayload = buffered.payload;
    return {
      statusCode: upstream.ok ? 200 : upstream.status,
      responseBytes: writeJson(
        options.response,
        upstream.ok ? 200 : upstream.status,
        upstream.ok ? responsesPayloadToChatCompletion(responsePayload, body.model) : responsePayload,
      ),
      authKind: "direct-chatgpt",
      selectedAccount: null,
      selectedAuthMode: "chatgpt",
      upstreamKind: "chatgpt",
      requestSpeed: resolveProxyRequestSpeed(requestBody),
      errorPayload: upstream.ok
        ? undefined
        : buildRequestResponseLogPayload({
            request: options.request,
            bodyText: options.bodyText,
            upstreamUrl,
            upstreamRequestHeaders: outgoingHeaders,
            responseHeaders: buffered.responseHeaders,
            responseBodyText: buffered.bodyText,
          }),
    };
  }

  if (options.pathname === "/v1/completions") {
    const body = parseJsonBody(options.bodyText);
    const requestBody = completionToResponsesBody(body);
    const upstreamUrl = `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`;
    const outgoingHeaders = requestHeadersToFetchHeaders(options.request);
    upstream = await options.fetchImpl(
      upstreamUrl,
      {
        method: "POST",
        headers: outgoingHeaders,
        body: JSON.stringify(requestBody),
      },
    );
    const buffered = await readBufferedJsonPayload(upstream);
    responsePayload = buffered.payload;
    return {
      statusCode: upstream.ok ? 200 : upstream.status,
      responseBytes: writeJson(
        options.response,
        upstream.ok ? 200 : upstream.status,
        upstream.ok ? responsesPayloadToCompletion(responsePayload, body.model) : responsePayload,
      ),
      authKind: "direct-chatgpt",
      selectedAccount: null,
      selectedAuthMode: "chatgpt",
      upstreamKind: "chatgpt",
      requestSpeed: resolveProxyRequestSpeed(requestBody),
      errorPayload: upstream.ok
        ? undefined
        : buildRequestResponseLogPayload({
            request: options.request,
            bodyText: options.bodyText,
            upstreamUrl,
            upstreamRequestHeaders: outgoingHeaders,
            responseHeaders: buffered.responseHeaders,
            responseBodyText: buffered.bodyText,
          }),
    };
  }

  return await forwardRawChatGPTCompatibleRoute({
    request: options.request,
    response: options.response,
    bodyText: options.bodyText,
    pathname: options.pathname,
    search: options.search,
    fetchImpl: options.fetchImpl,
    headers: requestHeadersToFetchHeaders(options.request),
    authKind: "direct-chatgpt",
    selected: null,
  });
}

function isBufferedProxyReplayRoute(pathname: string, body: Record<string, unknown>): boolean {
  if (pathname === "/v1/responses") {
    return body.stream !== true;
  }
  if (pathname === "/v1/chat/completions" || pathname === "/v1/completions") {
    return body.stream !== true;
  }
  return false;
}

async function fetchSyntheticChatGPTBufferedPayloadWithReplay(options: {
  request: IncomingMessage;
  store: AccountStore;
  selected: ProxyUpstreamAccount;
  fetchImpl: typeof fetch;
  buildRequestBody: (selected: ProxyUpstreamAccount) => Record<string, unknown>;
}): Promise<{
  payload: unknown;
  replayCount: number;
  replayedFromAccountNames: string[];
  requestSpeed: ProxyRequestSpeed;
  selected: ProxyUpstreamAccount;
  upstreamStatus: number;
  responseHeaders: Record<string, string>;
  responseBodyText: string;
}> {
  let selected = options.selected;
  const replayedFromAccountNames: string[] = [];
  const attemptedAccountNames = new Set<string>();

  while (true) {
    attemptedAccountNames.add(selected.account.name);
    const requestBody = options.buildRequestBody(selected);
    const upstream = await options.fetchImpl(
      `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`,
      {
        method: options.request.method ?? "POST",
        headers: buildChatGPTAuthHeaders(options.request, selected),
        body: JSON.stringify(requestBody),
      },
    );
    const buffered = await readBufferedJsonPayload(upstream);
    const payload = buffered.payload;
    if (!isRetryableQuotaFailure(upstream.status, payload) || replayedFromAccountNames.length >= 1) {
      return {
        payload,
        replayCount: replayedFromAccountNames.length,
        replayedFromAccountNames,
        requestSpeed: resolveProxyRequestSpeed(requestBody),
        selected,
        upstreamStatus: upstream.status,
        responseHeaders: buffered.responseHeaders,
        responseBodyText: buffered.bodyText,
      };
    }

    const replaySelected = await selectProxyReplayAccount(options.store, "chatgpt", attemptedAccountNames);
    if (!replaySelected || replaySelected.account.name === selected.account.name) {
      return {
        payload,
        replayCount: replayedFromAccountNames.length,
        replayedFromAccountNames,
        requestSpeed: resolveProxyRequestSpeed(requestBody),
        selected,
        upstreamStatus: upstream.status,
        responseHeaders: buffered.responseHeaders,
        responseBodyText: buffered.bodyText,
      };
    }

    replayedFromAccountNames.push(selected.account.name);
    await persistProxyUpstreamAccountSelection(options.store, replaySelected.account);
    selected = replaySelected;
  }
}

async function forwardOpenAIWithApiKey(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  pathname: string;
  search: string;
  selected: ProxyUpstreamAccount;
  store: AccountStore;
  fetchImpl: typeof fetch;
}): Promise<ProxyForwardResult> {
  const canReplayBufferedRoute = options.pathname === "/v1/responses"
    || options.pathname === "/v1/chat/completions"
    || options.pathname === "/v1/completions";
  const parsedBody = canReplayBufferedRoute
    ? (options.bodyText.trim() === "" ? {} : parseJsonBody(options.bodyText))
    : {};
  if (!canReplayBufferedRoute || !isBufferedProxyReplayRoute(options.pathname, parsedBody)) {
    const upstreamUrl = toOpenAIUrl(await readOpenAIBaseUrl(options.selected.account), options.pathname, options.search);
    const outgoingHeaders = buildApiKeyHeaders(options.request, options.selected);
    const upstream = await options.fetchImpl(
      upstreamUrl,
      fetchInitForRequest(
        options.request,
        outgoingHeaders,
        options.bodyText,
      ),
    );
    const logged = await writeUpstreamResponseWithLogging({
      request: options.request,
      response: options.response,
      bodyText: options.bodyText,
      upstream,
      upstreamUrl,
      upstreamRequestHeaders: outgoingHeaders,
    });
      return {
        statusCode: upstream.status,
        responseBytes: logged.responseBytes,
        authKind: "apikey",
        selectedAccount: options.selected.account.name,
        selectedAuthMode: options.selected.account.auth_mode,
        upstreamKind: "openai",
        requestSpeed: resolveProxyRequestSpeed(parsedBody),
        errorPayload: logged.errorPayload,
      };
  }

  let selected = options.selected;
  const replayedFromAccountNames: string[] = [];
  const attemptedAccountNames = new Set<string>();
  while (true) {
    attemptedAccountNames.add(selected.account.name);
    const upstreamUrl = toOpenAIUrl(await readOpenAIBaseUrl(selected.account), options.pathname, options.search);
    const outgoingHeaders = buildApiKeyHeaders(options.request, selected);
    const upstream = await options.fetchImpl(
      upstreamUrl,
      fetchInitForRequest(
        options.request,
        outgoingHeaders,
        options.bodyText,
      ),
    );
    const buffered = await readBufferedJsonPayload(upstream);
    if (!isRetryableQuotaFailure(upstream.status, buffered.payload) || replayedFromAccountNames.length >= 1) {
      return {
        statusCode: upstream.status,
        responseBytes: writeBufferedResponse(
          options.response,
          upstream.status,
          buffered.responseHeaders,
          buffered.bodyText,
        ),
        authKind: "apikey",
        selectedAccount: selected.account.name,
        selectedAuthMode: selected.account.auth_mode,
        upstreamKind: "openai",
        requestSpeed: resolveProxyRequestSpeed(parsedBody),
        diagnostic: {
          replay_count: replayedFromAccountNames.length,
          replayed_from_account_names: replayedFromAccountNames,
        },
        errorPayload: upstream.status === 200
          ? undefined
          : {
              ...buildRequestResponseLogPayload({
                request: options.request,
                bodyText: options.bodyText,
                upstreamUrl,
                upstreamRequestHeaders: outgoingHeaders,
                responseHeaders: buffered.responseHeaders,
                responseBodyText: buffered.bodyText,
              }),
              replay_count: replayedFromAccountNames.length,
              replayed_from_account_names: replayedFromAccountNames,
            },
      };
    }

    const replaySelected = await selectProxyReplayAccount(options.store, "apikey", attemptedAccountNames);
    if (!replaySelected || replaySelected.account.name === selected.account.name) {
      return {
        statusCode: upstream.status,
        responseBytes: writeBufferedResponse(
          options.response,
          upstream.status,
          buffered.responseHeaders,
          buffered.bodyText,
        ),
        authKind: "apikey",
        selectedAccount: selected.account.name,
        selectedAuthMode: selected.account.auth_mode,
        upstreamKind: "openai",
        requestSpeed: resolveProxyRequestSpeed(parsedBody),
        diagnostic: {
          replay_count: replayedFromAccountNames.length,
          replayed_from_account_names: replayedFromAccountNames,
        },
      };
    }

    replayedFromAccountNames.push(selected.account.name);
    await persistProxyUpstreamAccountSelection(options.store, replaySelected.account);
    selected = replaySelected;
  }
}

async function forwardOpenAIViaChatGPT(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  pathname: string;
  search: string;
  selected: ProxyUpstreamAccount;
  store: AccountStore;
  fetchImpl: typeof fetch;
}): Promise<ProxyForwardResult> {
  if (options.pathname === "/v1/responses") {
    const body = parseJsonBody(options.bodyText);
    const shouldStream = body.stream === true;
    if (shouldStream) {
      const requestBody = maybeInjectFastServiceTier(normalizeResponsesRequestBody(body), options.selected);
      const upstreamUrl = `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`;
      const outgoingHeaders = buildChatGPTAuthHeaders(options.request, options.selected);
      const upstream = await options.fetchImpl(
        upstreamUrl,
        {
          method: options.request.method ?? "POST",
          headers: outgoingHeaders,
          body: JSON.stringify(requestBody),
        },
      );
      const logged = await writeUpstreamResponseWithLogging({
        request: options.request,
        response: options.response,
        bodyText: options.bodyText,
        upstream,
        upstreamUrl,
        upstreamRequestHeaders: outgoingHeaders,
      });
      return {
        statusCode: upstream.status,
        responseBytes: logged.responseBytes,
        authKind: "synthetic-chatgpt",
        selectedAccount: options.selected.account.name,
        selectedAuthMode: options.selected.account.auth_mode,
        upstreamKind: "chatgpt",
        requestSpeed: resolveProxyRequestSpeed(requestBody),
        errorPayload: logged.errorPayload,
      };
    }

    const replayed = await fetchSyntheticChatGPTBufferedPayloadWithReplay({
      request: options.request,
      store: options.store,
      selected: options.selected,
      fetchImpl: options.fetchImpl,
      buildRequestBody: (selected) => maybeInjectFastServiceTier(normalizeResponsesRequestBody(body), selected),
    });
    const responseBytes = writeJson(
      options.response,
      replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
      replayed.payload,
    );
    return {
      statusCode: replayed.upstreamStatus,
      responseBytes,
      authKind: "synthetic-chatgpt",
      selectedAccount: replayed.selected.account.name,
      selectedAuthMode: replayed.selected.account.auth_mode,
      upstreamKind: "chatgpt",
      requestSpeed: replayed.requestSpeed,
      diagnostic: {
        replay_count: replayed.replayCount,
        replayed_from_account_names: replayed.replayedFromAccountNames,
      },
      errorPayload: replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300
        ? undefined
        : {
            ...buildRequestResponseLogPayload({
              request: options.request,
              bodyText: options.bodyText,
              upstreamUrl: `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`,
              upstreamRequestHeaders: buildChatGPTAuthHeaders(options.request, replayed.selected),
              responseHeaders: replayed.responseHeaders,
              responseBodyText: replayed.responseBodyText,
            }),
            replay_count: replayed.replayCount,
            replayed_from_account_names: replayed.replayedFromAccountNames,
          },
    };
  }

  if (options.pathname === "/v1/chat/completions") {
    const body = parseJsonBody(options.bodyText);
    const replayed = await fetchSyntheticChatGPTBufferedPayloadWithReplay({
      request: options.request,
      store: options.store,
      selected: options.selected,
      fetchImpl: options.fetchImpl,
      buildRequestBody: (selected) => maybeInjectFastServiceTier(chatCompletionToResponsesBody(body), selected),
    });
    return {
      statusCode: replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
      responseBytes: writeJson(
        options.response,
        replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
        replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300
          ? responsesPayloadToChatCompletion(replayed.payload, body.model)
          : replayed.payload,
      ),
      authKind: "synthetic-chatgpt",
      selectedAccount: replayed.selected.account.name,
      selectedAuthMode: replayed.selected.account.auth_mode,
      upstreamKind: "chatgpt",
      requestSpeed: replayed.requestSpeed,
      diagnostic: {
        replay_count: replayed.replayCount,
        replayed_from_account_names: replayed.replayedFromAccountNames,
      },
      errorPayload: replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300
        ? undefined
        : {
            ...buildRequestResponseLogPayload({
              request: options.request,
              bodyText: options.bodyText,
              upstreamUrl: `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`,
              upstreamRequestHeaders: buildChatGPTAuthHeaders(options.request, replayed.selected),
              responseHeaders: replayed.responseHeaders,
              responseBodyText: replayed.responseBodyText,
            }),
            replay_count: replayed.replayCount,
            replayed_from_account_names: replayed.replayedFromAccountNames,
          },
    };
  }

  if (options.pathname === "/v1/completions") {
    const body = parseJsonBody(options.bodyText);
    const replayed = await fetchSyntheticChatGPTBufferedPayloadWithReplay({
      request: options.request,
      store: options.store,
      selected: options.selected,
      fetchImpl: options.fetchImpl,
      buildRequestBody: (selected) => maybeInjectFastServiceTier(completionToResponsesBody(body), selected),
    });
    return {
      statusCode: replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
      responseBytes: writeJson(
        options.response,
        replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
        replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300
          ? responsesPayloadToCompletion(replayed.payload, body.model)
          : replayed.payload,
      ),
      authKind: "synthetic-chatgpt",
      selectedAccount: replayed.selected.account.name,
      selectedAuthMode: replayed.selected.account.auth_mode,
      upstreamKind: "chatgpt",
      requestSpeed: replayed.requestSpeed,
      diagnostic: {
        replay_count: replayed.replayCount,
        replayed_from_account_names: replayed.replayedFromAccountNames,
      },
      errorPayload: replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300
        ? undefined
        : {
            ...buildRequestResponseLogPayload({
              request: options.request,
              bodyText: options.bodyText,
              upstreamUrl: `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`,
              upstreamRequestHeaders: buildChatGPTAuthHeaders(options.request, replayed.selected),
              responseHeaders: replayed.responseHeaders,
              responseBodyText: replayed.responseBodyText,
            }),
            replay_count: replayed.replayCount,
            replayed_from_account_names: replayed.replayedFromAccountNames,
          },
    };
  }

  if (options.pathname === "/v1/embeddings") {
    const errorMessage = "Embeddings require an API-key upstream account.";
    return {
      statusCode: 501,
      responseBytes: writeError(options.response, 501, errorMessage),
      authKind: "synthetic-chatgpt",
      selectedAccount: options.selected.account.name,
      selectedAuthMode: options.selected.account.auth_mode,
      upstreamKind: "chatgpt",
      errorPayload: buildLocalErrorLogPayload({
        request: options.request,
        bodyText: options.bodyText,
        responseBodyText: buildProxyErrorResponseText(errorMessage),
      }),
    };
  }

  return await forwardRawChatGPTCompatibleRoute({
    request: options.request,
    response: options.response,
    bodyText: options.bodyText,
    pathname: options.pathname,
    search: options.search,
    fetchImpl: options.fetchImpl,
    headers: buildChatGPTAuthHeaders(options.request, options.selected),
    authKind: "synthetic-chatgpt",
    selected: options.selected,
  });
}

async function handleOpenAIRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  bodyText: string;
  pathname: string;
  search: string;
  store: AccountStore;
  fetchImpl: typeof fetch;
}): Promise<ProxyForwardResult> {
  const authKind = requestAuthKindForOpenAIRoute(options.request);

  if (authKind === "direct-chatgpt") {
    if (options.pathname === "/v1/models" && options.request.method === "GET") {
      return {
        statusCode: 200,
        responseBytes: writeJson(options.response, 200, {
          object: "list",
          data: [
            { id: "gpt-5.4", object: "model", owned_by: "chatgpt" },
            { id: "gpt-5.1", object: "model", owned_by: "chatgpt" },
          ],
        }),
        authKind,
        selectedAccount: null,
        selectedAuthMode: "chatgpt",
        upstreamKind: "chatgpt",
      };
    }

    return await forwardOpenAIViaDirectChatGPT({
      request: options.request,
      response: options.response,
      bodyText: options.bodyText,
      pathname: options.pathname,
      search: options.search,
      fetchImpl: options.fetchImpl,
    });
  }

  if (authKind === "apikey" || authKind === "unknown") {
    return await forwardTransparentOpenAI({
      request: options.request,
      response: options.response,
      bodyText: options.bodyText,
      pathname: options.pathname,
      search: options.search,
      fetchImpl: options.fetchImpl,
      authKind,
    });
  }

  if (options.pathname === "/v1/models" && options.request.method === "GET") {
    const selectedApi = await selectProxyAccount(options.store, "apikey");
    if (selectedApi) {
      return await forwardOpenAIWithApiKey({ ...options, store: options.store, selected: selectedApi });
    }

    return {
      statusCode: 200,
      responseBytes: writeJson(options.response, 200, {
        object: "list",
        data: [
          { id: "gpt-5.1", object: "model", owned_by: "codexm-proxy" },
          { id: "gpt-4.1", object: "model", owned_by: "codexm-proxy" },
        ],
      }),
      authKind: "unknown",
      selectedAccount: null,
      selectedAuthMode: null,
      upstreamKind: "openai",
    };
  }

  const selectedApi = await selectProxyAccount(options.store, "apikey");
  if (selectedApi) {
    return await forwardOpenAIWithApiKey({ ...options, store: options.store, selected: selectedApi });
  }

  const selectedChatGPT = await selectProxyAccount(options.store, "chatgpt");
  if (!selectedChatGPT) {
    const errorMessage = "No eligible upstream account is available for proxy API.";
    return {
      statusCode: 503,
      responseBytes: writeError(options.response, 503, errorMessage),
      authKind: "unknown",
      selectedAccount: null,
      selectedAuthMode: null,
      upstreamKind: "chatgpt",
      errorPayload: buildLocalErrorLogPayload({
        request: options.request,
        bodyText: options.bodyText,
        responseBodyText: buildProxyErrorResponseText(errorMessage),
      }),
    };
  }
  return await forwardOpenAIViaChatGPT({ ...options, store: options.store, selected: selectedChatGPT });
}

export async function startProxyServer(options: StartProxyServerOptions): Promise<StartedProxyServer> {
  const host = options.host ?? DEFAULT_PROXY_HOST;
  const port = options.port ?? 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const websocketServer = new WebSocketServer({ noServer: true });
  const activeProxySockets = new Set<WebSocket>();

  const trackProxySocket = (socket: WebSocket) => {
    activeProxySockets.add(socket);
    const cleanup = () => {
      activeProxySockets.delete(socket);
      socket.off("close", cleanup);
      socket.off("error", cleanup);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  };

  const server = createServer((request, response) => {
    let requestBodyText = "";
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
      const pathname = normalizePathname(requestUrl.pathname);
      const bodyText = await readRequestBody(request);
      requestBodyText = bodyText;
      const startedAt = Date.now();
      const requestId = createRequestId();
      options.debugLog?.(`proxy: ${request.method ?? "GET"} ${pathname}`);
      const requestBytes = Buffer.byteLength(bodyText);

      if ((pathname === "/healthz" || pathname === "/backend-api/healthz") && request.method === "GET") {
        const responseBytes = writeJson(response, 200, { ok: true });
        await options.requestLogger?.({
          ts: new Date().toISOString(),
          request_id: requestId,
          pid: process.pid,
          method: request.method ?? "GET",
          route: pathname,
          surface: pathname.startsWith("/backend-api/") ? "backend-api" : "v1",
            auth_kind: "unknown",
            selected_account_name: null,
            selected_auth_mode: null,
            upstream_kind: "chatgpt",
            request_speed: "normal",
            status_code: 200,
          duration_ms: Date.now() - startedAt,
          request_bytes: requestBytes,
          response_bytes: responseBytes,
          synthetic_usage: false,
        });
        return;
      }

      if (pathname === "/backend-api/wham/usage" && request.method === "GET") {
        if (shouldUseSyntheticDesktopUsageSurface(request)) {
          const payload = await buildProxyUsagePayloadForStore(options.store);
          const responseBodyText = `${JSON.stringify(payload)}\n`;
          const responseBytes = writeJson(response, 200, payload);
          await options.requestLogger?.({
            ts: new Date().toISOString(),
            request_id: requestId,
            pid: process.pid,
            method: request.method ?? "GET",
            route: pathname,
            surface: "backend-api",
            auth_kind: "synthetic-chatgpt",
            selected_account_name: null,
            selected_auth_mode: null,
            upstream_kind: "chatgpt",
            request_speed: "normal",
            status_code: 200,
            duration_ms: Date.now() - startedAt,
            request_bytes: requestBytes,
            response_bytes: responseBytes,
            synthetic_usage: true,
            request_headers: incomingHeadersToRecord(request),
            request_body_text: bodyText,
            upstream_url: null,
            upstream_request_headers: null,
            response_headers: {
              "content-type": "application/json",
            },
            response_body_text: responseBodyText,
          });
          return;
        }
      }

      if (pathname === "/backend-api/wham/accounts/check" && request.method === "GET") {
        if (shouldUseSyntheticDesktopUsageSurface(request)) {
          const payload = await buildProxyWhamAccountsCheckPayloadForStore(options.store);
          const responseBodyText = `${JSON.stringify(payload)}\n`;
          const responseBytes = writeJson(response, 200, payload);
          await options.requestLogger?.({
            ts: new Date().toISOString(),
            request_id: requestId,
            pid: process.pid,
            method: request.method ?? "GET",
            route: pathname,
            surface: "backend-api",
            auth_kind: "synthetic-chatgpt",
            selected_account_name: null,
            selected_auth_mode: null,
            upstream_kind: "chatgpt",
            request_speed: "normal",
            status_code: 200,
            duration_ms: Date.now() - startedAt,
            request_bytes: requestBytes,
            response_bytes: responseBytes,
            synthetic_usage: false,
            request_headers: incomingHeadersToRecord(request),
            request_body_text: bodyText,
            upstream_url: null,
            upstream_request_headers: null,
            response_headers: {
              "content-type": "application/json",
            },
            response_body_text: responseBodyText,
          });
          return;
        }
      }

      if (pathname === "/backend-api/subscriptions/auto_top_up/settings" && request.method === "GET") {
        if (shouldUseSyntheticDesktopUsageSurface(request)) {
          const payload = buildProxyAutoTopUpSettingsPayload();
          const responseBodyText = `${JSON.stringify(payload)}\n`;
          const responseBytes = writeJson(response, 200, payload);
          await options.requestLogger?.({
            ts: new Date().toISOString(),
            request_id: requestId,
            pid: process.pid,
            method: request.method ?? "GET",
            route: pathname,
            surface: "backend-api",
            auth_kind: "synthetic-chatgpt",
            selected_account_name: null,
            selected_auth_mode: null,
            upstream_kind: "chatgpt",
            request_speed: "normal",
            status_code: 200,
            duration_ms: Date.now() - startedAt,
            request_bytes: requestBytes,
            response_bytes: responseBytes,
            synthetic_usage: false,
            request_headers: incomingHeadersToRecord(request),
            request_body_text: bodyText,
            upstream_url: null,
            upstream_request_headers: null,
            response_headers: {
              "content-type": "application/json",
            },
            response_body_text: responseBodyText,
          });
          return;
        }
      }

      if (/^\/backend-api\/accounts\/check\/.+/u.test(pathname) && request.method === "GET") {
        if (shouldUseSyntheticDesktopUsageSurface(request)) {
          const payload = buildProxyAccountCheckV4Payload();
          const responseBodyText = `${JSON.stringify(payload)}\n`;
          const responseBytes = writeJson(response, 200, payload);
          await options.requestLogger?.({
            ts: new Date().toISOString(),
            request_id: requestId,
            pid: process.pid,
            method: request.method ?? "GET",
            route: pathname,
            surface: "backend-api",
            auth_kind: "synthetic-chatgpt",
            selected_account_name: null,
            selected_auth_mode: null,
            upstream_kind: "chatgpt",
            request_speed: "normal",
            status_code: 200,
            duration_ms: Date.now() - startedAt,
            request_bytes: requestBytes,
            response_bytes: responseBytes,
            synthetic_usage: false,
            request_headers: incomingHeadersToRecord(request),
            request_body_text: bodyText,
            upstream_url: null,
            upstream_request_headers: null,
            response_headers: {
              "content-type": "application/json",
            },
            response_body_text: responseBodyText,
          });
          return;
        }
      }

      let forwardResult: ProxyForwardResult | null = null;
      if (pathname.startsWith("/backend-api/")) {
        forwardResult = await forwardChatGPTBackend({
          request,
          response,
          bodyText,
          pathname,
          search: requestUrl.search,
          store: options.store,
          fetchImpl,
        });
      } else if (pathname.startsWith("/v1/")) {
        forwardResult = await handleOpenAIRoute({
          request,
          response,
          bodyText,
          pathname,
          search: requestUrl.search,
          store: options.store,
          fetchImpl,
        });
      } else {
        const errorMessage = `Unknown proxy route: ${pathname}`;
        forwardResult = {
          statusCode: 404,
          responseBytes: writeError(response, 404, errorMessage),
          authKind: "unknown",
          selectedAccount: null,
          selectedAuthMode: null,
          upstreamKind: pathname.startsWith("/v1/") ? "openai" : "chatgpt",
          errorPayload: buildLocalErrorLogPayload({
            request,
            bodyText,
            responseBodyText: buildProxyErrorResponseText(errorMessage),
          }),
        };
      }

      const baseRequestPayload = {
        ts: new Date().toISOString(),
        request_id: requestId,
        pid: process.pid,
        method: request.method ?? "GET",
        route: pathname,
        surface: pathname.startsWith("/v1/") ? "v1" : "backend-api",
        auth_kind: forwardResult.authKind,
        selected_account_name: forwardResult.selectedAccount,
        selected_auth_mode: forwardResult.selectedAuthMode,
        upstream_kind: forwardResult.upstreamKind,
        request_speed: forwardResult.requestSpeed ?? resolveProxyRequestSpeedFromBodyText(bodyText),
        status_code: forwardResult.statusCode,
        duration_ms: Date.now() - startedAt,
        request_bytes: requestBytes,
        response_bytes: forwardResult.responseBytes,
        synthetic_usage: forwardResult.syntheticUsage ?? false,
      };
      await options.requestLogger?.({
        ...baseRequestPayload,
        ...(forwardResult.diagnostic ?? {}),
      });
      if (shouldRecordErrorPayload(forwardResult.statusCode) && forwardResult.errorPayload) {
        await options.errorRequestLogger?.({
          ...baseRequestPayload,
          ...(forwardResult.errorPayload ?? {}),
        });
      }
    })().catch((error) => {
      const errorMessage = (error as Error).message;
      options.debugLog?.(`proxy: request failed: ${errorMessage}`);
      const responseBodyText = response.headersSent ? "" : buildProxyErrorResponseText(errorMessage);
      const responseBytes = !response.headersSent
        ? writeError(response, 500, errorMessage)
        : 0;
      const basePayload = {
        ts: new Date().toISOString(),
        request_id: createRequestId(),
        pid: process.pid,
        method: request.method ?? "GET",
        route: normalizePathname(new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`).pathname),
        surface: String(request.url ?? "").startsWith("/v1/") ? "v1" : "backend-api",
        auth_kind: "unknown",
        selected_account_name: null,
        selected_auth_mode: null,
        upstream_kind: String(request.url ?? "").startsWith("/v1/") ? "openai" : "chatgpt",
        request_speed: resolveProxyRequestSpeedFromBodyText(requestBodyText),
        status_code: response.headersSent ? response.statusCode : 500,
        duration_ms: 0,
        request_bytes: 0,
        response_bytes: responseBytes,
        error_class: (error as Error).name,
        error_message_short: errorMessage,
      };
      void options.requestLogger?.(basePayload);
      void options.errorRequestLogger?.({
        ...basePayload,
        ...buildLocalErrorLogPayload({
          request,
          bodyText: requestBodyText,
          responseBodyText,
          responseHeaders: response.headersSent ? null : { "content-type": "application/json" },
        }),
      });
      if (!response.headersSent) {
        return;
      }
      response.end();
    });
  });

  const finalizeActiveTurn = async (
    context: ProxyWebSocketContext,
    payload: Record<string, unknown> | null,
    terminalStatusCode: number,
  ): Promise<void> => {
    const activeTurn = context.activeTurn;
    if (!activeTurn) {
      return;
    }

    const payloadResponse = payload?.response;
    const payloadResponseRecord = (
      typeof payloadResponse === "object"
      && payloadResponse !== null
      && !Array.isArray(payloadResponse)
    )
      ? payloadResponse as Record<string, unknown>
      : null;
    const responseId = typeof payloadResponseRecord?.id === "string"
      ? payloadResponseRecord.id
      : activeTurn.responseId;
    const outputItems = activeTurn.outputItems.length > 0
      ? activeTurn.outputItems
      : responseOutputItemsToConversationItems(payloadResponseRecord?.output);
    const normalizedOutputItems = outputItems.length > 0
      ? outputItems
      : (() => {
          const fallbackText = payloadResponseRecord ? extractResponseText(payloadResponseRecord) : "";
          return fallbackText === ""
            ? []
            : [{
                role: "assistant",
                content: [{ type: "output_text", text: fallbackText }],
              }];
        })();

    if (responseId) {
      context.historyByResponseId.set(responseId, {
        accountName: activeTurn.accountName,
        conversationItems: [
          ...cloneJsonValue(activeTurn.fullInput),
          ...cloneJsonValue(normalizedOutputItems),
        ],
      });
    }

    await options.requestLogger?.({
      ts: new Date().toISOString(),
      request_id: activeTurn.requestId,
      pid: process.pid,
      method: "WS",
      route: "/v1/responses",
      surface: "v1",
      auth_kind: context.downstreamAuthKind,
      selected_account_name: context.upstreamAccount?.account.name ?? activeTurn.accountName,
      selected_auth_mode: context.upstreamAccount?.account.auth_mode ?? "chatgpt",
      upstream_kind: "chatgpt",
      request_speed: activeTurn.requestSpeed,
      status_code: terminalStatusCode,
      duration_ms: Date.now() - activeTurn.startedAt,
      request_bytes: Buffer.byteLength(JSON.stringify({ input: activeTurn.fullInput })),
      response_bytes: payload ? Buffer.byteLength(JSON.stringify(payload)) : 0,
      synthetic_usage: false,
      replay_count: activeTurn.replayCount,
      replayed_from_account_names: activeTurn.replayedFromAccountNames,
    });

    context.activeTurn = null;
  };

  const flushBufferedTurnMessages = (activeTurn: ProxyActiveTurn, downstream: WebSocket) => {
    if (activeTurn.bufferedMessages.length === 0) {
      return;
    }

    if (downstream.readyState === WebSocket.OPEN) {
      for (const message of activeTurn.bufferedMessages) {
        downstream.send(message);
      }
    }
    activeTurn.bufferedMessages = [];
  };

  const ensureSyntheticUpstreamSocket = async (
    context: ProxyWebSocketContext,
    downstream: WebSocket,
    request: IncomingMessage,
    selected: ProxyUpstreamAccount,
  ) => {
    if (
      context.upstreamAccount?.account.name === selected.account.name
      && context.upstreamSocket
      && context.upstreamSocket.readyState === WebSocket.OPEN
    ) {
      return;
    }

    const previousUpstream = context.upstreamSocket;
    context.upstreamSocket = null;
    context.upstreamAccount = null;
    await closeProxyWebSocket(previousUpstream);
    context.upstreamAccount = selected;
    context.upstreamSocket = await openChatGPTUpstreamWebSocket({
      url: upstreamChatGPTWebSocketUrl(),
      headers: buildChatGPTWebSocketHeaders(request, selected),
      connectWebSocketImpl: options.connectWebSocketImpl,
    });
    trackProxySocket(context.upstreamSocket);
    attachUpstreamSocket(context, downstream, request);
  };

  const replayActiveTurnAfterQuotaFailure = async (
    context: ProxyWebSocketContext,
    downstream: WebSocket,
    request: IncomingMessage,
    payload: Record<string, unknown> | null,
    terminalStatusCode: number,
  ): Promise<boolean> => {
    const activeTurn = context.activeTurn;
    if (
      !activeTurn
      || activeTurn.replayLocked
      || activeTurn.replayCount >= 1
      || !isRetryableQuotaFailure(terminalStatusCode, payload)
    ) {
      return false;
    }

    const replaySelected = await selectProxyReplayAccount(
      options.store,
      "chatgpt",
      [...activeTurn.replayedFromAccountNames, activeTurn.accountName],
    );
    if (!replaySelected || replaySelected.account.name === activeTurn.accountName) {
      return false;
    }

    try {
      const rewrittenRequest = rewriteWebSocketCreateRequest({
        requestBody: cloneJsonValue(activeTurn.requestBody),
        selectedAccountName: replaySelected.account.name,
        historyByResponseId: context.historyByResponseId,
      });
      const finalRequestBody = maybeInjectFastServiceTier(rewrittenRequest.requestBody, replaySelected);
      const previousAccountName = activeTurn.accountName;

      await ensureSyntheticUpstreamSocket(context, downstream, request, replaySelected);
      await persistProxyUpstreamAccountSelection(options.store, replaySelected.account);
      activeTurn.accountName = replaySelected.account.name;
      activeTurn.bufferedMessages = [];
      activeTurn.fullInput = rewrittenRequest.fullInput;
      activeTurn.outputItems = [];
      activeTurn.replayLocked = false;
      activeTurn.replayCount += 1;
      activeTurn.replayedFromAccountNames = [...activeTurn.replayedFromAccountNames, previousAccountName];
      activeTurn.requestSpeed = resolveProxyRequestSpeed(finalRequestBody);
      activeTurn.responseId = null;
      context.upstreamSocket?.send(JSON.stringify(finalRequestBody));
      return true;
    } catch (error) {
      options.debugLog?.(`proxy websocket replay: ${(error as Error).message}`);
      return false;
    }
  };

  const handleUpstreamSocketMessage = async (
    context: ProxyWebSocketContext,
    downstream: WebSocket,
    request: IncomingMessage,
    data: RawData,
  ): Promise<void> => {
    const text = rawWebSocketDataToText(data);
    let payload: Record<string, unknown> | null = null;
    try {
      payload = parseWebSocketPayload(data);
    } catch {
      payload = null;
    }

    const payloadType = typeof payload?.type === "string" ? payload.type : null;
    if (payloadType === "response.created") {
      const payloadResponse = payload?.response;
      if (
        context.activeTurn
        && typeof payloadResponse === "object"
        && payloadResponse !== null
        && !Array.isArray(payloadResponse)
        && typeof (payloadResponse as Record<string, unknown>).id === "string"
      ) {
        context.activeTurn.responseId = (payloadResponse as Record<string, unknown>).id as string;
      }
    }

    if (payloadType === "response.output_item.done" && context.activeTurn && payload?.item !== undefined) {
      const conversationItem = normalizeResponseOutputItem(payload.item);
      if (conversationItem !== null) {
        context.activeTurn.outputItems.push(conversationItem);
      }
    }

    if (payloadType === "response.failed") {
      if (await replayActiveTurnAfterQuotaFailure(context, downstream, request, payload, 502)) {
        return;
      }
    } else if (payloadType === "error") {
      if (await replayActiveTurnAfterQuotaFailure(context, downstream, request, payload, 500)) {
        return;
      }
    }

    if (context.activeTurn && !context.activeTurn.replayLocked && shouldBufferProxyWebSocketPreludeEvent(payloadType, payload)) {
      context.activeTurn.bufferedMessages.push(text);
      return;
    }

    if (context.activeTurn && !context.activeTurn.replayLocked) {
      if (doesProxyWebSocketEventLockReplay(payloadType, payload)) {
        context.activeTurn.replayLocked = true;
      }
      flushBufferedTurnMessages(context.activeTurn, downstream);
    }
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.send(text);
    }

    if (payloadType === "response.completed" || payloadType === "response.done") {
      await finalizeActiveTurn(context, payload, 200);
      return;
    }

    if (payloadType === "response.failed") {
      await finalizeActiveTurn(context, payload, 502);
      return;
    }

    if (payloadType === "error") {
      await finalizeActiveTurn(context, payload, 500);
      context.activeTurn = null;
    }
  };

  const attachUpstreamSocket = (
    context: ProxyWebSocketContext,
    downstream: WebSocket,
    request: IncomingMessage,
  ) => {
    const upstream = context.upstreamSocket;
    if (!upstream) {
      return;
    }

    upstream.on("message", (data: RawData) => {
      void handleUpstreamSocketMessage(context, downstream, request, data).catch((error) => {
        options.debugLog?.(`proxy websocket upstream: ${(error as Error).message}`);
        if (downstream.readyState === WebSocket.OPEN) {
          downstream.close(1011, (error as Error).message);
        }
      });
    });

    upstream.on("close", () => {
      if (context.upstreamSocket !== upstream) {
        return;
      }

      context.upstreamSocket = null;
      context.upstreamAccount = null;
      context.activeTurn = null;
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close();
      }
    });

    upstream.on("error", () => {
      if (context.upstreamSocket !== upstream) {
        return;
      }

      context.upstreamSocket = null;
      context.upstreamAccount = null;
      context.activeTurn = null;
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close();
      }
    });
  };

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    const pathname = normalizePathname(requestUrl.pathname);
    if (pathname !== "/v1/responses") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (downstream) => {
      trackProxySocket(downstream);
      const authKind = requestAuthKindForOpenAIRoute(request);
      const context: ProxyWebSocketContext = {
        activeTurn: null,
        connectionRequestId: createRequestId(),
        downstreamAuthKind: authKind,
        historyByResponseId: new Map(),
        upstreamAccount: null,
        upstreamSocket: null,
      };

      void options.requestLogger?.({
        ts: new Date().toISOString(),
        request_id: context.connectionRequestId,
        pid: process.pid,
        method: "WS",
        route: pathname,
        surface: "v1",
        auth_kind: authKind,
        selected_account_name: null,
        selected_auth_mode: null,
        upstream_kind: "chatgpt",
        request_speed: "normal",
        status_code: 101,
        duration_ms: 0,
        request_bytes: 0,
        response_bytes: 0,
        synthetic_usage: false,
      });

      let processing = Promise.resolve();
      downstream.on("message", (data: RawData) => {
        processing = processing
          .then(async () => {
            const requestId = createRequestId();
            const rawText = rawWebSocketDataToText(data);
            const requestBody = parseWebSocketPayload(data);
            const requestType = typeof requestBody.type === "string" ? requestBody.type : null;

            if (context.downstreamAuthKind !== "synthetic-chatgpt") {
              const passthroughAuthKind: "direct-chatgpt" | "apikey" | "unknown" =
                context.downstreamAuthKind === "direct-chatgpt"
                  ? "direct-chatgpt"
                  : context.downstreamAuthKind === "apikey"
                    ? "apikey"
                    : "unknown";
              if (!context.upstreamSocket || context.upstreamSocket.readyState !== WebSocket.OPEN) {
                context.upstreamSocket = await openTransparentUpstreamWebSocket({
                  request,
                  authKind: passthroughAuthKind,
                  connectWebSocketImpl: options.connectWebSocketImpl,
                });
                trackProxySocket(context.upstreamSocket);
                attachUpstreamSocket(context, downstream, request);
              }

              context.upstreamSocket.send(rawText);
              await options.requestLogger?.({
                ts: new Date().toISOString(),
                request_id: requestId,
                pid: process.pid,
                method: "WS",
                route: pathname,
                surface: "v1",
                auth_kind: passthroughAuthKind,
                selected_account_name: null,
                selected_auth_mode: null,
                upstream_kind: passthroughAuthKind === "direct-chatgpt" ? "chatgpt" : "openai",
                request_speed: requestType === "response.create" ? resolveProxyRequestSpeed(requestBody) : "normal",
                status_code: 101,
                duration_ms: 0,
                request_bytes: Buffer.byteLength(rawText),
                response_bytes: 0,
                synthetic_usage: false,
              });
              return;
            }

            if (requestType !== "response.create") {
              if (!context.upstreamSocket || context.upstreamSocket.readyState !== WebSocket.OPEN) {
                throw new Error("No upstream websocket is available for this request.");
              }
              context.upstreamSocket.send(rawText);
              await options.requestLogger?.({
                ts: new Date().toISOString(),
                request_id: requestId,
                pid: process.pid,
                method: "WS",
                route: pathname,
                surface: "v1",
                auth_kind: context.downstreamAuthKind,
                selected_account_name: context.upstreamAccount?.account.name ?? null,
                selected_auth_mode: context.upstreamAccount?.account.auth_mode ?? null,
                upstream_kind: "chatgpt",
                request_speed: requestType === "response.create" ? resolveProxyRequestSpeed(requestBody) : "normal",
                status_code: 101,
                duration_ms: 0,
                request_bytes: Buffer.byteLength(rawText),
                response_bytes: 0,
                synthetic_usage: false,
              });
              return;
            }

            const selected = await selectProxyAccount(options.store, "chatgpt");
            if (!selected) {
              throw new Error("No eligible ChatGPT account is available for proxy websocket upstream.");
            }

            const rewrittenRequest = rewriteWebSocketCreateRequest({
              requestBody,
              selectedAccountName: selected.account.name,
              historyByResponseId: context.historyByResponseId,
            });
            const finalRequestBody = maybeInjectFastServiceTier(rewrittenRequest.requestBody, selected);
            await ensureSyntheticUpstreamSocket(context, downstream, request, selected);

            context.activeTurn = {
              accountName: selected.account.name,
              bufferedMessages: [],
              fullInput: rewrittenRequest.fullInput,
              outputItems: [],
              replayCount: 0,
              replayLocked: false,
              replayedFromAccountNames: [],
              requestBody: cloneJsonValue(requestBody),
              requestId,
              requestSpeed: resolveProxyRequestSpeed(finalRequestBody),
              responseId: null,
              startedAt: Date.now(),
            };
            const upstreamSocket = context.upstreamSocket;
            if (!upstreamSocket || upstreamSocket.readyState !== WebSocket.OPEN) {
              throw new Error("Synthetic proxy websocket upstream is not available.");
            }
            upstreamSocket.send(JSON.stringify(finalRequestBody));
          })
          .catch((error) => {
            options.debugLog?.(`proxy websocket: ${(error as Error).message}`);
            void options.requestLogger?.({
              ts: new Date().toISOString(),
              request_id: createRequestId(),
              pid: process.pid,
              method: "WS",
              route: pathname,
              surface: "v1",
              auth_kind: context.downstreamAuthKind,
              selected_account_name: context.upstreamAccount?.account.name ?? null,
              selected_auth_mode: context.upstreamAccount?.account.auth_mode ?? null,
              upstream_kind: "chatgpt",
              request_speed: "normal",
              status_code: 500,
              duration_ms: 0,
              request_bytes: 0,
              response_bytes: 0,
              synthetic_usage: false,
              error_class: (error as Error).name,
              error_message_short: (error as Error).message,
            });
            if (downstream.readyState === WebSocket.OPEN) {
              downstream.close(1011, (error as Error).message);
            }
          });
      });

      downstream.on("close", () => {
        void closeProxyWebSocket(context.upstreamSocket);
      });

      downstream.on("error", () => {
        void closeProxyWebSocket(context.upstreamSocket);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${resolvedPort}`;

  return {
    baseUrl,
    backendBaseUrl: `${baseUrl}/backend-api`,
    openaiBaseUrl: `${baseUrl}/v1`,
    close: async () => {
      for (const socket of activeProxySockets) {
        socket.terminate();
      }
      activeProxySockets.clear();
      await new Promise<void>((resolve) => {
        websocketServer.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
