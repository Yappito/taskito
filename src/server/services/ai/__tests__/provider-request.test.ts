import { afterEach, describe, expect, it } from "vitest";

import { getAiProviderRequestTimeoutMs, normalizeAiProviderRequestError } from "@/server/services/ai/provider-request";

const originalTimeout = process.env.AI_PROVIDER_REQUEST_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env.AI_PROVIDER_REQUEST_TIMEOUT_MS;
    return;
  }

  process.env.AI_PROVIDER_REQUEST_TIMEOUT_MS = originalTimeout;
});

describe("ai provider request helpers", () => {
  it("uses the default timeout when no env override is set", () => {
    delete process.env.AI_PROVIDER_REQUEST_TIMEOUT_MS;
    expect(getAiProviderRequestTimeoutMs()).toBe(90_000);
  });

  it("uses a valid env timeout override", () => {
    process.env.AI_PROVIDER_REQUEST_TIMEOUT_MS = "45000";
    expect(getAiProviderRequestTimeoutMs()).toBe(45_000);
  });

  it("converts upstream timeout errors into a clearer message", () => {
    const error = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(normalizeAiProviderRequestError(error, 90_000).message).toBe("AI provider request timed out after 90 seconds");
  });
});
