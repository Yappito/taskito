import type { AiMessage } from "@prisma/client";

import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";

import type { ResolvedAiProvider } from "./provider-registry";
import { getAiProviderRequestTimeoutMs, normalizeAiProviderRequestError } from "./provider-request";

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export async function completeWithOpenAiCompatibleProvider(provider: ResolvedAiProvider, messages: AiMessage[]) {
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
      body: JSON.stringify({
        model: provider.model,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      throw new Error(`Provider request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as OpenAiChatResponse;
    return payload.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    throw normalizeAiProviderRequestError(error, timeoutMs);
  }
}
