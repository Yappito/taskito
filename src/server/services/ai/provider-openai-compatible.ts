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
  resolveAiProviderTemperature,
  type AiProviderCompletion,
  type AiProviderUsage,
} from "./provider-request";
import type { AiNativeToolDefinition } from "./tools";

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage | null;
}

interface OpenAiStreamEvent {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage | null;
}

/**
 * Reasoning-style endpoints reject `max_tokens` and legacy sampling
 * parameters; they require `max_completion_tokens` instead (o1/o3/o4-mini,
 * gpt-5 families, optionally namespaced like "openai/o3").
 */
function usesMaxCompletionTokens(model: string) {
  return /(?:^|\/)(?:o[134](?:[-.\d]|$)|gpt-5)/i.test(model.trim());
}

function mapOpenAiTools(tools: AiNativeToolDefinition[] | undefined) {
  return tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function parseToolArguments(value: string | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeOpenAiMessages(messages: AiMessage[]) {
  return messages.map((message) => ({
    role: message.role === "tool" ? "tool" : message.role,
    content: message.content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  }));
}

function readOpenAiUsage(usage: OpenAiUsage | undefined | null): AiProviderUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const inputTokens = typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const outputTokens = typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
  const cacheReadTokens = typeof usage.prompt_tokens_details?.cached_tokens === "number" && Number.isFinite(usage.prompt_tokens_details.cached_tokens)
    ? usage.prompt_tokens_details.cached_tokens
    : null;
  if (inputTokens === null && outputTokens === null && cacheReadTokens === null) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens };
}

function buildOpenAiRequestBody(
  provider: ResolvedAiProvider,
  messages: AiMessage[],
  tools: AiNativeToolDefinition[] | undefined,
  { stream = false }: { stream?: boolean } = {}
) {
  const maxOutputTokens = resolveAiMaxOutputTokens(provider.settings);
  const temperature = resolveAiProviderTemperature(provider.settings);
  return {
    model: provider.model,
    messages: normalizeOpenAiMessages(messages),
    // Reasoning endpoints reject `max_tokens`; they require the newer field.
    ...(usesMaxCompletionTokens(provider.model) ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }),
    // Only send temperature when explicitly configured — reasoning endpoints reject it.
    ...(temperature !== null ? { temperature } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(tools?.length ? { tools: mapOpenAiTools(tools), tool_choice: "auto" } : {}),
  };
}

async function postToOpenAiChatCompletions(
  provider: ResolvedAiProvider,
  baseUrl: string,
  body: Record<string, unknown>,
  signal: AbortSignal
) {
  return fetchAiProviderWithRetry(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      ...provider.defaultHeaders,
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.secret}`,
    },
    signal,
    body: JSON.stringify(body),
  });
}

export async function completeWithOpenAiCompatibleProvider(provider: ResolvedAiProvider, messages: AiMessage[]) {
  const completion = await completeWithOpenAiCompatibleProviderStructured(provider, messages);
  return completion.content;
}

export async function completeWithOpenAiCompatibleProviderStructured(
  provider: ResolvedAiProvider,
  messages: AiMessage[],
  tools?: AiNativeToolDefinition[]
): Promise<AiProviderCompletion> {
  const baseUrl = await assertAiProviderBaseUrlFetchAllowed(provider.baseUrl);
  const timeoutMs = getAiProviderRequestTimeoutMs();

  try {
    const response = await postToOpenAiChatCompletions(
      provider,
      baseUrl,
      buildOpenAiRequestBody(provider, messages, tools),
      AbortSignal.timeout(timeoutMs)
    );

    if (!response.ok) {
      throw await aiProviderErrorFromResponse(response);
    }

    let payload: OpenAiChatResponse;
    try {
      payload = (await response.json()) as OpenAiChatResponse;
    } catch {
      // JSON parse failures must never surface: V8's SyntaxError message embeds
      // fragments of the response body, which could leak upstream secrets.
      throw new AiProviderError("Provider returned a malformed response body", {
        status: response.status,
        code: "malformed_response_body",
        retryable: false,
      });
    }
    const choice = payload.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason ?? null;
    return {
      content: message?.content?.trim() ?? "",
      toolCalls: (message?.tool_calls ?? []).flatMap((toolCall) => {
        const name = toolCall.function?.name;
        if (!name) return [];
        return [{ id: toolCall.id, name, arguments: parseToolArguments(toolCall.function?.arguments) }];
      }),
      truncated: finishReason === "length",
      stopReason: finishReason,
      usage: readOpenAiUsage(payload.usage ?? undefined),
    } satisfies AiProviderCompletion;
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}

export async function streamWithOpenAiCompatibleProvider(
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
  let finishReason: string | null = null;
  let streamUsage: AiProviderUsage | null = null;
  const toolCallsByIndex = new Map<number, { id?: string; name: string; argumentsBuffer: string }>();

  try {
    const response = await postToOpenAiChatCompletions(
      provider,
      baseUrl,
      buildOpenAiRequestBody(provider, messages, tools, { stream: true }),
      combinedSignal
    );

    if (!response.ok) {
      throw await aiProviderErrorFromResponse(response);
    }
    if (!response.body) {
      throw new AiProviderError("OpenAI-compatible stream returned an empty body", {
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
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as OpenAiStreamEvent;
          if (parsed.usage) {
            streamUsage = readOpenAiUsage(parsed.usage);
          }
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta = choice?.delta;
          if (delta?.content) {
            content += delta.content;
            onDelta(delta.content);
          }
          for (const toolDelta of delta?.tool_calls ?? []) {
            const index = toolDelta.index ?? 0;
            const existing = toolCallsByIndex.get(index) ?? { id: toolDelta.id, name: "", argumentsBuffer: "" };
            existing.id = existing.id ?? toolDelta.id;
            existing.name = toolDelta.function?.name ?? existing.name;
            existing.argumentsBuffer += toolDelta.function?.arguments ?? "";
            toolCallsByIndex.set(index, existing);
          }
        } catch {
          // Ignore malformed provider stream events.
        }
      }
    }

    return createAiProviderCompletion({
      content: content.trim(),
      toolCalls: [...toolCallsByIndex.values()].flatMap((toolCall) => toolCall.name
        ? [{ id: toolCall.id, name: toolCall.name, arguments: parseToolArguments(toolCall.argumentsBuffer) }]
        : []),
      truncated: finishReason === "length",
      stopReason: finishReason,
      usage: streamUsage,
    });
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}