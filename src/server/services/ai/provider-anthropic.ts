import type { AiMessage } from "@prisma/client";

import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";

import type { ResolvedAiProvider } from "./provider-registry";
import {
  AiProviderError,
  aiProviderErrorFromResponse,
  createAiProviderCompletion,
  fetchAiProviderWithRetry,
  getAiProviderRequestTimeoutMs,
  normalizeAiProviderRequestError,
  resolveAiMaxOutputTokens,
  type AiProviderCompletion,
  type AiProviderUsage,
} from "./provider-request";
import type { AiNativeToolDefinition } from "./tools";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicMessageResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { id?: string; name?: string; type?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

function mapAnthropicTools(tools: AiNativeToolDefinition[] | undefined) {
  return tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function normalizeMessages(messages: AiMessage[]) {
  return messages
    .filter((message) => message.role !== "system" && message.role !== "tool")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
}

function readAnthropicUsage(usage: AnthropicUsage | undefined): AiProviderUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const inputTokens = typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
  const outputTokens = typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
  const cacheReadTokens = typeof usage.cache_read_input_tokens === "number" && Number.isFinite(usage.cache_read_input_tokens)
    ? usage.cache_read_input_tokens
    : null;
  if (inputTokens === null && outputTokens === null && cacheReadTokens === null) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens };
}

function mergeAnthropicUsage(parts: (AiProviderUsage | null)[]): AiProviderUsage | null {
  let merged: AiProviderUsage | undefined;
  for (const part of parts) {
    if (!part) continue;
    const current: AiProviderUsage = merged ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null };
    merged = {
      inputTokens: part.inputTokens ?? current.inputTokens,
      outputTokens: part.outputTokens ?? current.outputTokens,
      cacheReadTokens: part.cacheReadTokens ?? current.cacheReadTokens,
    };
  }
  return merged ?? null;
}

function buildAnthropicRequestBody(
  provider: ResolvedAiProvider,
  messages: AiMessage[],
  tools: AiNativeToolDefinition[] | undefined,
  { stream = false }: { stream?: boolean } = {}
) {
  const systemMessages = messages.filter((message) => message.role === "system");
  return {
    model: provider.model,
    max_tokens: resolveAiMaxOutputTokens(provider.settings),
    ...(stream ? { stream: true } : {}),
    system: systemMessages.map((message) => message.content).join("\n\n").trim() || undefined,
    messages: normalizeMessages(messages),
    ...(tools?.length ? { tools: mapAnthropicTools(tools) } : {}),
  };
}

async function postToAnthropicMessages(
  provider: ResolvedAiProvider,
  baseUrl: string,
  body: Record<string, unknown>,
  signal: AbortSignal
) {
  return fetchAiProviderWithRetry(`${baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      ...provider.defaultHeaders,
      "Content-Type": "application/json",
      "x-api-key": provider.secret,
      "anthropic-version": "2023-06-01",
    },
    signal,
    body: JSON.stringify(body),
  });
}

export async function completeWithAnthropicProvider(provider: ResolvedAiProvider, messages: AiMessage[]) {
  const completion = await completeWithAnthropicProviderStructured(provider, messages);
  return completion.content;
}

export async function completeWithAnthropicProviderStructured(
  provider: ResolvedAiProvider,
  messages: AiMessage[],
  tools?: AiNativeToolDefinition[]
): Promise<AiProviderCompletion> {
  const baseUrl = await assertAiProviderBaseUrlFetchAllowed(provider.baseUrl);
  const timeoutMs = getAiProviderRequestTimeoutMs();

  try {
    const response = await postToAnthropicMessages(
      provider,
      baseUrl,
      buildAnthropicRequestBody(provider, messages, tools),
      AbortSignal.timeout(timeoutMs)
    );

    if (!response.ok) {
      throw await aiProviderErrorFromResponse(response);
    }

    let payload: AnthropicMessageResponse;
    try {
      payload = (await response.json()) as AnthropicMessageResponse;
    } catch {
      // JSON parse failures must never surface: V8's SyntaxError message embeds
      // fragments of the response body, which could leak upstream secrets.
      throw new AiProviderError("Provider returned a malformed response body", {
        status: response.status,
        code: "malformed_response_body",
        retryable: false,
      });
    }
    return {
      content: payload.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim() ?? "",
      toolCalls: payload.content?.flatMap((part) => part.type === "tool_use" && part.name
        ? [{ id: part.id, name: part.name, arguments: part.input ?? {} }]
        : []) ?? [],
      truncated: payload.stop_reason === "max_tokens",
      stopReason: payload.stop_reason ?? null,
      usage: readAnthropicUsage(payload.usage),
    } satisfies AiProviderCompletion;
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}

export async function streamWithAnthropicProvider(
  provider: ResolvedAiProvider,
  messages: AiMessage[],
  tools: AiNativeToolDefinition[] | undefined,
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<AiProviderCompletion> {
  const baseUrl = await assertAiProviderBaseUrlFetchAllowed(provider.baseUrl);
  const timeoutMs = getAiProviderRequestTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = [timeoutSignal, signal].filter(Boolean) as AbortSignal[];
  const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : timeoutSignal;
  let content = "";
  let stopReason: string | null = null;
  let startUsage: AiProviderUsage | null = null;
  let deltaUsage: AiProviderUsage | null = null;
  const toolCalls = new Map<number, { id?: string; name: string; inputBuffer: string }>();

  try {
    const response = await postToAnthropicMessages(
      provider,
      baseUrl,
      buildAnthropicRequestBody(provider, messages, tools, { stream: true }),
      combinedSignal
    );

    if (!response.ok) {
      throw await aiProviderErrorFromResponse(response);
    }
    if (!response.body) {
      throw new AiProviderError("Anthropic stream returned an empty body", {
        status: response.status,
        code: "empty_stream_body",
        retryable: false,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as AnthropicStreamEvent;
          // Keepalives and lifecycle bookkeeping events carry no payload data.
          if (parsed.type === "ping") continue;
          if (parsed.type === "error") {
            await reader.cancel().catch(() => {});
            const errorType = parsed.error?.type ?? "stream_error";
            const errorMessage = parsed.error?.message?.trim();
            throw new AiProviderError(
              (errorMessage && errorMessage.length > 0 ? errorMessage : `Anthropic stream failed with ${errorType} error event`).slice(0, 500),
              {
                status: null,
                code: errorType,
                // The request cannot be retried in place (bytes were already
                // streamed); a retry would have to restart the whole turn.
                retryable: errorType === "overloaded_error",
              }
            );
          }
          if (parsed.type === "message_start" && parsed.message?.usage) {
            startUsage = readAnthropicUsage(parsed.message.usage);
          }
          if (parsed.type === "message_delta") {
            if (parsed.delta?.stop_reason) {
              stopReason = parsed.delta.stop_reason;
            }
            if (parsed.usage) {
              deltaUsage = readAnthropicUsage(parsed.usage);
            }
          }
          if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
            toolCalls.set(parsed.index ?? 0, { id: parsed.content_block.id, name: parsed.content_block.name ?? "", inputBuffer: "" });
          }
          if (parsed.delta?.text) {
            content += parsed.delta.text;
            onDelta(parsed.delta.text);
          }
          if (parsed.delta?.partial_json && toolCalls.has(parsed.index ?? 0)) {
            const existing = toolCalls.get(parsed.index ?? 0)!;
            existing.inputBuffer += parsed.delta.partial_json;
          }
        } catch (error) {
          if (error instanceof AiProviderError) {
            throw error;
          }
          // Ignore malformed provider stream events.
        }
      }
    }

    return createAiProviderCompletion({
      content: content.trim(),
      toolCalls: [...toolCalls.values()].flatMap((toolCall) => {
        if (!toolCall.name) return [];
        try {
          return [{ id: toolCall.id, name: toolCall.name, arguments: JSON.parse(toolCall.inputBuffer || "{}") as Record<string, unknown> }];
        } catch {
          return [{ id: toolCall.id, name: toolCall.name, arguments: {} }];
        }
      }),
      truncated: stopReason === "max_tokens",
      stopReason,
      usage: mergeAnthropicUsage([startUsage, deltaUsage]),
    });
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}