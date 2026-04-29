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
  createProxyResponseId,
} from "./context.js";
import {
  cloneJsonValue,
  parseMaybeJson,
} from "./json.js";
import {
  buildRequestShapeWithoutInput,
  persistProxyResponseCheckpointFromTurn,
  rewriteEventResponseId,
  rewriteProxyCreateRequest,
  rewriteTopLevelResponseId,
} from "./replay.js";
import {
  buildProxyAccountCheckV4Payload,
  buildProxyAutoTopUpSettingsPayload,
  buildProxyUsagePayloadForStore,
  buildProxyWhamAccountsCheckPayloadForStore,
} from "./quota.js";
import {
  canonicalOutputItemsFromResponsePayload,
  chatCompletionToResponsesBody,
  completionToResponsesBody,
  normalizeResponseOutputItem,
  normalizeResponsesInput,
  normalizeResponsesRequestBody,
  normalizeWebSocketInput,
  normalizeWebSocketResponsesCreateRequestBody,
  parseResponsePayloadFromSse,
  parseWebSocketPayload,
  rawWebSocketDataToText,
  responseOutputItemsToConversationItems,
  responsesPayloadToChatCompletion,
  responsesPayloadToCompletion,
} from "./responses-adapter.js";
import {
  hasExhaustedRateLimitSignal,
  hasQuotaExhaustionSignal,
} from "../quota-exhaustion-signals.js";
import {
  buildLocalErrorLogPayload,
  buildProxyErrorResponseText,
  buildRequestResponseLogPayload,
  incomingHeadersToRecord,
  normalizePathname,
  outgoingHeadersToRecord,
  parseJsonBody,
  readRequestBody,
  requestHeadersToFetchHeaders,
  requestHeadersToWebSocketHeaders,
  shouldCaptureDiagnosticPayload,
  shouldRecordErrorPayload,
  upstreamResponseHeadersToRecord,
  writeBufferedResponse,
  writeError,
  writeJson,
  writeUpstreamResponseWithLogging,
} from "./http.js";

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
  serviceTier?: ProxyServiceTier;
  syntheticUsage?: boolean;
  diagnostic?: Record<string, unknown>;
  errorPayload?: Record<string, unknown>;
}

interface ProxyActiveTurn {
  accountName: string;
  bufferedMessages: string[];
  chainId: string;
  fullInput: unknown[];
  outputItems: unknown[];
  parentProxyResponseId: string | null;
  proxyResponseId: string;
  replayAttempted: boolean;
  replayCount: number;
  replayLocked: boolean;
  replayLockedByItemType: string | null;
  replayLockedByType: string | null;
  replaySkipReason: ProxyReplaySkipReason | null;
  replayedFromAccountNames: string[];
  requestBody: Record<string, unknown>;
  requestShapeWithoutInput: Record<string, unknown>;
  requestId: string;
  serviceTier: ProxyServiceTier;
  responseId: string | null;
  startedAt: number;
}

interface ProxyWebSocketContext {
  activeTurn: ProxyActiveTurn | null;
  connectionRequestId: string;
  downstreamAuthKind: string;
  upstreamAccount: ProxyUpstreamAccount | null;
  upstreamSocket: WebSocket | null;
}

type ProxyServiceTier = "default" | "priority";
type ProxyReplaySkipReason =
  | "already_replayed"
  | "no_replay_candidate"
  | "not_retryable_quota_failure"
  | "previous_response_id"
  | "replay_locked"
  | "replay_upstream_error"
  | "same_account_only";

interface ProxyReplayDiagnostic {
  replayAttempted: boolean;
  replayCount: number;
  replayLockedByItemType: string | null;
  replayLockedByType: string | null;
  replaySkipReason: ProxyReplaySkipReason | null;
  replayedFromAccountNames: string[];
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
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
  const allAccounts = accounts;
  const eligibleAccounts = accounts.filter((account) => account.auto_switch_eligible !== false);
  const excludedNames = new Set(options.excludeAccountNames ?? []);
  const allAccountByName = new Map(allAccounts.map((account) => [account.name, account] as const));
  const allQuotaByName = new Map(
    quotaList.accounts.map((account) => [account.name, account] as const),
  );
  const eligibleAccountByName = new Map(eligibleAccounts.map((account) => [account.name, account] as const));
  const eligibleQuotaByName = new Map(
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
    : await resolveProxyManualUpstreamAccountName(store, allAccounts);
  if (manualAccountName && !excludedNames.has(manualAccountName)) {
    const selectedAccount = allAccountByName.get(manualAccountName) ?? null;
    if (!selectedAccount || !typeMatches(selectedAccount)) {
      return null;
    }

    const selectedQuota = allQuotaByName.get(manualAccountName) ?? null;
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
    const selectedAccount = selectedName ? eligibleAccountByName.get(selectedName) ?? null : null;
    if (!selectedAccount) {
      return null;
    }

    const selectedQuota = selectedName ? eligibleQuotaByName.get(selectedName) ?? null : null;
    const selectedCandidate = selectedQuota
      ? rankAutoSwitchCandidates([selectedQuota]).find((candidate) => candidate.name === selectedName) ?? null
      : null;
    return await toProxyUpstreamAccount(selectedAccount, selectedCandidate);
  }

  const rankedCandidates = rankAutoSwitchCandidates([...eligibleQuotaByName.values()])
    .filter((candidate) => {
      const account = eligibleAccountByName.get(candidate.name);
      return account ? typeMatches(account) && !excludedNames.has(candidate.name) : false;
    });
  const rankedCandidateByName = new Map(rankedCandidates.map((candidate) => [candidate.name, candidate] as const));
  const selectedName = [...rankedCandidates.map((candidate) => candidate.name), ...matchingFallbackNames][0];
  const selectedAccount = selectedName ? eligibleAccountByName.get(selectedName) ?? null : null;
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

function buildChatGPTBackendHeaders(request: IncomingMessage, selected: ProxyUpstreamAccount | null): Headers {
  if (!selected) {
    return requestHeadersToFetchHeaders(request, {
      "accept-encoding": "identity",
    });
  }

  const auth = extractChatGPTAuth(selected.snapshot);
  return requestHeadersToFetchHeaders(request, {
    authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
    "accept-encoding": "identity",
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

function resolveProxyServiceTier(body: Record<string, unknown> | null | undefined): ProxyServiceTier {
  return body?.service_tier === "priority" ? "priority" : "default";
}

function resolveProxyServiceTierFromBodyText(bodyText: string): ProxyServiceTier {
  try {
    return resolveProxyServiceTier(parseJsonBody(bodyText));
  } catch {
    return "default";
  }
}

function isRetryableQuotaFailure(statusCode: number, payload: unknown): boolean {
  if (hasQuotaExhaustionSignal(payload)) {
    return true;
  }

  return statusCode === 429 && hasExhaustedRateLimitSignal(payload);
}

function resolveProxyTerminalStatusCode(
  fallbackStatusCode: number,
  payload: Record<string, unknown> | null,
): number {
  if (payload && Number.isInteger(payload.status)) {
    return payload.status as number;
  }

  if (payload && Number.isInteger(payload.status_code)) {
    return payload.status_code as number;
  }

  const error = payload?.error;
  if (
    typeof error === "object"
    && error !== null
    && !Array.isArray(error)
    && Number.isInteger((error as Record<string, unknown>).status)
  ) {
    return (error as Record<string, unknown>).status as number;
  }

  if (
    typeof error === "object"
    && error !== null
    && !Array.isArray(error)
    && Number.isInteger((error as Record<string, unknown>).status_code)
  ) {
    return (error as Record<string, unknown>).status_code as number;
  }

  return fallbackStatusCode;
}

function toProxyReplayDiagnostic(options: {
  replayAttempted?: boolean;
  replayCount: number;
  replayLockedByItemType?: string | null;
  replayLockedByType?: string | null;
  replaySkipReason?: ProxyReplaySkipReason | null;
  replayedFromAccountNames: string[];
}): Record<string, unknown> {
  return {
    replay_attempted: options.replayAttempted ?? false,
    replay_count: options.replayCount,
    replay_locked_by_item_type: options.replayLockedByItemType ?? null,
    replay_locked_by_type: options.replayLockedByType ?? null,
    replay_skip_reason: options.replaySkipReason ?? null,
    replay_succeeded: options.replayCount > 0,
    replayed_from_account_names: options.replayedFromAccountNames,
  };
}

function buildProxyReplayDiagnostic(options: {
  replayAttempted?: boolean;
  replayCount: number;
  replayLockedByItemType?: string | null;
  replayLockedByType?: string | null;
  replaySkipReason?: ProxyReplaySkipReason | null;
  replayedFromAccountNames: string[];
}): ProxyReplayDiagnostic {
  return {
    replayAttempted: options.replayAttempted ?? false,
    replayCount: options.replayCount,
    replayLockedByItemType: options.replayLockedByItemType ?? null,
    replayLockedByType: options.replayLockedByType ?? null,
    replaySkipReason: options.replaySkipReason ?? null,
    replayedFromAccountNames: options.replayedFromAccountNames,
  };
}

function inferNormalizedOutputItemType(item: unknown): string | null {
  return typeof item === "object"
    && item !== null
    && !Array.isArray(item)
    && typeof (item as Record<string, unknown>).type === "string"
    ? (item as Record<string, unknown>).type as string
    : null;
}

function describeProxyWebSocketReplayLock(
  payloadType: string | null,
  payload: Record<string, unknown> | null,
): {
  locked: boolean;
  itemType: string | null;
  type: string | null;
} {
  if (payloadType === null) {
    return {
      locked: true,
      itemType: null,
      type: "unknown_non_json_frame",
    };
  }

  if (payloadType === "response.output_text.delta") {
    return {
      locked: typeof payload?.delta === "string" && payload.delta !== "",
      itemType: null,
      type: payloadType,
    };
  }

  if (payloadType === "response.output_text.done") {
    return {
      locked: typeof payload?.text === "string" && payload.text !== "",
      itemType: null,
      type: payloadType,
    };
  }

  if (payloadType === "response.output_item.done" && payload?.item !== undefined) {
    const normalized = normalizeResponseOutputItem(payload.item);
    return {
      locked: normalized !== null,
      itemType: inferNormalizedOutputItemType(normalized) ?? inferNormalizedOutputItemType(payload.item),
      type: payloadType,
    };
  }

  return {
    locked: false,
    itemType: null,
    type: payloadType,
  };
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
  return describeProxyWebSocketReplayLock(payloadType, payload).locked;
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
    ? buildChatGPTBackendHeaders(options.request, selected)
    : buildChatGPTBackendHeaders(options.request, null);

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
  const contentEncoding = upstream.headers.get("content-encoding")?.toLowerCase() ?? "";
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
      payload: {
        detail: contentEncoding
          ? `Upstream response could not be decoded as JSON (content-encoding: ${contentEncoding}).`
          : bodyText,
      },
      responseHeaders,
    };
  }
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
  store: AccountStore | null;
  fetchImpl: typeof fetch;
  headers: Headers;
  authKind: "direct-chatgpt" | "synthetic-chatgpt";
  selected: ProxyUpstreamAccount | null;
}): Promise<ProxyForwardResult> {
  if (options.authKind === "synthetic-chatgpt" && options.selected && options.store && options.bodyText.trim() !== "") {
    let parsedBody: Record<string, unknown> | null = null;
    try {
      parsedBody = parseJsonBody(options.bodyText);
    } catch {
      parsedBody = null;
    }
    if (parsedBody) {
      const replayed = await fetchSyntheticChatGPTRawJsonPayloadWithReplay({
        request: options.request,
        store: options.store,
        selected: options.selected,
        fetchImpl: options.fetchImpl,
        pathname: options.pathname,
        search: options.search,
        buildRequestBody: (selected) => maybeInjectFastServiceTier(cloneJsonValue(parsedBody), selected),
      });
      const responseBytes = writeJson(
        options.response,
        replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
        replayed.payload,
      );
      return {
        statusCode: replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
        responseBytes,
        authKind: options.authKind,
        selectedAccount: replayed.selected.account.name,
        selectedAuthMode: replayed.selected.account.auth_mode,
        upstreamKind: "chatgpt",
        serviceTier: replayed.serviceTier,
        diagnostic: toProxyReplayDiagnostic(replayed.replay),
        errorPayload: replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300
          ? undefined
          : {
              ...buildRequestResponseLogPayload({
                request: options.request,
                bodyText: options.bodyText,
                upstreamUrl: toChatGPTCodexUrl(options.pathname, options.search),
                upstreamRequestHeaders: buildChatGPTAuthHeaders(options.request, replayed.selected),
                responseHeaders: replayed.responseHeaders,
                responseBodyText: replayed.responseBodyText,
              }),
              ...toProxyReplayDiagnostic(replayed.replay),
            },
      };
    }
  }

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
        serviceTier: resolveProxyServiceTier(requestBody),
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
      serviceTier: resolveProxyServiceTier(requestBody),
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
      serviceTier: resolveProxyServiceTier(requestBody),
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
      serviceTier: resolveProxyServiceTier(requestBody),
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
    store: null,
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

function hasUpstreamPreviousResponseId(pathname: string, body: Record<string, unknown>): boolean {
  return pathname === "/v1/responses" && typeof body.previous_response_id === "string";
}

interface ProxyBufferedReplayResult {
  payload: unknown;
  replay: ProxyReplayDiagnostic;
  serviceTier: ProxyServiceTier;
  selected: ProxyUpstreamAccount;
  upstreamStatus: number;
  responseHeaders: Record<string, string>;
  responseBodyText: string;
}

async function fetchSyntheticChatGPTBufferedPayloadWithReplay(options: {
  request: IncomingMessage;
  store: AccountStore;
  selected: ProxyUpstreamAccount;
  fetchImpl: typeof fetch;
  buildRequestBody: (selected: ProxyUpstreamAccount) => Record<string, unknown>;
}): Promise<ProxyBufferedReplayResult> {
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
        replay: buildProxyReplayDiagnostic({
          replayAttempted: replayedFromAccountNames.length > 0 || isRetryableQuotaFailure(upstream.status, payload),
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: isRetryableQuotaFailure(upstream.status, payload) && replayedFromAccountNames.length >= 1
            ? "already_replayed"
            : null,
          replayedFromAccountNames,
        }),
        serviceTier: resolveProxyServiceTier(requestBody),
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
        replay: buildProxyReplayDiagnostic({
          replayAttempted: true,
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: replaySelected ? "same_account_only" : "no_replay_candidate",
          replayedFromAccountNames,
        }),
        serviceTier: resolveProxyServiceTier(requestBody),
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

async function fetchSyntheticChatGPTRawJsonPayloadWithReplay(options: {
  request: IncomingMessage;
  store: AccountStore;
  selected: ProxyUpstreamAccount;
  fetchImpl: typeof fetch;
  pathname: string;
  search: string;
  buildRequestBody: (selected: ProxyUpstreamAccount) => Record<string, unknown>;
}): Promise<ProxyBufferedReplayResult> {
  let selected = options.selected;
  const replayedFromAccountNames: string[] = [];
  const attemptedAccountNames = new Set<string>();

  while (true) {
    attemptedAccountNames.add(selected.account.name);
    const requestBody = options.buildRequestBody(selected);
    const upstreamUrl = toChatGPTCodexUrl(options.pathname, options.search);
    const upstream = await options.fetchImpl(
      upstreamUrl,
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
        replay: buildProxyReplayDiagnostic({
          replayAttempted: replayedFromAccountNames.length > 0 || isRetryableQuotaFailure(upstream.status, payload),
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: isRetryableQuotaFailure(upstream.status, payload) && replayedFromAccountNames.length >= 1
            ? "already_replayed"
            : null,
          replayedFromAccountNames,
        }),
        serviceTier: resolveProxyServiceTier(requestBody),
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
        replay: buildProxyReplayDiagnostic({
          replayAttempted: true,
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: replaySelected ? "same_account_only" : "no_replay_candidate",
          replayedFromAccountNames,
        }),
        serviceTier: resolveProxyServiceTier(requestBody),
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

interface PreparedSyntheticResponsesTurn {
  chainId: string;
  fullInput: unknown[];
  parentProxyResponseId: string | null;
  proxyResponseId: string;
  requestBody: Record<string, unknown>;
  requestShapeWithoutInput: Record<string, unknown>;
}

async function prepareSyntheticResponsesTurn(options: {
  body: Record<string, unknown>;
  selected: ProxyUpstreamAccount;
  store: AccountStore;
}): Promise<PreparedSyntheticResponsesTurn> {
  const baseRequestBody = maybeInjectFastServiceTier(normalizeResponsesRequestBody(options.body), options.selected);
  const rewritten = await rewriteProxyCreateRequest({
    store: options.store,
    requestBody: baseRequestBody,
    selectedAccountName: options.selected.account.name,
    normalizeInput: normalizeResponsesInput,
  });
  return {
    chainId: rewritten.chainId,
    fullInput: rewritten.fullInput,
    parentProxyResponseId: rewritten.parentProxyResponseId,
    proxyResponseId: createProxyResponseId(),
    requestBody: rewritten.requestBody,
    requestShapeWithoutInput: rewritten.requestShapeWithoutInput,
  };
}

interface ProxySyntheticResponsesReplayResult {
  payload: unknown;
  replay: ProxyReplayDiagnostic;
  selected: ProxyUpstreamAccount;
  turn: PreparedSyntheticResponsesTurn;
  upstreamStatus: number;
  responseHeaders: Record<string, string>;
  responseBodyText: string;
}

async function fetchSyntheticResponsesPayloadWithReplay(options: {
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
  request: IncomingMessage;
  selected: ProxyUpstreamAccount;
  store: AccountStore;
}): Promise<ProxySyntheticResponsesReplayResult> {
  let selected = options.selected;
  const replayedFromAccountNames: string[] = [];
  const attemptedAccountNames = new Set<string>();

  while (true) {
    attemptedAccountNames.add(selected.account.name);
    const turn = await prepareSyntheticResponsesTurn({
      body: options.body,
      selected,
      store: options.store,
    });
    const upstream = await options.fetchImpl(
      `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`,
      {
        method: options.request.method ?? "POST",
        headers: buildChatGPTAuthHeaders(options.request, selected),
        body: JSON.stringify(turn.requestBody),
      },
    );
    const buffered = await readBufferedJsonPayload(upstream);
    const payload = buffered.payload;
    if (!isRetryableQuotaFailure(upstream.status, payload) || replayedFromAccountNames.length >= 1) {
      return {
        payload,
        replay: buildProxyReplayDiagnostic({
          replayAttempted: replayedFromAccountNames.length > 0 || isRetryableQuotaFailure(upstream.status, payload),
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: isRetryableQuotaFailure(upstream.status, payload) && replayedFromAccountNames.length >= 1
            ? "already_replayed"
            : null,
          replayedFromAccountNames,
        }),
        selected,
        turn,
        upstreamStatus: upstream.status,
        responseHeaders: buffered.responseHeaders,
        responseBodyText: buffered.bodyText,
      };
    }

    const replaySelected = await selectProxyReplayAccount(options.store, "chatgpt", attemptedAccountNames);
    if (!replaySelected || replaySelected.account.name === selected.account.name) {
      return {
        payload,
        replay: buildProxyReplayDiagnostic({
          replayAttempted: true,
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: replaySelected ? "same_account_only" : "no_replay_candidate",
          replayedFromAccountNames,
        }),
        selected,
        turn,
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

function findSseFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) {
    return crlf;
  }
  if (crlf === -1) {
    return lf;
  }
  return Math.min(lf, crlf);
}

function rewriteSseFramePayload(frame: string, proxyResponseId: string): {
  originalPayload: Record<string, unknown> | null;
  rawFrame: string;
  payload: Record<string, unknown> | null;
} {
  const lines = frame.split(/\r?\n/u);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    return { originalPayload: null, rawFrame: `${frame}\n\n`, payload: null };
  }
  const payloadText = dataLines.join("\n").trim();
  if (payloadText === "" || payloadText === "[DONE]") {
    return { originalPayload: null, rawFrame: `${frame}\n\n`, payload: null };
  }
  try {
    const payload = parseMaybeJson(payloadText);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { originalPayload: null, rawFrame: `${frame}\n\n`, payload: null };
    }
    const rewritten = rewriteEventResponseId(payload as Record<string, unknown>, proxyResponseId);
    return {
      originalPayload: payload as Record<string, unknown>,
      rawFrame: `data: ${JSON.stringify(rewritten)}\n\n`,
      payload: rewritten,
    };
  } catch {
    return { originalPayload: null, rawFrame: `${frame}\n\n`, payload: null };
  }
}

async function writeSyntheticResponsesEventStream(options: {
  request: IncomingMessage;
  response: ServerResponse;
  store: AccountStore;
  turn: PreparedSyntheticResponsesTurn;
  accountName: string;
  upstream: Response;
}): Promise<number> {
  const headers = upstreamResponseHeadersToRecord(options.upstream);
  options.response.writeHead(options.upstream.status, headers);
  if (!options.upstream.body) {
    options.response.end();
    return 0;
  }

  const decoder = new TextDecoder();
  const reader = options.upstream.body.getReader();
  let buffer = "";
  let totalBytes = 0;
  let upstreamResponseId: string | null = null;
  const outputItems: unknown[] = [];
  let terminalResponse: Record<string, unknown> | null = null;
  let sawCompleted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = findSseFrameBoundary(buffer);
        if (boundary === -1) {
          break;
        }
        const separatorLength = buffer.slice(boundary, boundary + 4) === "\r\n\r\n" ? 4 : 2;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        const rewritten = rewriteSseFramePayload(frame, options.turn.proxyResponseId);
        if (rewritten.payload) {
          const payloadType = typeof rewritten.payload.type === "string" ? rewritten.payload.type : null;
          const payloadResponse = rewritten.payload.response;
          const originalPayloadResponse = rewritten.originalPayload?.response;
          if (
            payloadType === "response.created"
            && typeof originalPayloadResponse === "object"
            && originalPayloadResponse !== null
            && !Array.isArray(originalPayloadResponse)
            && typeof (originalPayloadResponse as Record<string, unknown>).id === "string"
          ) {
            upstreamResponseId = (originalPayloadResponse as Record<string, unknown>).id as string;
          }
          if (payloadType === "response.output_item.done" && rewritten.payload.item !== undefined) {
            const conversationItem = normalizeResponseOutputItem(rewritten.payload.item);
            if (conversationItem !== null) {
              outputItems.push(conversationItem);
            }
          }
          if (
            (payloadType === "response.completed" || payloadType === "response.done")
            && typeof payloadResponse === "object"
            && payloadResponse !== null
            && !Array.isArray(payloadResponse)
          ) {
            sawCompleted = true;
            terminalResponse = payloadResponse as Record<string, unknown>;
          }
        }
        totalBytes += Buffer.byteLength(rewritten.rawFrame);
        options.response.write(rewritten.rawFrame);
      }
    }

    buffer += decoder.decode();
    if (buffer !== "") {
      const rewritten = rewriteSseFramePayload(buffer, options.turn.proxyResponseId);
      if (rewritten.payload) {
        const payloadType = typeof rewritten.payload.type === "string" ? rewritten.payload.type : null;
        const payloadResponse = rewritten.payload.response;
        const originalPayloadResponse = rewritten.originalPayload?.response;
        if (
          payloadType === "response.created"
          && typeof originalPayloadResponse === "object"
          && originalPayloadResponse !== null
          && !Array.isArray(originalPayloadResponse)
          && typeof (originalPayloadResponse as Record<string, unknown>).id === "string"
        ) {
          upstreamResponseId = (originalPayloadResponse as Record<string, unknown>).id as string;
        }
        if (
          (payloadType === "response.completed" || payloadType === "response.done")
          && typeof payloadResponse === "object"
          && payloadResponse !== null
          && !Array.isArray(payloadResponse)
        ) {
          sawCompleted = true;
          terminalResponse = payloadResponse as Record<string, unknown>;
        }
      }
      totalBytes += Buffer.byteLength(rewritten.rawFrame);
      options.response.write(rewritten.rawFrame);
    }

    options.response.end();
  } finally {
    reader.releaseLock();
  }

  if (sawCompleted) {
    await persistProxyResponseCheckpointFromTurn({
      store: options.store,
      chainId: options.turn.chainId,
      accountName: options.accountName,
      fullInput: options.turn.fullInput,
      outputItems: outputItems.length > 0 ? outputItems : canonicalOutputItemsFromResponsePayload(terminalResponse),
      parentProxyResponseId: options.turn.parentProxyResponseId,
      proxyResponseId: options.turn.proxyResponseId,
      requestShapeWithoutInput: options.turn.requestShapeWithoutInput,
      upstreamResponseId,
    });
  }

  return totalBytes;
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
        serviceTier: resolveProxyServiceTier(parsedBody),
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
        serviceTier: resolveProxyServiceTier(parsedBody),
        diagnostic: toProxyReplayDiagnostic({
          replayAttempted: replayedFromAccountNames.length > 0 || isRetryableQuotaFailure(upstream.status, buffered.payload),
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: isRetryableQuotaFailure(upstream.status, buffered.payload) && replayedFromAccountNames.length >= 1
            ? "already_replayed"
            : null,
          replayedFromAccountNames,
        }),
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
              ...toProxyReplayDiagnostic({
                replayAttempted: replayedFromAccountNames.length > 0 || isRetryableQuotaFailure(upstream.status, buffered.payload),
                replayCount: replayedFromAccountNames.length,
                replaySkipReason: isRetryableQuotaFailure(upstream.status, buffered.payload) && replayedFromAccountNames.length >= 1
                  ? "already_replayed"
                  : null,
                replayedFromAccountNames,
              }),
            },
      };
    }

    if (hasUpstreamPreviousResponseId(options.pathname, parsedBody)) {
      const diagnostic = toProxyReplayDiagnostic({
        replayAttempted: true,
        replayCount: replayedFromAccountNames.length,
        replaySkipReason: "previous_response_id",
        replayedFromAccountNames,
      });
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
        serviceTier: resolveProxyServiceTier(parsedBody),
        diagnostic,
        errorPayload: {
          ...buildRequestResponseLogPayload({
            request: options.request,
            bodyText: options.bodyText,
            upstreamUrl,
            upstreamRequestHeaders: outgoingHeaders,
            responseHeaders: buffered.responseHeaders,
            responseBodyText: buffered.bodyText,
          }),
          ...diagnostic,
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
        serviceTier: resolveProxyServiceTier(parsedBody),
        diagnostic: toProxyReplayDiagnostic({
          replayAttempted: true,
          replayCount: replayedFromAccountNames.length,
          replaySkipReason: replaySelected ? "same_account_only" : "no_replay_candidate",
          replayedFromAccountNames,
        }),
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
      const turn = await prepareSyntheticResponsesTurn({
        body,
        selected: options.selected,
        store: options.store,
      });
      const upstreamUrl = `${CHATGPT_UPSTREAM_BASE_URL}/backend-api/codex/responses`;
      const outgoingHeaders = buildChatGPTAuthHeaders(options.request, options.selected);
      const upstream = await options.fetchImpl(
        upstreamUrl,
        {
          method: options.request.method ?? "POST",
          headers: outgoingHeaders,
          body: JSON.stringify(turn.requestBody),
        },
      );
      const logged = upstream.ok
        ? null
        : await writeUpstreamResponseWithLogging({
            request: options.request,
            response: options.response,
            bodyText: options.bodyText,
            upstream,
            upstreamUrl,
            upstreamRequestHeaders: outgoingHeaders,
          });
      const responseBytes = upstream.ok
        ? await writeSyntheticResponsesEventStream({
            request: options.request,
            response: options.response,
            store: options.store,
            turn,
            accountName: options.selected.account.name,
            upstream,
          })
        : (logged?.responseBytes ?? 0);
      return {
        statusCode: upstream.status,
        responseBytes,
        authKind: "synthetic-chatgpt",
        selectedAccount: options.selected.account.name,
        selectedAuthMode: options.selected.account.auth_mode,
        upstreamKind: "chatgpt",
        serviceTier: resolveProxyServiceTier(turn.requestBody),
        errorPayload: logged?.errorPayload,
      };
    }

    const replayed = await fetchSyntheticResponsesPayloadWithReplay({
      body,
      fetchImpl: options.fetchImpl,
      request: options.request,
      store: options.store,
      selected: options.selected,
    });
    const rewrittenPayload = rewriteTopLevelResponseId(replayed.payload, replayed.turn.proxyResponseId);
    if (replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300) {
      await persistProxyResponseCheckpointFromTurn({
        store: options.store,
        chainId: replayed.turn.chainId,
        accountName: replayed.selected.account.name,
        fullInput: replayed.turn.fullInput,
        outputItems: canonicalOutputItemsFromResponsePayload(replayed.payload),
        parentProxyResponseId: replayed.turn.parentProxyResponseId,
        proxyResponseId: replayed.turn.proxyResponseId,
        requestShapeWithoutInput: replayed.turn.requestShapeWithoutInput,
        upstreamResponseId:
          typeof replayed.payload === "object"
          && replayed.payload !== null
          && !Array.isArray(replayed.payload)
          && typeof (replayed.payload as Record<string, unknown>).id === "string"
            ? (replayed.payload as Record<string, unknown>).id as string
            : null,
      });
    }
    const responseBytes = writeJson(
      options.response,
      replayed.upstreamStatus >= 200 && replayed.upstreamStatus < 300 ? 200 : replayed.upstreamStatus,
      rewrittenPayload,
    );
    return {
      statusCode: replayed.upstreamStatus,
      responseBytes,
      authKind: "synthetic-chatgpt",
      selectedAccount: replayed.selected.account.name,
      selectedAuthMode: replayed.selected.account.auth_mode,
      upstreamKind: "chatgpt",
      serviceTier: resolveProxyServiceTier(replayed.turn.requestBody),
      diagnostic: toProxyReplayDiagnostic(replayed.replay),
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
            ...toProxyReplayDiagnostic(replayed.replay),
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
      serviceTier: replayed.serviceTier,
      diagnostic: toProxyReplayDiagnostic(replayed.replay),
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
            ...toProxyReplayDiagnostic(replayed.replay),
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
      serviceTier: replayed.serviceTier,
      diagnostic: toProxyReplayDiagnostic(replayed.replay),
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
            ...toProxyReplayDiagnostic(replayed.replay),
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
    store: options.store,
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
    let requestBytes = 0;
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
      const pathname = normalizePathname(requestUrl.pathname);
      const { bodyText, rawBytes } = await readRequestBody(request);
      requestBodyText = bodyText;
      requestBytes = rawBytes;
      const startedAt = Date.now();
      const requestId = createRequestId();
      options.debugLog?.(`proxy: ${request.method ?? "GET"} ${pathname}`);

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
            service_tier: "default",
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
            service_tier: "default",
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
            service_tier: "default",
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
            service_tier: "default",
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
            service_tier: "default",
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
        service_tier: forwardResult.serviceTier ?? resolveProxyServiceTierFromBodyText(bodyText),
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
        service_tier: resolveProxyServiceTierFromBodyText(requestBodyText),
        status_code: response.headersSent ? response.statusCode : 500,
        duration_ms: 0,
        request_bytes: requestBytes,
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
      : canonicalOutputItemsFromResponsePayload(payloadResponseRecord);

    await persistProxyResponseCheckpointFromTurn({
      store: options.store,
      chainId: activeTurn.chainId,
      accountName: activeTurn.accountName,
      fullInput: activeTurn.fullInput,
      outputItems: normalizedOutputItems,
      parentProxyResponseId: activeTurn.parentProxyResponseId,
      proxyResponseId: activeTurn.proxyResponseId,
      requestShapeWithoutInput: activeTurn.requestShapeWithoutInput,
      upstreamResponseId: responseId,
    });

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
      service_tier: activeTurn.serviceTier,
      status_code: terminalStatusCode,
      duration_ms: Date.now() - activeTurn.startedAt,
      request_bytes: Buffer.byteLength(JSON.stringify(activeTurn.requestBody)),
      response_bytes: payload ? Buffer.byteLength(JSON.stringify(rewriteEventResponseId(payload, activeTurn.proxyResponseId))) : 0,
      synthetic_usage: false,
      ...toProxyReplayDiagnostic({
        replayAttempted: activeTurn.replayAttempted,
        replayCount: activeTurn.replayCount,
        replayLockedByItemType: activeTurn.replayLockedByItemType,
        replayLockedByType: activeTurn.replayLockedByType,
        replaySkipReason: activeTurn.replaySkipReason,
        replayedFromAccountNames: activeTurn.replayedFromAccountNames,
      }),
    });

    context.activeTurn = null;
  };

  const recordWebSocketTerminalError = async (
    context: ProxyWebSocketContext,
    request: IncomingMessage,
    payload: Record<string, unknown> | null,
    terminalStatusCode: number,
  ): Promise<void> => {
    const activeTurn = context.activeTurn;
    if (!activeTurn || !shouldRecordErrorPayload(terminalStatusCode)) {
      return;
    }

    const selected = context.upstreamAccount;
    const requestBodyText = JSON.stringify(activeTurn.requestBody);
    const responseBodyText = payload ? JSON.stringify(payload) : "";
    await options.errorRequestLogger?.({
      ts: new Date().toISOString(),
      request_id: activeTurn.requestId,
      pid: process.pid,
      method: "WS",
      route: "/v1/responses",
      surface: "v1",
      auth_kind: context.downstreamAuthKind,
      selected_account_name: selected?.account.name ?? activeTurn.accountName,
      selected_auth_mode: selected?.account.auth_mode ?? "chatgpt",
      upstream_kind: "chatgpt",
      service_tier: activeTurn.serviceTier,
      status_code: terminalStatusCode,
      duration_ms: Date.now() - activeTurn.startedAt,
      request_bytes: Buffer.byteLength(requestBodyText),
      response_bytes: Buffer.byteLength(responseBodyText),
      synthetic_usage: false,
      ...buildRequestResponseLogPayload({
        request,
        bodyText: requestBodyText,
        upstreamUrl: upstreamChatGPTWebSocketUrl(),
        upstreamRequestHeaders: selected ? outgoingHeadersToRecord(buildChatGPTWebSocketHeaders(request, selected)) : null,
        responseHeaders: null,
        responseBodyText,
      }),
    });
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
    if (!activeTurn) {
      return false;
    }

    if (!isRetryableQuotaFailure(terminalStatusCode, payload)) {
      return false;
    }
    activeTurn.replayAttempted = true;

    if (activeTurn.replayLocked) {
      activeTurn.replaySkipReason = "replay_locked";
      return false;
    }

    if (activeTurn.replayCount >= 1) {
      activeTurn.replaySkipReason = "already_replayed";
      return false;
    }

    const replaySelected = await selectProxyReplayAccount(
      options.store,
      "chatgpt",
      [...activeTurn.replayedFromAccountNames, activeTurn.accountName],
    );
    if (!replaySelected) {
      activeTurn.replaySkipReason = "no_replay_candidate";
      return false;
    }
    if (replaySelected.account.name === activeTurn.accountName) {
      activeTurn.replaySkipReason = "same_account_only";
      return false;
    }

    try {
      const replayRequestBody = {
        ...cloneJsonValue(activeTurn.requestBody),
        input: cloneJsonValue(activeTurn.fullInput),
      } as Record<string, unknown>;
      delete replayRequestBody.previous_response_id;
      const finalRequestBody = maybeInjectFastServiceTier(replayRequestBody, replaySelected);
      const previousAccountName = activeTurn.accountName;

      await ensureSyntheticUpstreamSocket(context, downstream, request, replaySelected);
      await persistProxyUpstreamAccountSelection(options.store, replaySelected.account);
      activeTurn.accountName = replaySelected.account.name;
      activeTurn.bufferedMessages = [];
      activeTurn.outputItems = [];
      activeTurn.replayLocked = false;
      activeTurn.replayLockedByItemType = null;
      activeTurn.replayLockedByType = null;
      activeTurn.replayCount += 1;
      activeTurn.replaySkipReason = null;
      activeTurn.replayedFromAccountNames = [...activeTurn.replayedFromAccountNames, previousAccountName];
      activeTurn.requestBody = cloneJsonValue(finalRequestBody);
      activeTurn.requestShapeWithoutInput = buildRequestShapeWithoutInput(finalRequestBody);
      activeTurn.serviceTier = resolveProxyServiceTier(finalRequestBody);
      activeTurn.responseId = null;
      context.upstreamSocket?.send(JSON.stringify(finalRequestBody));
      return true;
    } catch (error) {
      activeTurn.replaySkipReason = "replay_upstream_error";
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
      const terminalStatusCode = resolveProxyTerminalStatusCode(502, payload);
      await recordWebSocketTerminalError(context, request, payload, terminalStatusCode);
      if (await replayActiveTurnAfterQuotaFailure(context, downstream, request, payload, terminalStatusCode)) {
        return;
      }
    } else if (payloadType === "error") {
      const terminalStatusCode = resolveProxyTerminalStatusCode(500, payload);
      await recordWebSocketTerminalError(context, request, payload, terminalStatusCode);
      if (await replayActiveTurnAfterQuotaFailure(context, downstream, request, payload, terminalStatusCode)) {
        return;
      }
    }

    const downstreamPayloadText = payload && context.activeTurn?.proxyResponseId
      ? JSON.stringify(rewriteEventResponseId(payload, context.activeTurn.proxyResponseId))
      : text;
    const isTerminalEvent = isProxyWebSocketTerminalEvent(payloadType);

    if (context.activeTurn && !context.activeTurn.replayLocked && shouldBufferProxyWebSocketPreludeEvent(payloadType, payload)) {
      context.activeTurn.bufferedMessages.push(downstreamPayloadText);
      return;
    }

    if (context.activeTurn && !context.activeTurn.replayLocked) {
      const replayLock = describeProxyWebSocketReplayLock(payloadType, payload);
      if (replayLock.locked) {
        context.activeTurn.replayLocked = true;
        context.activeTurn.replayLockedByItemType = replayLock.itemType;
        context.activeTurn.replayLockedByType = replayLock.type;
      }
      flushBufferedTurnMessages(context.activeTurn, downstream);
    }

    if (isTerminalEvent) {
      if (payloadType === "response.completed" || payloadType === "response.done") {
        await finalizeActiveTurn(context, payload, 200);
      } else if (payloadType === "response.failed") {
        await finalizeActiveTurn(context, payload, resolveProxyTerminalStatusCode(502, payload));
      } else if (payloadType === "error") {
        await finalizeActiveTurn(context, payload, resolveProxyTerminalStatusCode(500, payload));
      }
    }
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.send(downstreamPayloadText);
    }

    if (isTerminalEvent) {
      return;
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
        service_tier: "default",
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
                service_tier: requestType === "response.create" ? resolveProxyServiceTier(requestBody) : "default",
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
                service_tier: requestType === "response.create" ? resolveProxyServiceTier(requestBody) : "default",
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

            const normalizedCreateRequest = normalizeWebSocketResponsesCreateRequestBody(requestBody);
            const rewrittenRequest = await rewriteProxyCreateRequest({
              store: options.store,
              requestBody: normalizedCreateRequest,
              selectedAccountName: selected.account.name,
              normalizeInput: normalizeWebSocketInput,
            });
            const finalRequestBody = maybeInjectFastServiceTier(rewrittenRequest.requestBody, selected);
            await ensureSyntheticUpstreamSocket(context, downstream, request, selected);

            context.activeTurn = {
              accountName: selected.account.name,
              bufferedMessages: [],
              chainId: rewrittenRequest.chainId,
              fullInput: rewrittenRequest.fullInput,
              outputItems: [],
              parentProxyResponseId: rewrittenRequest.parentProxyResponseId,
              proxyResponseId: createProxyResponseId(),
              replayAttempted: false,
              replayCount: 0,
              replayLocked: false,
              replayLockedByItemType: null,
              replayLockedByType: null,
              replaySkipReason: null,
              replayedFromAccountNames: [],
              requestBody: cloneJsonValue(finalRequestBody),
              requestShapeWithoutInput: buildRequestShapeWithoutInput(finalRequestBody),
              requestId,
              serviceTier: resolveProxyServiceTier(finalRequestBody),
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
            const requestId = createRequestId();
            const responseBodyText = buildProxyErrorResponseText((error as Error).message);
            void options.requestLogger?.({
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
              service_tier: "default",
              status_code: 500,
              duration_ms: 0,
              request_bytes: 0,
              response_bytes: 0,
              synthetic_usage: false,
              error_class: (error as Error).name,
              error_message_short: (error as Error).message,
            });
            void options.errorRequestLogger?.({
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
              service_tier: context.activeTurn?.serviceTier ?? "default",
              status_code: 500,
              duration_ms: 0,
              request_bytes: context.activeTurn ? Buffer.byteLength(JSON.stringify(context.activeTurn.requestBody)) : 0,
              response_bytes: Buffer.byteLength(responseBodyText),
              synthetic_usage: false,
              error_class: (error as Error).name,
              error_message_short: (error as Error).message,
              ...buildRequestResponseLogPayload({
                request,
                bodyText: context.activeTurn ? JSON.stringify(context.activeTurn.requestBody) : "",
                upstreamUrl: context.upstreamAccount ? upstreamChatGPTWebSocketUrl() : null,
                upstreamRequestHeaders: context.upstreamAccount
                  ? outgoingHeadersToRecord(buildChatGPTWebSocketHeaders(request, context.upstreamAccount))
                  : null,
                responseHeaders: {
                  "content-type": "application/json",
                },
                responseBodyText,
              }),
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
