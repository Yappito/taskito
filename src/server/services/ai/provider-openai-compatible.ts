import type { AiMessage } from "@prisma/client";

import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";

import type { ResolvedAiProvider } from "./provider-registry";
import { getAiProviderRequestTimeoutMs, normalizeAiProviderRequestError } from "./provider-request";
import type { AiNativeToolCall, AiNativeToolDefinition } from "./tools";

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
  }>;
}

export interface AiProviderCompletion {
  content: string;
  toolCalls: AiNativeToolCall[];
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
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        ...provider.defaultHeaders,
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.secret}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      body: JSON.stringify({
        model: provider.model,
        messages: normalizeOpenAiMessages(messages),
        temperature: 0.2,
        ...(tools?.length ? { tools: mapOpenAiTools(tools), tool_choice: "auto" } : {}),
      }),
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error("AI provider returned a redirect, which is not allowed");
    }

    if (!response.ok) {
      throw new Error(`Provider request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as OpenAiChatResponse;
    const message = payload.choices?.[0]?.message;
    return {
      content: message?.content?.trim() ?? "",
      toolCalls: (message?.tool_calls ?? []).flatMap((toolCall) => {
        const name = toolCall.function?.name;
        if (!name) return [];
        return [{ id: toolCall.id, name, arguments: parseToolArguments(toolCall.function?.arguments) }];
      }),
    };
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
  const toolCallsByIndex = new Map<number, { id?: string; name: string; argumentsBuffer: string }>();

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        ...provider.defaultHeaders,
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.secret}`,
      },
      signal: combinedSignal,
      redirect: "manual",
      body: JSON.stringify({
        model: provider.model,
        messages: normalizeOpenAiMessages(messages),
        temperature: 0.2,
        stream: true,
        ...(tools?.length ? { tools: mapOpenAiTools(tools), tool_choice: "auto" } : {}),
      }),
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error("AI provider returned a redirect, which is not allowed");
    }

    if (!response.ok || !response.body) {
      throw new Error(`Provider request failed with status ${response.status}`);
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
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          const delta = parsed.choices?.[0]?.delta;
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

    return {
      content: content.trim(),
      toolCalls: [...toolCallsByIndex.values()].flatMap((toolCall) => toolCall.name
        ? [{ id: toolCall.id, name: toolCall.name, arguments: parseToolArguments(toolCall.argumentsBuffer) }]
        : []),
    };
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}
