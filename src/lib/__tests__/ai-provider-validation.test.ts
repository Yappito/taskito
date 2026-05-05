import { describe, expect, it } from "vitest";

import { normalizeAiProviderHeaders, normalizeAiProviderModel, validateAiProviderBaseUrl } from "@/lib/ai-provider-validation";

describe("ai-provider-validation", () => {
  it("normalizes a valid provider URL", () => {
    expect(validateAiProviderBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });

  it("rejects loopback hosts", () => {
    expect(() => validateAiProviderBaseUrl("http://localhost:11434")).toThrow(/Loopback/);
  });

  it("rejects non-HTTPS public provider URLs unless allowlisted", () => {
    expect(() => validateAiProviderBaseUrl("http://api.example.com/v1")).toThrow(/HTTPS/);
  });

  it("rejects private IP provider URLs", () => {
    expect(() => validateAiProviderBaseUrl("https://10.0.0.5/v1")).toThrow(/private or reserved/);
  });

  it("normalizes provider model names", () => {
    expect(normalizeAiProviderModel(" gpt-4.1-mini ")).toBe("gpt-4.1-mini");
  });

  it("normalizes string headers", () => {
    expect(normalizeAiProviderHeaders({ "X-Test": " value " })).toEqual({ "X-Test": "value" });
  });

  it("rejects reserved provider headers", () => {
    expect(() => normalizeAiProviderHeaders({ Authorization: "Bearer x" })).toThrow(/managed by Taskito/);
  });
});
