import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

import {
  assertAiProviderBaseUrlFetchAllowed,
  normalizeAiProviderHeaders,
  normalizeAiProviderModel,
  validateAiProviderBaseUrl,
} from "@/lib/ai-provider-validation";

describe("ai-provider-validation", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("normalizes a valid provider URL", () => {
    expect(validateAiProviderBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });

  it("allows HTTP provider URLs", () => {
    expect(validateAiProviderBaseUrl("http://api.example.com/v1")).toBe("http://api.example.com/v1");
  });

  it("allows loopback hosts for local providers", () => {
    expect(validateAiProviderBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
  });

  it("allows private IP provider URLs", () => {
    expect(validateAiProviderBaseUrl("https://10.0.0.5/v1")).toBe("https://10.0.0.5/v1");
  });

  it("allows resolved loopback or private addresses during provider fetches", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(assertAiProviderBaseUrlFetchAllowed("http://localhost:11434")).resolves.toBe("http://localhost:11434");
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
