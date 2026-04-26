import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";

function normalizedHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value ?? "";
}

function decodeRequestBody(buffer: Buffer, contentEncodingHeader: string): Buffer {
  const encodings = contentEncodingHeader
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (encodings.length === 0) {
    return buffer;
  }

  let decoded = buffer;
  for (const encoding of [...encodings].reverse()) {
    switch (encoding) {
      case "identity":
        break;
      case "gzip":
      case "x-gzip":
        decoded = gunzipSync(decoded);
        break;
      case "deflate":
        decoded = inflateSync(decoded);
        break;
      case "br":
        decoded = brotliDecompressSync(decoded);
        break;
      case "zstd":
        decoded = zstdDecompressSync(decoded);
        break;
      default:
        throw new Error(`Unsupported request content-encoding: ${encoding}`);
    }
  }

  return decoded;
}

export function normalizePathname(pathname: string): string {
  return pathname
    .replace(/\/{2,}/gu, "/")
    .replace(/^(?:\/backend-api){2,}(?=\/|$)/u, "/backend-api");
}

export function readRequestBody(request: IncomingMessage): Promise<{ bodyText: string; rawBytes: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      try {
        const bodyBuffer = Buffer.concat(chunks);
        const decodedBody = decodeRequestBody(
          bodyBuffer,
          normalizedHeaderValue(request.headers["content-encoding"]),
        );
        resolve({
          bodyText: decodedBody.toString("utf8"),
          rawBytes: bodyBuffer.byteLength,
        });
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

export function requestHeadersToFetchHeaders(
  request: IncomingMessage,
  overrides: Record<string, string | null> = {},
): Headers {
  const headers = new Headers();
  const normalizedOverrideKeys = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  for (const [key, rawValue] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host"
      || lowerKey === "content-length"
      || lowerKey === "connection"
      || lowerKey === "content-encoding"
      || lowerKey === "transfer-encoding"
    ) {
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

  if (!normalizedOverrideKeys.has("accept-encoding") && !headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }

  return headers;
}

export function requestHeadersToWebSocketHeaders(
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

export function incomingHeadersToRecord(request: IncomingMessage): Record<string, string | string[]> {
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

export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function outgoingHeadersToRecord(
  headers: OutgoingHttpHeaders,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      result[key] = rawValue.map((value) => String(value));
      continue;
    }
    result[key] = String(rawValue);
  }
  return result;
}

export function upstreamResponseHeadersToRecord(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  return headers;
}

export function shouldCaptureDiagnosticPayload(pathname: string): boolean {
  return pathname === "/backend-api/wham/usage"
    || pathname === "/backend-api/wham/accounts/check"
    || pathname === "/backend-api/subscriptions/auto_top_up/settings"
    || /^\/backend-api\/accounts\/check\/.+/u.test(pathname);
}

export function buildJsonBodyText(payload: unknown): string {
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

export function buildProxyErrorResponseText(message: string): string {
  return buildJsonBodyText(buildProxyErrorResponsePayload(message));
}

export function writeJson(response: ServerResponse, statusCode: number, payload: unknown): number {
  const body = buildJsonBodyText(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(body);
  return Buffer.byteLength(body);
}

export function writeError(response: ServerResponse, statusCode: number, message: string): number {
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
  const responseBodyText = await upstream.text();
  const responseHeaders = upstreamResponseHeadersToRecord(upstream);
  response.writeHead(upstream.status, responseHeaders);
  response.end(responseBodyText);
  return {
    responseBytes: Buffer.byteLength(responseBodyText),
    responseHeaders,
    responseBodyText,
  };
}

async function writeUpstreamResponseWithOptionalBuffering(options: {
  response: ServerResponse;
  upstream: Response;
}): Promise<{
  responseBytes: number;
  responseHeaders: Record<string, string> | null;
  responseBodyText: string | null;
  buffered: boolean;
}> {
  try {
    const buffered = await writeBufferedUpstreamResponse(options.response, options.upstream);
    return {
      responseBytes: buffered.responseBytes,
      responseHeaders: buffered.responseHeaders,
      responseBodyText: buffered.responseBodyText,
      buffered: true,
    };
  } catch {
    return {
      responseBytes: await writeUpstreamResponse(options.response, options.upstream),
      responseHeaders: null,
      responseBodyText: null,
      buffered: false,
    };
  }
}

export function writeBufferedResponse(
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
  headers: Headers | Record<string, string | string[]> | null,
): Record<string, string | string[]> | null {
  if (!headers) {
    return null;
  }

  if (headers instanceof Headers) {
    return headersToRecord(headers);
  }

  return { ...headers };
}

export function shouldRecordErrorPayload(statusCode: number): boolean {
  return statusCode !== 200;
}

export function buildRequestResponseLogPayload(options: {
  request: IncomingMessage;
  bodyText: string;
  upstreamUrl: string | null;
  upstreamRequestHeaders: Headers | Record<string, string | string[]> | null;
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

export function buildLocalErrorLogPayload(options: {
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

export async function writeUpstreamResponseWithLogging(options: {
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

  const buffered = await writeUpstreamResponseWithOptionalBuffering({
    response: options.response,
    upstream: options.upstream,
  });
  if (!buffered.buffered) {
    const fallbackPayload = buildRequestResponseLogPayload({
      request: options.request,
      bodyText: options.bodyText,
      upstreamUrl: options.upstreamUrl,
      upstreamRequestHeaders: options.upstreamRequestHeaders,
      responseHeaders: null,
      responseBodyText: "[unavailable: upstream body could not be buffered for diagnostics]",
    });
    return {
      responseBytes: buffered.responseBytes,
      diagnostic: captureDiagnostic ? fallbackPayload : undefined,
      errorPayload: captureError ? fallbackPayload : undefined,
    };
  }
  const payload = buildRequestResponseLogPayload({
    request: options.request,
    bodyText: options.bodyText,
    upstreamUrl: options.upstreamUrl,
    upstreamRequestHeaders: options.upstreamRequestHeaders,
    responseHeaders: buffered.responseHeaders ?? {},
    responseBodyText: buffered.responseBodyText ?? "",
  });

  return {
    responseBytes: buffered.responseBytes,
    diagnostic: captureDiagnostic ? payload : undefined,
    errorPayload: captureError ? payload : undefined,
  };
}

export function parseJsonBody(bodyText: string): Record<string, unknown> {
  if (bodyText.trim() === "") {
    return {};
  }

  const parsed = JSON.parse(bodyText) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON request body must be an object.");
  }
  return parsed as Record<string, unknown>;
}
