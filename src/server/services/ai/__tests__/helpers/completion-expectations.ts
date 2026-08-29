import { expect } from "vitest";

import type { AiProviderCompletion } from "@/server/services/ai/provider-request";

export interface ExpectedCompletion {
  content?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
  truncated?: boolean;
  stopReason?: string | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
  } | null;
}

/**
 * Shared expectation helper: asserts the full provider-neutral completion
 * shape. Both adapters must satisfy it for equivalent fixtures, which keeps
 * their completion objects structurally identical (same key set and usage
 * normalization) rather than merely similar.
 */
export function expectEquivalentCompletion(actual: AiProviderCompletion, expected: ExpectedCompletion) {
  expect(Object.keys(actual).sort()).toEqual(["content", "stopReason", "toolCalls", "truncated", "usage"]);
  expect(actual.content).toBe(expected.content ?? "");
  expect(actual.truncated).toBe(expected.truncated ?? false);
  expect(actual.stopReason).toBe(expected.stopReason ?? null);

  if (expected.usage === undefined) {
    expect(actual.usage).toBeNull();
  } else if (expected.usage === null) {
    expect(actual.usage).toBeNull();
  } else {
    expect(actual.usage).not.toBeNull();
    expect(actual.usage).toEqual({
      inputTokens: expected.usage.inputTokens ?? null,
      outputTokens: expected.usage.outputTokens ?? null,
      cacheReadTokens: expected.usage.cacheReadTokens ?? null,
    });
  }

  expect(actual.toolCalls).toEqual(
    (expected.toolCalls ?? []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments ?? {},
    }))
  );
}