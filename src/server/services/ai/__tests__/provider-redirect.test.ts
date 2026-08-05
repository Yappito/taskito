import type { AiMessage } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-provider-validation", () => ({
  assertAiProviderBaseUrlFetchAllowed: vi.fn(async (rawUrl: string) => rawUrl.replace(/\/$/, "")),
}));

import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";
import {
  completeWithAnthropicProvider,
  streamWithAnthropicProvider,
} from "@/server/services/ai/provider-anthropic";
import {
  completeWithOpenAiCompatibleProvider,
  streamWithOpenAiCompatibleProvider,
} from "@/server/services/ai/provider-openai-compatible";

const fetchMock = vi.fn<typeof fetch>();
const assertFetchAllowedMock = vi.mocked(assertAiProviderBaseUrlFetchAllowed);

const openAiProvider = {
  id: "provider-1",
  adapter: "openai_compatible" as const,
  baseUrl: "http://ollama.test/v1",
  model: "llama3.1",
  secret: "super-secret-key",
  defaultHeaders: {},
};

const anthropicProvider = {
  id: "provider-2",
  adapter: "anthropic" as const,
  baseUrl: "http://anthropic.test",
  model: "claude-sonnet-4-20250514",
  secret: "super-secret-key",
  defaultHeaders: {},
};

const messages = [
  {
    id: "msg-1",
    conversationId: "conv-1",
    role: "user",
    content: "Hello",
    toolName: null,
    toolPayload: null,
    toolCalls: null,
    toolCallId: null,
    isStreaming: false,
    createdAt: new Date(),
  },
] satisfies AiMessage[];

function redirectResponse() {
  return new Response(null, {
    status: 302,
    headers: { location: "https://evil.example.com/chat/completions" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  assertFetchAllowedMock.mockResolvedValue("http://ollama.test/v1");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI provider redirect handling", () => {
  it("rejects redirects from the openai-compatible provider without leaking the secret", async () => {
    fetchMock.mockResolvedValue(redirectResponse());

    await expect(completeWithOpenAiCompatibleProvider(openAiProvider, messages))
      .rejects.toThrow(/AI provider returned a redirect, which is not allowed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://ollama.test/v1/chat/completions");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer super-secret-key");
  });

  it("rejects redirects from the openai-compatible streaming path", async () => {
    fetchMock.mockResolvedValue(redirectResponse());

    await expect(streamWithOpenAiCompatibleProvider(openAiProvider, messages, undefined, () => {}))
      .rejects.toThrow(/AI provider returned a redirect, which is not allowed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://ollama.test/v1/chat/completions");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer super-secret-key");
  });

  it("rejects redirects from the anthropic provider without leaking the secret", async () => {
    assertFetchAllowedMock.mockResolvedValue("http://anthropic.test");
    fetchMock.mockResolvedValue(redirectResponse());

    await expect(completeWithAnthropicProvider(anthropicProvider, messages))
      .rejects.toThrow(/AI provider returned a redirect, which is not allowed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://anthropic.test/messages");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("super-secret-key");
  });

  it("rejects redirects from the anthropic streaming path", async () => {
    assertFetchAllowedMock.mockResolvedValue("http://anthropic.test");
    fetchMock.mockResolvedValue(redirectResponse());

    await expect(streamWithAnthropicProvider(anthropicProvider, messages, undefined, () => {}))
      .rejects.toThrow(/AI provider returned a redirect, which is not allowed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://anthropic.test/messages");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("super-secret-key");
  });
});
