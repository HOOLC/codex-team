import type { RawData } from "ws";

import {
  cloneJsonValue,
  parseMaybeJson,
} from "./json.js";

const DEFAULT_CODEX_INSTRUCTIONS = "You are Codex.";

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

export function normalizeResponsesInput(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeResponsesInputItem(item));
  }
  if (input === undefined) {
    return [];
  }
  return [normalizeResponsesInputItem(input)];
}

export function normalizeWebSocketInput(input: unknown): unknown[] {
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

export function normalizeResponseOutputItem(item: unknown): unknown | null {
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

  if (type === "custom_tool_call") {
    if (
      typeof record.call_id !== "string"
      || typeof record.name !== "string"
      || typeof record.input !== "string"
    ) {
      return null;
    }
    return {
      type,
      call_id: record.call_id,
      name: record.name,
      input: record.input,
      ...(typeof record.status === "string" ? { status: record.status } : {}),
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

export function responseOutputItemsToConversationItems(items: unknown): unknown[] {
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

export function normalizeResponsesRequestBody(body: Record<string, unknown>): Record<string, unknown> {
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
  if (body.previous_response_id !== undefined) {
    next.previous_response_id = body.previous_response_id;
  }
  if (body.max_output_tokens !== undefined) {
    next.max_output_tokens = body.max_output_tokens;
  }
  return next;
}

export function normalizeWebSocketResponsesCreateRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    type: "response.create",
    model: body.model,
    instructions: resolveInstructions(body.instructions),
    store: false,
    stream: true,
    input: normalizeWebSocketInput(body.input),
  };
  for (const key of ["temperature", "top_p", "tools", "tool_choice", "response_format", "metadata", "service_tier"]) {
    if (body[key] !== undefined) {
      next[key] = body[key];
    }
  }
  if (body.previous_response_id !== undefined) {
    next.previous_response_id = body.previous_response_id;
  }
  if (body.max_output_tokens !== undefined) {
    next.max_output_tokens = body.max_output_tokens;
  }
  return next;
}

export function extractResponseText(payload: unknown): string {
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

export function canonicalOutputItemsFromResponsePayload(payload: unknown): unknown[] {
  const normalizedOutputItems = responseOutputItemsToConversationItems(
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).output
      : undefined,
  );
  if (normalizedOutputItems.length > 0) {
    return normalizedOutputItems;
  }
  const fallbackText = extractResponseText(payload);
  return fallbackText === ""
    ? []
    : [{
        role: "assistant",
        content: [{ type: "output_text", text: fallbackText }],
      }];
}

export function chatCompletionToResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
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

export function completionToResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
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

export function parseResponsePayloadFromSse(text: string): unknown {
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

export function responsesPayloadToChatCompletion(payload: unknown, fallbackModel: unknown): Record<string, unknown> {
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

export function responsesPayloadToCompletion(payload: unknown, fallbackModel: unknown): Record<string, unknown> {
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

export function rawWebSocketDataToText(data: RawData): string {
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

export function parseWebSocketPayload(data: RawData): Record<string, unknown> {
  const parsed = JSON.parse(rawWebSocketDataToText(data)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("WebSocket payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
