import type { LookupAddress } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn<(hostname: string, options: { all: true; verbatim?: boolean }) => Promise<LookupAddress[]>>(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

import {
  assertAiProviderBaseUrlFetchAllowed,
  normalizeAiProviderHeaders,
  normalizeAiProviderModel,
  validateAiProviderBaseUrl,
} from "@/lib/ai-provider-validation";

const originalAllowlist = process.env.AI_PROVIDER_HOST_ALLOWLIST;

afterEach(() => {
  if (originalAllowlist === undefined) {
    delete process.env.AI_PROVIDER_HOST_ALLOWLIST;
    return;
  }

  process.env.AI_PROVIDER_HOST_ALLOWLIST = originalAllowlist;
});

describe("ai-provider-validation", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER_HOST_ALLOWLIST;
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

  it("rejects provider hosts that cannot be resolved", async () => {
    lookupMock.mockResolvedValue([]);

    await expect(assertAiProviderBaseUrlFetchAllowed("https://api.example.com/v1")).rejects.toThrow(/could not be resolved/);
  });

  it("allows allowlisted hosts during provider fetches", async () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    await expect(assertAiProviderBaseUrlFetchAllowed("https://api.example.com/v1")).resolves.toBe("https://api.example.com/v1");
  });

  it("rejects hosts that are not present in the allowlist", async () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    await expect(assertAiProviderBaseUrlFetchAllowed("https://other.example.com/v1")).rejects.toThrow(/not present in the allowlist/);
  });

  it("allows hosts that resolve to an allowlisted IP entry", async () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "10.0.0.5";
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    await expect(assertAiProviderBaseUrlFetchAllowed("http://10.0.0.5/v1")).resolves.toBe("http://10.0.0.5/v1");
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
