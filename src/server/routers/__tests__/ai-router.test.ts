import { describe, expect, it } from "vitest";

import { createCallerFactory } from "@/server/trpc";
import { aiRouter } from "@/server/routers/ai";
import { createPrismaMock } from "@/test/prisma-mock";

const createCaller = createCallerFactory(aiRouter);
const projectId = "cmab8yxxp0001i7p4k8n2v3q4";
const sharedProviderId = "cmab8yxxp0002i7p4k8n2v3q5";
const projectProviderId = "cmab8yxxp0003i7p4k8n2v3q6";

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

describe("ai router deleted provider handling", () => {
  it("rejects sendMessage when the conversation provider is no longer available", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member" });
    prisma.projectMember.findUnique.mockResolvedValue({ role: "member" });
    prisma.aiConversation.findUniqueOrThrow.mockResolvedValue({
      id: "cmab8yxxp0004i7p4k8n2v3q7",
      projectId,
      createdByUserId: "user-1",
      providerId: null,
      mode: "approval",
      grantedPermissions: [],
      selectedTaskIds: [],
    });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.sendMessage({
      id: "cmab8yxxp0004i7p4k8n2v3q7",
      content: "Hello there",
    })).rejects.toThrow("The AI provider used by this conversation is no longer available. Start a new conversation to continue.");
    expect(prisma.aiMessage.create).not.toHaveBeenCalled();
  });

  it("deletes a provider even when conversations still reference it", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ role: "admin" });
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "admin", disabledAt: null });
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
    prisma.aiProviderConnection.delete.mockResolvedValue({ id: sharedProviderId });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "admin" } } as never,
    });

    await expect(caller.deleteProvider({ id: sharedProviderId })).resolves.toEqual({ success: true });
    expect(prisma.aiProviderConnection.delete).toHaveBeenCalledWith({ where: { id: sharedProviderId } });
  });
});
