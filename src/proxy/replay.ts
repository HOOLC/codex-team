import type { AccountStore } from "../account-store/index.js";
import {
  createProxyChainId,
  isProxyResponseId,
  readProxyResponseCheckpoint,
  writeProxyResponseCheckpoint,
} from "./context.js";
import { cloneJsonValue } from "./json.js";

export function buildRequestShapeWithoutInput(body: Record<string, unknown>): Record<string, unknown> {
  const shape = cloneJsonValue(body);
  delete shape.input;
  delete shape.previous_response_id;
  return shape;
}

function requestShapesMatch(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function rewriteTopLevelResponseId(payload: unknown, proxyResponseId: string): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const rewritten = cloneJsonValue(payload) as Record<string, unknown>;
  if (typeof rewritten.id === "string") {
    rewritten.id = proxyResponseId;
  }
  return rewritten;
}

export function rewriteEventResponseId(payload: Record<string, unknown>, proxyResponseId: string): Record<string, unknown> {
  const rewritten = cloneJsonValue(payload);
  const response = rewritten.response;
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const responseRecord = response as Record<string, unknown>;
    if (typeof responseRecord.id === "string") {
      responseRecord.id = proxyResponseId;
    }
  }
  return rewritten;
}

export async function rewriteProxyCreateRequest(options: {
  store: AccountStore;
  requestBody: Record<string, unknown>;
  selectedAccountName: string;
  normalizeInput: (input: unknown) => unknown[];
}): Promise<{
  checkpointFound: boolean;
  chainId: string;
  fullInput: unknown[];
  parentProxyResponseId: string | null;
  requestBody: Record<string, unknown>;
  requestShapeWithoutInput: Record<string, unknown>;
}> {
  const previousResponseId = typeof options.requestBody.previous_response_id === "string"
    ? options.requestBody.previous_response_id
    : null;
  const deltaInput = options.normalizeInput(options.requestBody.input);
  const requestShapeWithoutInput = buildRequestShapeWithoutInput(options.requestBody);

  if (!previousResponseId) {
    return {
      checkpointFound: false,
      chainId: createProxyChainId(),
      fullInput: deltaInput,
      parentProxyResponseId: null,
      requestBody: options.requestBody,
      requestShapeWithoutInput,
    };
  }

  const checkpoint = await readProxyResponseCheckpoint(options.store, previousResponseId);
  if (!checkpoint) {
    if (isProxyResponseId(previousResponseId)) {
      throw new Error(`Unknown proxy previous_response_id: ${previousResponseId}`);
    }
    const rewrittenBody = {
      ...options.requestBody,
      input: deltaInput,
    } as Record<string, unknown>;
    delete rewrittenBody.previous_response_id;
    return {
      checkpointFound: false,
      chainId: createProxyChainId(),
      fullInput: deltaInput,
      parentProxyResponseId: null,
      requestBody: rewrittenBody,
      requestShapeWithoutInput,
    };
  }

  const fullInput = [
    ...cloneJsonValue(checkpoint.canonical_context),
    ...deltaInput,
  ];
  if (
    checkpoint.account_name === options.selectedAccountName
    && checkpoint.upstream_response_id
    && requestShapesMatch(checkpoint.request_shape_without_input, requestShapeWithoutInput)
  ) {
    return {
      checkpointFound: true,
      chainId: checkpoint.chain_id,
      fullInput,
      parentProxyResponseId: checkpoint.proxy_response_id,
      requestBody: {
        ...options.requestBody,
        input: deltaInput,
        previous_response_id: checkpoint.upstream_response_id,
      },
      requestShapeWithoutInput,
    };
  }

  const rewrittenBody = {
    ...options.requestBody,
    input: fullInput,
  } as Record<string, unknown>;
  delete rewrittenBody.previous_response_id;
  return {
    checkpointFound: true,
    chainId: checkpoint.chain_id,
    fullInput,
    parentProxyResponseId: checkpoint.proxy_response_id,
    requestBody: rewrittenBody,
    requestShapeWithoutInput,
  };
}

export async function persistProxyResponseCheckpointFromTurn(options: {
  store: AccountStore;
  chainId: string;
  accountName: string;
  fullInput: unknown[];
  outputItems: unknown[];
  parentProxyResponseId: string | null;
  proxyResponseId: string;
  requestShapeWithoutInput: Record<string, unknown>;
  upstreamResponseId: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await writeProxyResponseCheckpoint(options.store, {
    version: 1,
    proxy_response_id: options.proxyResponseId,
    chain_id: options.chainId,
    parent_proxy_response_id: options.parentProxyResponseId,
    upstream_response_id: options.upstreamResponseId,
    account_name: options.accountName,
    request_shape_without_input: cloneJsonValue(options.requestShapeWithoutInput),
    canonical_context: [
      ...cloneJsonValue(options.fullInput),
      ...cloneJsonValue(options.outputItems),
    ],
    created_at: now,
    updated_at: now,
  });
}
