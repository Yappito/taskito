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
  completeWithAnthropicProviderStructured,
  streamWithAnthropicProvider,
} from "@/server/services/ai/provider-anthropic";
import type { AiNativeToolDefinition } from "@/server/services/ai/tools";

const provider = makeFakeProvider("anthropic");
const tools: AiNativeToolDefinition[] = [
  {
    name: "createTask",
    description: "Create a task",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
];

const nonStreamPayload = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [
    { type: "text", text: "Hello " },
    { type: "text", text: "world" },
  ],
  model: "claude-fake-3",
  stop_reason: "end_turn",
  usage: { input_tokens: 15, output_tokens: 9 },
};

const nonStreamToolUsePayload = {
  content: [
    { type: "text", text: "Hello world" },
    { type: "tool_use", id: "toolu_1", name: "createTask", input: { title: "Write tests" } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 15, output_tokens: 42, cache_read_input_tokens: 7 },
};

const messageStreamLines = [
  JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } }),
  JSON.stringify({ type: "ping" }),
  JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }),
  JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }),
  JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "createTask" } }),
  JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"title\":\"Wr" } }),
  JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "ite tests\"}" } }),
  JSON.stringify({ type: "content_block_stop", index: 1 }),
  JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 16384 } }),
  JSON.stringify({ type: "message_stop" }),
];

describe("anthropic provider adapter", () => {
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
    it("sends a string system prompt, tools with input_schema, and the env-configured max_tokens", async () => {
      vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "777");
      const fake = installFakeFetch([jsonResponse({ content: [], stop_reason: "end_turn" })]);
      restoreFake = fake.restore;

      await completeWithAnthropicProviderStructured(
        provider,
        makeFakeAiMessages(
          { role: "system", content: "First system line." },
          { role: "system", content: "Second system line." },
          { role: "user", content: "Do it" }
        ),
        tools
      );

      expect(fake.requests).toHaveLength(1);
      const request = fake.requests[0];
      expect(request.url).toBe(`${FAKE_PROVIDER_BASE_URL}/messages`);
      expect(request.headers["x-api-key"]).toBe("sk-fake-secret");
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body).toMatchObject({
        model: "claude-fake-3",
        max_tokens: 777,
        system: "First system line.\n\nSecond system line.",
        messages: [{ role: "user", content: "Do it" }],
      });
      expect((request.body as { tools?: unknown }).tools).toEqual([
        {
          name: "createTask",
          description: "Create a task",
          input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        },
      ]);
      expect((request.body as { stream?: unknown }).stream).toBeUndefined();
    });

    it("uses the default max output tokens when neither env nor provider settings define one", async () => {
      const fake = installFakeFetch([jsonResponse({ content: [], stop_reason: "end_turn" })]);
      restoreFake = fake.restore;

      await completeWithAnthropicProviderStructured(provider, makeFakeAiMessages({ role: "user", content: "hi" }));

      expect((fake.requests[0].body as { max_tokens?: number }).max_tokens).toBe(16_384);
    });

    it("prefers settings.maxOutputTokens over the env value", async () => {
      vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "777");
      const fake = installFakeFetch([jsonResponse({ content: [], stop_reason: "end_turn" })]);
      restoreFake = fake.restore;

      await completeWithAnthropicProviderStructured(
        makeFakeProvider("anthropic", { settings: { maxOutputTokens: 512 } }),
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expect((fake.requests[0].body as { max_tokens?: number }).max_tokens).toBe(512);
    });
  });

  describe("non-streaming", () => {
    it("parses plain text output with usage and stop reason", async () => {
      const fake = installFakeFetch([jsonResponse(nonStreamPayload)]);
      restoreFake = fake.restore;

      const completion = await completeWithAnthropicProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      // Multiple Anthropic text blocks are joined with a newline separator.
      expectEquivalentCompletion(completion, {
        content: "Hello \nworld",
        truncated: false,
        stopReason: "end_turn",
        usage: { inputTokens: 15, outputTokens: 9, cacheReadTokens: null },
      });
    });

    it("parses text and tool_use parts with usage and stop reason", async () => {
      const fake = installFakeFetch([jsonResponse(nonStreamToolUsePayload)]);
      restoreFake = fake.restore;

      const completion = await completeWithAnthropicProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expectEquivalentCompletion(completion, {
        content: "Hello world",
        toolCalls: [{ id: "toolu_1", name: "createTask", arguments: { title: "Write tests" } }],
        truncated: false,
        stopReason: "tool_use",
        usage: { inputTokens: 15, outputTokens: 42, cacheReadTokens: 7 },
      });
    });

    it("reports truncated=true when stop_reason is max_tokens", async () => {
      const fake = installFakeFetch([
        jsonResponse({ content: [{ type: "text", text: "partial answer" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 16_384 } }),
      ]);
      restoreFake = fake.restore;

      const completion = await completeWithAnthropicProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );

      expectEquivalentCompletion(completion, {
        content: "partial answer",
        truncated: true,
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 16_384, cacheReadTokens: null },
      });
    });

    it("surfaces the provider error body as AiProviderError on a 400", async () => {
      const fake = installFakeFetch([
        jsonResponse(
          { type: "error", error: { type: "invalid_request_error", message: "max_tokens: Field required" } },
          400
        ),
      ]);
      restoreFake = fake.restore;

      const promise = completeWithAnthropicProviderStructured(provider, makeFakeAiMessages({ role: "user", content: "hi" }));
      await expect(promise).rejects.toBeInstanceOf(AiProviderError);
      await promise.catch((error: AiProviderError) => {
        expect(error.status).toBe(400);
        expect(error.code).toBe("invalid_request_error");
        expect(error.retryable).toBe(false);
        expect(error.message).toBe("max_tokens: Field required");
      });
      expect(fake.requests).toHaveLength(1);
    });

    it("throws a fixed typed error without echoing upstream bytes on a non-JSON 200", async () => {
      const fake = installFakeFetch([
        new Response("INTERNAL_SECRET_200_OK", { status: 200, headers: { "content-type": "text/plain" } }),
      ]);
      restoreFake = fake.restore;

      const completion = completeWithAnthropicProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );
      await expect(completion).rejects.toBeInstanceOf(AiProviderError);
      await completion.catch((error: AiProviderError) => {
        expect(error.status).toBe(200);
        expect(error.code).toBe("malformed_response_body");
        expect(error.retryable).toBe(false);
        // V8 JSON parse errors embed body fragments; the typed error must not.
        expect(error.message).toBe("Provider returned a malformed response body");
        expect(error.message).not.toContain("INTERNAL_SECRET_200_OK");
        expect(error.message).not.toContain("Unexpected token");
      });
    });
  });

  describe("streaming", () => {
    it("assembles streamed text and partial_json tool calls", async () => {
      const fake = installFakeFetch([sseResponse(messageStreamLines)]);
      restoreFake = fake.restore;

      const deltas: string[] = [];
      const completion = await streamWithAnthropicProvider(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" }),
        tools,
        (delta) => deltas.push(delta)
      );

      expect(deltas).toEqual(["Hello ", "world"]);
      expect((fake.requests[0].body as { stream?: boolean }).stream).toBe(true);
      expectEquivalentCompletion(completion, {
        content: "Hello world",
        toolCalls: [{ id: "toolu_9", name: "createTask", arguments: { title: "Write tests" } }],
        truncated: false,
        stopReason: "tool_use",
        usage: { inputTokens: 12, outputTokens: 16_384, cacheReadTokens: null },
      });
    });

    it("flags truncation when message_delta reports stop_reason=max_tokens and captures usage", async () => {
      const fake = installFakeFetch([sseResponse([
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 4 } } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut off" } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 16_384 } }),
        JSON.stringify({ type: "message_stop" }),
      ])]);
      restoreFake = fake.restore;

      const completion = await streamWithAnthropicProvider(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" }),
        undefined,
        () => {}
      );

      expectEquivalentCompletion(completion, {
        content: "cut off",
        truncated: true,
        stopReason: "max_tokens",
        usage: { inputTokens: 12, outputTokens: 16_384, cacheReadTokens: 4 },
      });
    });

    it("ignores ping events cleanly", async () => {
      const fake = installFakeFetch([sseResponse([
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "ping", ping: {} }),
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        JSON.stringify({ type: "message_stop" }),
      ])]);
      restoreFake = fake.restore;

      const completion = await streamWithAnthropicProvider(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" }),
        undefined,
        () => {}
      );

      expectEquivalentCompletion(completion, { content: "pong", stopReason: "end_turn" });
    });

    it("throws AiProviderError when an error event arrives mid-stream", async () => {
      const fake = installFakeFetch([sseResponse([
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial re" } }),
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      ])]);
      restoreFake = fake.restore;

      const completion = streamWithAnthropicProvider(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" }),
        undefined,
        () => {}
      );
      await expect(completion).rejects.toBeInstanceOf(AiProviderError);
      await completion.catch((error: AiProviderError) => {
        expect(error.code).toBe("overloaded_error");
        expect(error.message).toBe("Overloaded");
        expect(error.status).toBeNull();
      });
    });
  });

  describe("retries", () => {
    it("retries a 429 honouring Retry-After with fake timers, then succeeds", async () => {
      vi.useFakeTimers();
      const fake = installFakeFetch([
        jsonResponse(
          { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
          429,
          { "retry-after": "1" }
        ),
        jsonResponse({
          content: [{ type: "text", text: "recovered" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
      ]);
      restoreFake = fake.restore;

      const pending = completeWithAnthropicProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );
      await vi.advanceTimersByTimeAsync(0); // let the first attempt reject
      await vi.runAllTimersAsync(); // cover the 1000ms Retry-After backoff

      const completion = await pending;
      expect(fake.requests).toHaveLength(2);
      expectEquivalentCompletion(completion, {
        content: "recovered",
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: null },
      });
    });

    it("does not retry a retryable status once the attempt budget is exhausted", async () => {
      const errorPayload = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
      const fake = installFakeFetch([
        jsonResponse(errorPayload, 529, { "retry-after": "0" }),
        jsonResponse(errorPayload, 529, { "retry-after": "0" }),
        jsonResponse(errorPayload, 529, { "retry-after": "0" }),
      ]);
      restoreFake = fake.restore;

      const completion = completeWithAnthropicProviderStructured(
        provider,
        makeFakeAiMessages({ role: "user", content: "hi" })
      );
      await expect(completion).rejects.toBeInstanceOf(AiProviderError);
      expect(fake.requests).toHaveLength(3);
    });

    it("never retries a non-retryable status like 400", async () => {
      const fake = installFakeFetch([
        jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }, 400),
      ]);
      restoreFake = fake.restore;

      await expect(
        completeWithAnthropicProviderStructured(provider, makeFakeAiMessages({ role: "user", content: "hi" }))
      ).rejects.toBeInstanceOf(AiProviderError);
      expect(fake.requests).toHaveLength(1);
    });
  });
});