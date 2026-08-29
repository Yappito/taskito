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

  // CITADEL-amv (finding 12): the one-shot fast path (default provider) must
  // enforce the exact same policy clamps as the fallback scan — scope allow
  // flags, project association for project providers, and ownership for user
  // providers.
  describe("one-shot default provider policy clamp (citadel-amv, finding 12)", () => {
    const projectId = "clxproject00000000000000000";
    const otherProjectId = "clxproject00000000000099999";
    const projectDefaultId = "clxprovider0000000000000001";
    const sharedDefaultId = "clxprovider0000000000000002";

    function buildProjectDefault(overrides: Record<string, unknown> = {}) {
      return {
        id: projectDefaultId,
        scope: "project",
        ownerUserId: null,
        projectId,
        label: "Project default",
        adapter: "openai_compatible",
        baseUrl: FAKE_PROVIDER_BASE_URL,
        model: "gpt-fake",
        encryptedSecret: encryptAiSecret("sk-router-test"),
        defaultHeaders: null,
        isEnabled: true,
        isDefault: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
    }

    function buildSharedDefault(overrides: Record<string, unknown> = {}) {
      return {
        ...buildProjectDefault(),
        id: sharedDefaultId,
        scope: "shared",
        ownerUserId: null,
        projectId: null,
        label: "Shared default",
        ...overrides,
      };
    }

    function buildPolicy(overrides: Record<string, unknown> = {}) {
      return {
        projectId,
        defaultProviderId: projectDefaultId,
        allowUserProviders: true,
        allowProjectProviders: true,
        allowSharedProviders: true,
        allowYoloMode: true,
        allowYoloDestructive: false,
        defaultPermissions: [],
        maxPermissions: [],
        ...overrides,
      };
    }

    function wireDefaultPath(options: {
      policy: Record<string, unknown> | null;
      defaultProvider: Record<string, unknown> | null;
      fallbackProvider?: Record<string, unknown> | null;
    }) {
      // Admin callers: requireProjectAccess/requireTaskAccess short-circuit via
      // the user row mock, so it must carry the admin role.
      prisma.user.findUnique.mockResolvedValue({ id: userId, role: "admin", disabledAt: null });
      prisma.aiProjectPolicy.findUnique.mockResolvedValue(options.policy);
      prisma.aiProviderConnection.findUnique.mockResolvedValue(options.defaultProvider);
      prisma.aiProviderConnection.findFirst.mockResolvedValue(options.fallbackProvider ?? null);
    }

    it("ignores a project default provider when allowProjectProviders is false", async () => {
      wireDefaultPath({ policy: buildPolicy({ allowProjectProviders: false }), defaultProvider: buildProjectDefault() });

      const caller = makeCaller(prisma, "admin");
      const result = await caller.hasUsableProvider({ projectId });

      expect(result.hasUsableProvider).toBe(false);
    });

    it("refuses the one-shot features when only a policy-clamped project default exists", async () => {
      wireDefaultPath({ policy: buildPolicy({ allowProjectProviders: false }), defaultProvider: buildProjectDefault() });
      prisma.task.findUnique.mockResolvedValue({
        id: "clxtask0000000000000000000",
        projectId,
        taskNumber: 7,
        title: "Any task",
        aiSummary: null,
        comments: [],
        updatedAt: new Date(),
      });
      prisma.task.findUniqueOrThrow.mockResolvedValue({
        id: "clxtask0000000000000000000",
        projectId,
        taskNumber: 7,
        title: "Any task",
        project: { key: "TASK" },
      });
      const parseCaller = makeCaller(prisma, "admin");

      await expect(parseCaller.parseTask({ projectId, text: "hello" })).rejects.toThrow(
        "No AI provider is available for this project",
      );
      await expect(parseCaller.summarizeTask({ taskId: "clxtask0000000000000000000" })).rejects.toThrow(
        "No AI provider is available for this project",
      );
      await expect(parseCaller.startBreakdown({ taskId: "clxtask0000000000000000000" })).rejects.toThrow(
        "No AI provider is available for this project",
      );
      expect(prisma.aiConversation.create).not.toHaveBeenCalled();
    });

    it("ignores a shared default provider when allowSharedProviders is false", async () => {
      wireDefaultPath({
        policy: buildPolicy({ defaultProviderId: sharedDefaultId, allowSharedProviders: false }),
        defaultProvider: buildSharedDefault(),
      });

      const caller = makeCaller(prisma, "admin");
      const result = await caller.hasUsableProvider({ projectId });

      expect(result.hasUsableProvider).toBe(false);
    });

    it("rejects a project default provider that belongs to a different project", async () => {
      wireDefaultPath({
        policy: buildPolicy(),
        defaultProvider: buildProjectDefault({ projectId: otherProjectId }),
      });

      const caller = makeCaller(prisma, "admin");
      const result = await caller.hasUsableProvider({ projectId });

      expect(result.hasUsableProvider).toBe(false);
    });

    it("skips a clamped default but still uses a policy-allowed fallback provider", async () => {
      restoreEnv = stubFakeProviderEnv();
      const fallback = buildProjectDefault({ scope: "user", ownerUserId: userId, projectId: null, isDefault: false, id: "clxprovider0000000000000003" });
      wireDefaultPath({
        policy: buildPolicy({ allowProjectProviders: false }),
        defaultProvider: buildProjectDefault(),
        fallbackProvider: fallback,
      });
      prisma.workflowStatus.findMany.mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);
      prisma.tag.findMany.mockResolvedValue([]);

      const fake = installFakeFetch([
        jsonResponse({
          choices: [{ message: { content: JSON.stringify({ title: "From fallback" }), finish_reason: "stop" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ]);
      restoreFake = fake.restore;

      const caller = makeCaller(prisma, "admin");
      expect((await caller.hasUsableProvider({ projectId })).hasUsableProvider).toBe(true);

      const parsed = await caller.parseTask({ projectId, text: "From fallback" });
      expect(parsed.draft.title).toBe("From fallback");
      // The request went to the fallback provider row, never the clamped default.
      expect(fake.requests).toHaveLength(1);
    });

    it("createProjectProvider refuses to install a default while project providers are disabled", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: userId, role: "admin", disabledAt: null });
      prisma.aiProjectPolicy.findUnique.mockResolvedValue(buildPolicy({ allowProjectProviders: false }));

      const caller = makeCaller(prisma, "admin");

      await expect(
        caller.createProjectProvider({
          projectId,
          label: "Sneaky default",
          adapter: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          model: "gpt-x",
          secret: "sk-test",
          isEnabled: true,
          isDefault: true,
        }),
      ).rejects.toThrow("Project providers must be allowed to use a project default provider");
      expect(prisma.aiProviderConnection.create).not.toHaveBeenCalled();
      expect(prisma.aiProjectPolicy.upsert).not.toHaveBeenCalled();
    });

    it("updateProvider refuses to flag a project provider as default while project providers are disabled", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: userId, role: "admin", disabledAt: null });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: userId, role: "admin" });
      prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProjectDefault());
      prisma.aiProjectPolicy.findUnique.mockResolvedValue(buildPolicy({ allowProjectProviders: false }));

      const caller = makeCaller(prisma, "admin");

      await expect(caller.updateProvider({ id: projectDefaultId, isDefault: true })).rejects.toThrow(
        "Project providers must be allowed to use a project default provider",
      );
      expect(prisma.aiProviderConnection.update).not.toHaveBeenCalled();
      expect(prisma.aiProjectPolicy.upsert).not.toHaveBeenCalled();
    });
  });
});