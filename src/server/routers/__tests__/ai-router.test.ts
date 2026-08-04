import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptAiSecret } from "@/lib/ai-crypto";
import { createCallerFactory } from "@/server/trpc";
import { aiRouter } from "@/server/routers/ai";

vi.mock("@/server/services/ai/provider-anthropic", () => ({
  completeWithAnthropicProvider: vi.fn(async () => "OK"),
  completeWithAnthropicProviderStructured: vi.fn(),
  streamWithAnthropicProvider: vi.fn(),
}));

vi.mock("@/server/services/ai/provider-openai-compatible", () => ({
  completeWithOpenAiCompatibleProvider: vi.fn(async () => "OK"),
  completeWithOpenAiCompatibleProviderStructured: vi.fn(),
  streamWithOpenAiCompatibleProvider: vi.fn(),
}));

const createCaller = createCallerFactory(aiRouter);
const projectId = "cmab8yxxp0001i7p4k8n2v3q4";
const sharedProviderId = "cmab8yxxp0002i7p4k8n2v3q5";
const projectProviderId = "cmab8yxxp0003i7p4k8n2v3q6";
const userProviderId = "cmab8yxxp0004i7p4k8n2v3q7";

const originalMasterKey = process.env.AI_SECRET_MASTER_KEY;

beforeEach(() => {
  process.env.AI_SECRET_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  if (originalMasterKey === undefined) {
    delete process.env.AI_SECRET_MASTER_KEY;
    return;
  }

  process.env.AI_SECRET_MASTER_KEY = originalMasterKey;
});

function createPrismaMock() {
  return {
    user: {
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(),
    },
    projectMember: {
      findUnique: vi.fn(),
    },
    aiProviderConnection: {
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    aiProjectPolicy: {
      findUnique: vi.fn(),
    },
    task: {
      count: vi.fn(),
    },
  } as const;
}

describe("ai router provider visibility", () => {
  it("redacts shared provider configuration in chat scope for project members", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member" });
    prisma.projectMember.findUnique.mockResolvedValue({ role: "member" });
    prisma.aiProviderConnection.findMany.mockResolvedValue([
      {
        id: sharedProviderId,
        scope: "shared",
        ownerUserId: null,
        projectId: null,
        label: "Shared OpenAI",
        adapter: "openai_compatible",
        baseUrl: "http://ollama.local:11434/v1",
        model: "llama3.1",
        defaultHeaders: null,
        isEnabled: true,
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    const providers = await caller.listProviders({ projectId, actorScope: "chat" });

    expect(providers).toEqual([
      expect.objectContaining({
        id: sharedProviderId,
        scope: "shared",
        label: "Shared OpenAI",
        adapter: null,
        baseUrl: null,
        model: null,
        canManage: false,
      }),
    ]);
  });

  it("includes shared provider configuration in manage scope for project owners", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member" });
    prisma.projectMember.findUnique.mockResolvedValue({ role: "owner" });
    prisma.aiProviderConnection.findMany.mockResolvedValue([
      {
        id: projectProviderId,
        scope: "project",
        ownerUserId: null,
        projectId,
        label: "Project Claude",
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-20250514",
        defaultHeaders: null,
        isEnabled: true,
        isDefault: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: sharedProviderId,
        scope: "shared",
        ownerUserId: null,
        projectId: null,
        label: "Shared OpenAI",
        adapter: "openai_compatible",
        baseUrl: "http://ollama.local:11434/v1",
        model: "llama3.1",
        defaultHeaders: null,
        isEnabled: true,
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    const providers = await caller.listProviders({ projectId, actorScope: "manage" });

    expect(providers).toEqual([
      expect.objectContaining({
        id: projectProviderId,
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-20250514",
        canManage: true,
      }),
      expect.objectContaining({
        id: sharedProviderId,
        adapter: null,
        baseUrl: null,
        model: null,
        canManage: false,
      }),
    ]);
  });

  it("allows shared providers for project conversations only when enabled by policy", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ role: "member" })
      .mockResolvedValueOnce({ role: "member" });
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member" });
    prisma.projectMember.findUnique.mockResolvedValue({ role: "member" });
    prisma.aiProjectPolicy.findUnique.mockResolvedValue({
      projectId,
      defaultProviderId: null,
      allowUserProviders: true,
      allowProjectProviders: true,
      allowSharedProviders: false,
      allowYoloMode: true,
      defaultPermissions: ["read_current_task", "read_selected_tasks", "search_project"],
      maxPermissions: ["read_current_task", "read_selected_tasks", "search_project"],
    });
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue({
      id: sharedProviderId,
      scope: "shared",
      ownerUserId: null,
      projectId: null,
      label: "Shared OpenAI",
      adapter: "openai_compatible",
      baseUrl: "http://ollama.local:11434/v1",
      model: "llama3.1",
      encryptedSecret: "secret",
      defaultHeaders: null,
      isEnabled: true,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.startConversation({
      projectId,
      providerId: sharedProviderId,
      mode: "approval",
      grantedPermissions: [],
    })).rejects.toThrow(/Shared AI providers are disabled/);
  });
});

describe("ai router provider secret reveal", () => {
  function buildProviderRecord(overrides: Partial<Record<string, unknown>>) {
    return {
      id: sharedProviderId,
      scope: "shared",
      ownerUserId: null,
      projectId: null,
      label: "Shared OpenAI",
      adapter: "openai_compatible",
      baseUrl: "http://ollama.local:11434/v1",
      model: "llama3.1",
      encryptedSecret: encryptAiSecret("super-secret-token"),
      defaultHeaders: null,
      isEnabled: true,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("returns the decrypted secret for global admins", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "admin" });
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "admin" });
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRecord({}));

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "admin" } } as never,
    });

    await expect(caller.revealProviderSecret({ id: sharedProviderId })).resolves.toEqual({
      secret: "super-secret-token",
    });
  });

  it("blocks non-admin members from revealing a shared provider secret", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member" });
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRecord({}));

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.revealProviderSecret({ id: sharedProviderId }))
      .rejects.toThrow(/do not have access to this provider/);
  });

  it("blocks project members from revealing a project provider secret even with ai_manage", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "member",
      disabledAt: null,
      projectMemberships: [{ role: "manager" }],
      projectPermissionGrants: [],
      groupMemberships: [],
    });
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue({
      id: projectProviderId,
      scope: "project",
      ownerUserId: null,
      projectId,
      label: "Project Claude",
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-20250514",
      encryptedSecret: encryptAiSecret("super-secret-token"),
      defaultHeaders: null,
      isEnabled: true,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.revealProviderSecret({ id: projectProviderId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks even the owner of a user-scoped provider from revealing its secret", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member" });
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRecord({
      id: userProviderId,
      scope: "user",
      ownerUserId: "user-1",
    }));

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.revealProviderSecret({ id: userProviderId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ai router provider testing", () => {
  function buildProjectProviderRecord() {
    return {
      id: projectProviderId,
      scope: "project",
      ownerUserId: null,
      projectId,
      label: "Project Claude",
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-20250514",
      encryptedSecret: encryptAiSecret("super-secret-token"),
      defaultHeaders: null,
      isEnabled: true,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  function buildMemberUser(role: "viewer" | "manager") {
    return {
      id: "user-1",
      role: "member",
      disabledAt: null,
      projectMemberships: [{ role }],
      projectPermissionGrants: [],
      groupMemberships: [],
    };
  }

  it("requires ai_manage for project-scoped providers", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
    prisma.user.findUnique.mockResolvedValue(buildMemberUser("viewer"));
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProjectProviderRecord());

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.testProvider({ id: projectProviderId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows members with ai_manage to test project-scoped providers", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "member" });
    prisma.user.findUnique.mockResolvedValue(buildMemberUser("manager"));
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProjectProviderRecord());

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.testProvider({ id: projectProviderId })).resolves.toMatchObject({
      success: true,
      label: "Project Claude",
      adapter: "anthropic",
      responsePreview: "OK",
    });
  });
});
