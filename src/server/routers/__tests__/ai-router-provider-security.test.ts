import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptAiSecret, encryptAiSecret } from "@/lib/ai-crypto";
import { aiRouter } from "@/server/routers/ai";
import { createCallerFactory } from "@/server/trpc";
import {
  FAKE_PROVIDER_BASE_URL,
  installFakeFetch,
  jsonResponse,
  stubFakeProviderEnv,
} from "@/server/services/ai/__tests__/helpers/fake-provider";
import { createPrismaMock, type PrismaMock } from "@/test/prisma-mock";

const createCaller = createCallerFactory(aiRouter);
const userId = "cmab8yxxu0001i7p4k8n2v3q1";
const providerId = "cmab8yxxp0004i7p4k8n2v3q4";

const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");

function buildProviderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: providerId,
    scope: "user",
    ownerUserId: userId,
    projectId: null,
    label: "Test provider",
    adapter: "openai_compatible",
    baseUrl: FAKE_PROVIDER_BASE_URL,
    model: "gpt-fake",
    encryptedSecret: encryptAiSecret("sk-router-test"),
    defaultHeaders: null,
    isEnabled: true,
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCaller(prisma: PrismaMock, role = "member") {
  return createCaller({
    prisma: prisma as never,
    session: { user: { id: userId, role } } as never,
  });
}

describe("ai router provider security", () => {
  let prisma: PrismaMock;
  let restoreEnv: (() => void) | undefined;
  let restoreFake: (() => void) | undefined;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("AUTH_SECRET", "router-test-auth-secret");
    prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: userId, role: "member" });
    prisma.user.findUnique.mockResolvedValue({ id: userId, role: "member", disabledAt: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (restoreFake) {
      restoreFake();
      restoreFake = undefined;
    }
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = undefined;
    }
  });

  describe("updateProvider validates a changed baseUrl (L2)", () => {
    it("rejects a private base URL before writing anything", async () => {
      // No allowlist, no private-host override.
      restoreEnv = stubFakeProviderEnv({ AI_PROVIDER_HOST_ALLOWLIST: "" });
      const prismaLocal = createPrismaMock();
      prismaLocal.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
      prismaLocal.user.findUnique.mockResolvedValue({ id: userId, role: "member", disabledAt: null });
      prismaLocal.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRow());

      const caller = makeCaller(prismaLocal);

      await expect(
        caller.updateProvider({ id: providerId, baseUrl: "http://192.168.1.1:9000/v1" }),
      ).rejects.toThrow(/private, loopback, or link-local/);
      expect(prismaLocal.aiProviderConnection.update).not.toHaveBeenCalled();
    });

    it("revalidates and normalizes a changed public baseUrl", async () => {
      restoreEnv = stubFakeProviderEnv({ AI_PROVIDER_HOST_ALLOWLIST: "" });
      const prismaLocal = createPrismaMock();
      prismaLocal.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
      prismaLocal.user.findUnique.mockResolvedValue({ id: userId, role: "member", disabledAt: null });
      prismaLocal.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRow());
      prismaLocal.aiProviderConnection.update.mockResolvedValue(buildProviderRow({ baseUrl: "https://api.example.com/base" }));

      const caller = makeCaller(prismaLocal);

      await caller.updateProvider({ id: providerId, baseUrl: "https://api.example.com/base/" });

      expect(prismaLocal.aiProviderConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: providerId },
          data: expect.objectContaining({ baseUrl: "https://api.example.com/base" }),
        }),
      );
    });

    it("rejects a base URL that is not on the configured allowlist", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com";
      const prismaLocal = createPrismaMock();
      prismaLocal.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
      prismaLocal.user.findUnique.mockResolvedValue({ id: userId, role: "member", disabledAt: null });
      prismaLocal.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRow());

      const caller = makeCaller(prismaLocal);

      await expect(caller.updateProvider({ id: providerId, baseUrl: "https://other.example.com/v1" })).rejects.toThrow(
        /not present in the allowlist/,
      );
      expect(prismaLocal.aiProviderConnection.update).not.toHaveBeenCalled();
    });
  });

  describe("testProvider must never reflect upstream response bytes (M2)", () => {
    it("maps a non-JSON 200 response to a fixed summary without body fragments", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "127.0.0.1:8787";
      prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRow());

      const fake = installFakeFetch([
        new Response("INTERNAL_SECRET_200_OK", { status: 200, headers: { "content-type": "text/plain" } }),
      ]);
      restoreFake = fake.restore;

      const caller = makeCaller(prisma);
      const promise = caller.testProvider({ id: providerId });

      await expect(promise).rejects.toThrow(/Provider test completed with status 200: Provider returned a malformed response body/);
      await promise.catch((error: Error) => {
        expect(error.message).not.toContain("INTERNAL_SECRET_200_OK");
        expect(error.message).not.toContain("Unexpected token");
        expect(error.message).not.toContain(decryptAiSecret(buildProviderRow().encryptedSecret));
      });
      expect(fake.requests).toHaveLength(1);
    });

    it("reports a successful test without echoing any upstream content", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "127.0.0.1:8787";
      prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRow());

      const fake = installFakeFetch([
        jsonResponse({
          choices: [{ message: { content: "OK plus SUPER_SECRET_MODEL_BYTES" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
      ]);
      restoreFake = fake.restore;

      const caller = makeCaller(prisma);
      const result = await caller.testProvider({ id: providerId });

      expect(result.success).toBe(true);
      expect(result.responsePreview).toContain("Provider test completed with status 200");
      expect(result.responsePreview).toContain("Upstream accepted the request.");
      expect(result.responsePreview).not.toContain("SUPER_SECRET_MODEL_BYTES");
    });

    it("falls back to a fixed message for arbitrary (non-typed) errors instead of interpolating Error.message", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "127.0.0.1:8787";
      prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRow());

      const fake = installFakeFetch([
        () => {
          throw new TypeError("fetch failed");
        },
      ]);
      restoreFake = fake.restore;

      const caller = makeCaller(prisma);

      await expect(caller.testProvider({ id: providerId })).rejects.toThrow("Provider test failed: AI provider request failed");
    });
  });
});