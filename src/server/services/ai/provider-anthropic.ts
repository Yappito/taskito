import type { AiMessage } from "@prisma/client";

import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";

import type { ResolvedAiProvider } from "./provider-registry";
import { getAiProviderRequestTimeoutMs, normalizeAiProviderRequestError } from "./provider-request";

interface AnthropicMessageResponse {
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

export async function completeWithAnthropicProvider(provider: ResolvedAiProvider, messages: AiMessage[]) {
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversationMessages = messages
    .filter((message) => message.role !== "system" && message.role !== "tool")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));

  const baseUrl = await assertAiProviderBaseUrlFetchAllowed(provider.baseUrl);
  const timeoutMs = getAiProviderRequestTimeoutMs();

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/messages`, {
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
      }),
    });

    if (!response.ok) {
      throw new Error(`Provider request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as AnthropicMessageResponse;
    return payload.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim() ?? "";
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}
