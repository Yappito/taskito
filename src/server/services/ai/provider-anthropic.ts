import type { AiMessage } from "@prisma/client";

import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";

import type { ResolvedAiProvider } from "./provider-registry";
import { fetchAiProvider, getAiProviderRequestTimeoutMs, normalizeAiProviderRequestError, UpstreamProviderError } from "./provider-request";
import type { AiNativeToolCall, AiNativeToolDefinition } from "./tools";

interface AnthropicMessageResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
}

interface AiProviderCompletion {
  content: string;
  toolCalls: AiNativeToolCall[];
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

export async function completeWithAnthropicProvider(provider: ResolvedAiProvider, messages: AiMessage[]) {
  const completion = await completeWithAnthropicProviderStructured(provider, messages);
  return completion.content;
}

export async function completeWithAnthropicProviderStructured(
  provider: ResolvedAiProvider,
  messages: AiMessage[],
  tools?: AiNativeToolDefinition[]
): Promise<AiProviderCompletion> {
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversationMessages = normalizeMessages(messages);

  const baseUrl = await assertAiProviderBaseUrlFetchAllowed(provider.baseUrl);
  const timeoutMs = getAiProviderRequestTimeoutMs();

  try {
    const response = await fetchAiProvider(`${baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        ...provider.defaultHeaders,
        "Content-Type": "application/json",
        "x-api-key": provider.secret,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 1200,
        system: systemMessages.map((message) => message.content).join("\n\n").trim() || undefined,
        messages: conversationMessages,
        ...(tools?.length ? { tools: mapAnthropicTools(tools) } : {}),
      }),
    });

    if (!response.ok) {
      throw new UpstreamProviderError(`Provider request failed with status ${response.status}`, response.status);
    }

    const payload = (await response.json()) as AnthropicMessageResponse;
    return {
      content: payload.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim() ?? "",
      toolCalls: payload.content?.flatMap((part) => part.type === "tool_use" && part.name
        ? [{ id: part.id, name: part.name, arguments: part.input ?? {} }]
        : []) ?? [],
    };
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
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversationMessages = normalizeMessages(messages);
  const baseUrl = await assertAiProviderBaseUrlFetchAllowed(provider.baseUrl);
  const timeoutMs = getAiProviderRequestTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = [timeoutSignal, signal].filter(Boolean) as AbortSignal[];
  const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : timeoutSignal;
  let content = "";
  const toolCalls = new Map<number, { id?: string; name: string; inputBuffer: string }>();

  try {
    const response = await fetchAiProvider(`${baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        ...provider.defaultHeaders,
        "Content-Type": "application/json",
        "x-api-key": provider.secret,
        "anthropic-version": "2023-06-01",
      },
      signal: combinedSignal,
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 1200,
        stream: true,
        system: systemMessages.map((message) => message.content).join("\n\n").trim() || undefined,
        messages: conversationMessages,
        ...(tools?.length ? { tools: mapAnthropicTools(tools) } : {}),
      }),
    });

    if (!response.ok || !response.body) {
      throw new UpstreamProviderError(`Provider request failed with status ${response.status}`, response.status);
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
          const parsed = JSON.parse(data) as {
            type?: string;
            index?: number;
            content_block?: { id?: string; name?: string; type?: string };
            delta?: { type?: string; text?: string; partial_json?: string };
          };
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
        } catch {
          // Ignore malformed provider stream events.
        }
      }
    }

    return {
      content: content.trim(),
      toolCalls: [...toolCalls.values()].flatMap((toolCall) => {
        if (!toolCall.name) return [];
        try {
          return [{ id: toolCall.id, name: toolCall.name, arguments: JSON.parse(toolCall.inputBuffer || "{}") as Record<string, unknown> }];
        } catch {
          return [{ id: toolCall.id, name: toolCall.name, arguments: {} }];
        }
      }),
    };
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}
