import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAKE_PROVIDER_BASE_URL,
  installFakeFetch,
  jsonResponse,
  makeFakeAiMessages,
  makeFakeProvider,
  sseResponse,
  stubFakeProviderEnv,
} from "./helpers/fake-provider";
import { expectEquivalentCompletion } from "./helpers/completion-expectations";
import { AiProviderError } from "@/server/services/ai/provider-request";
import {
  completeWithOpenAiCompatibleProviderStructured,
  streamWithOpenAiCompatibleProvider,
} from "@/server/services/ai/provider-openai-compatible";
import type { AiNativeToolDefinition } from "@/server/services/ai/tools";

const provider = makeFakeProvider("openai_compatible");
const tools: AiNativeToolDefinition[] = [
  {
    name: "moveStatus",
    description: "Move a task",
    inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  },
];

const nonStreamPayload = {
  id: "chatcmpl_1",
  choices: [
    {
      message: { content: "Hello " },
      finish_reason: "stop",
    },
    {
      message: { content: "ignored second choice" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 5 },
};

const nonStreamToolCallPayload = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "moveStatus", arguments: "{\"taskId\":\"t1\"}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 6 } },
};

const chatStreamLines = [
  JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hel" }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", function: { name: "moveStatus", arguments: "" } }] }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"taskId\":" } }] }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"t9\"}" } }] }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 21, prompt_tokens_details: { cached_tokens: 3 } } }),
  "[DONE]",
];

describe("openai-compatible provider adapter", () => {
  let restoreEnv: (() => void) | undefined;
  let restoreFake: (() => void) | undefined;

  beforeEach(() => {
    restoreEnv = stubFakeProviderEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (restoreFake) {
      restoreFake();
      restoreFake = undefined;
    }
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = undefined;
    }
  });

  describe("request shape", () => {
    it("sends Bearer auth, mapped tools, and max_tokens; omits temperature by default", async () => {
      vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "1234");
      const fake = installFakeFetch([jsonResponse({ choices: [], usage: null })]);
      restoreFake = fake.restore;

      await completeWithOpenAiCompatibleProviderStructured(
        provider,
        makeFakeAiMessages(
          { role: "system", content: "System prompt." },
          { role: "user", content: "Do it" }
        ),
        tools
      );

      expect(fake.requests).toHaveLength(1);
      const request = fake.requests[0];
      expect(request.url).toBe(`${FAKE_PROVIDER_BASE_URL}/chat/completions`);
      expect(request.headers["authorization"]).toBe("Bearer sk-fake-secret");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body).toMatchObject({
        model: "gpt-fake",
        max_tokens: 1234,
        messages: [
          { role: "system", content: "System prompt." },
          { role: "user", content: "Do it" },
        ],
      });
      const body = request.body as Record<string, unknown>;
      expect("temperature" in body).toBe(false);
      expect(body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "moveStatus",
            description: "Move a task",
            parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
          },
        },
      ]);
      expect(body.tool_choice).toBe("auto");
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it("sends temperature only when explicitly configured on the provider", async () => {
      const item = installFakeFetch([jsonResponse({ choices: [] })]);
      restoreFake = item.restore;

      await completeWithOpenAiCompatibleProviderStructured(
        makeFakeProvider("openai_compatible", { settings: { temperature: 0.7 } }),
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expect((item.requests[0].body as { temperature?: number }).temperature).toBe(0.7);
    });

    it("uses max_completion_tokens for reasoning-style models", async () => {
      // Single handler (not a one-element queue): the loop below issues
      // several requests and every one must succeed.
      const fake = installFakeFetch(() => jsonResponse({ choices: [] }));
      restoreFake = fake.restore;

      for (const model of ["o4-mini", "o3", "gpt-5", "openai/o3-mini"]) {
        await completeWithOpenAiCompatibleProviderStructured(
          makeFakeProvider("openai_compatible", { model }),
          makeFakeAiMessages({ role: "user", content: "hi" })
        );
      }
      await completeWithOpenAiCompatibleProviderStructured(
        makeFakeProvider("openai_compatible", { model: "gpt-4o" }),
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expect(fake.requests.map((request) => {
        const body = request.body as Record<string, unknown>;
        return { model: body.model, max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens };
      })).toEqual([
        { model: "o4-mini", max_tokens: undefined, max_completion_tokens: 16_384 },
        { model: "o3", max_tokens: undefined, max_completion_tokens: 16_384 },
        { model: "gpt-5", max_tokens: undefined, max_completion_tokens: 16_384 },
        { model: "openai/o3-mini", max_tokens: undefined, max_completion_tokens: 16_384 },
        { model: "gpt-4o", max_tokens: 16_384, max_completion_tokens: undefined },
      ]);
    });
  });

  describe("non-streaming", () => {
    it("parses text content with usage and finish reason", async () => {
      const fake = installFakeFetch([jsonResponse(nonStreamPayload)]);
      restoreFake = fake.restore;

      const completion = await completeWithOpenAiCompatibleProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expectEquivalentCompletion(completion, {
        content: "Hello",
        truncated: false,
        stopReason: "stop",
        usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: null },
      });
    });

    it("parses tool calls and nested cached-token usage", async () => {
      const fake = installFakeFetch([jsonResponse(nonStreamToolCallPayload)]);
      restoreFake = fake.restore;

      const completion = await completeWithOpenAiCompatibleProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expectEquivalentCompletion(completion, {
        toolCalls: [{ id: "call_1", name: "moveStatus", arguments: { taskId: "t1" } }],
        truncated: false,
        stopReason: "tool_calls",
        usage: { inputTokens: 20, outputTokens: 12, cacheReadTokens: 6 },
      });
    });

    it("reports truncated=true when finish_reason is length", async () => {
      const fake = installFakeFetch([jsonResponse({
        choices: [{ message: { content: "cut" }, finish_reason: "length" }],
        usage: { prompt_tokens: 10, completion_tokens: 16_384 },
      })]);
      restoreFake = fake.restore;

      const completion = await completeWithOpenAiCompatibleProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expectEquivalentCompletion(completion, {
        content: "cut",
        truncated: true,
        stopReason: "length",
        usage: { inputTokens: 10, outputTokens: 16_384, cacheReadTokens: null },
      });
    });

    it("surfaces the provider error body as AiProviderError on a 400", async () => {
      const fake = installFakeFetch([
        jsonResponse({ error: { message: "Invalid model name", type: "invalid_request_error", code: "model_not_found" } }, 400),
      ]);
      restoreFake = fake.restore;

      const completion = completeWithOpenAiCompatibleProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );
      await expect(completion).rejects.toBeInstanceOf(AiProviderError);
      await completion.catch((error: AiProviderError) => {
        expect(error.status).toBe(400);
        expect(error.code).toBe("model_not_found");
        expect(error.retryable).toBe(false);
        expect(error.message).toBe("Invalid model name");
      });
    });
  });

  describe("streaming", () => {
    it("assembles streamed content and tool_calls deltas with usage", async () => {
      const fake = installFakeFetch([sseResponse(chatStreamLines)]);
      restoreFake = fake.restore;

      const deltas: string[] = [];
      const completion = await streamWithOpenAiCompatibleProvider(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" }),
        tools,
        (delta) => deltas.push(delta)
      );

      expect(deltas).toEqual(["Hel", "lo"]);
      const body = fake.requests[0].body as Record<string, unknown>;
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expectEquivalentCompletion(completion, {
        content: "Hello",
        toolCalls: [{ id: "call_2", name: "moveStatus", arguments: { taskId: "t9" } }],
        truncated: false,
        stopReason: "tool_calls",
        usage: { inputTokens: 9, outputTokens: 21, cacheReadTokens: 3 },
      });
    });

    it("flags truncation when finish_reason is length", async () => {
      const fake = installFakeFetch([sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "par" }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { content: "tial" }, finish_reason: "length" }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 16_384 } }),
        "[DONE]",
      ])]);
      restoreFake = fake.restore;

      const completion = await streamWithOpenAiCompatibleProvider(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" }),
        undefined,
        () => {}
      );

      expectEquivalentCompletion(completion, {
        content: "partial",
        truncated: true,
        stopReason: "length",
        usage: { inputTokens: 4, outputTokens: 16_384, cacheReadTokens: null },
      });
    });
  });

  describe("retries", () => {
    it("retries a 429 with Retry-After using fake timers, then succeeds", async () => {
      vi.useFakeTimers();
      const fake = installFakeFetch([
        jsonResponse(
          { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } },
          429,
          { "retry-after": "2" }
        ),
        jsonResponse({
          choices: [{ message: { content: "after retry" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
      ]);
      restoreFake = fake.restore;

      const pending = completeWithOpenAiCompatibleProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.runAllTimersAsync();

      const completion = await pending;
      expect(fake.requests).toHaveLength(2);
      expectEquivalentCompletion(completion, {
        content: "after retry",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: null },
      });
    });
  });
});