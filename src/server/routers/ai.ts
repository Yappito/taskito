import { Prisma, type AiActionExecution, type AiMessage } from "@prisma/client";
import { z } from "zod";

import { decryptAiSecret, encryptAiSecret } from "@/lib/ai-crypto";
import { normalizeAiPermissions } from "@/lib/ai-permissions";
import { normalizeAiProviderHeaders, normalizeAiProviderModel, validateAiProviderBaseUrl } from "@/lib/ai-provider-validation";
import { AI_PERMISSION_PRESETS, AI_PERMISSION_VALUES, type AiPermission } from "@/lib/ai-types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { appendAiAssistantTurn } from "@/server/services/ai/orchestrator";
import { executeAiAction } from "@/server/services/ai/action-executor";
import { rollbackAiActionCheckpoint } from "@/server/services/ai/checkpoints";
import { normalizeAiConversationTitle } from "@/server/services/ai/presenter";
import { completeWithAnthropicProvider } from "@/server/services/ai/provider-anthropic";
import { completeWithOpenAiCompatibleProvider } from "@/server/services/ai/provider-openai-compatible";
import { resolveAiProvider } from "@/server/services/ai/provider-registry";
import { getRequiredPermissionsForActionPayload, resolveAiActionPayload } from "@/server/services/ai/tools";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

const providerInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  adapter: z.enum(["openai_compatible", "anthropic"]),
  baseUrl: z.string().min(1).max(500),
  model: z.string().min(1).max(200),
  secret: z.string().min(1).max(5000),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  isEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

const providerUpdateInputSchema = providerInputSchema.omit({ secret: true }).partial().extend({
  id: z.string().cuid(),
  secret: z.string().max(5000).optional(),
});

const projectPolicySchema = z.object({
  defaultProviderId: z.string().cuid().nullable().optional(),
  allowUserProviders: z.boolean(),
  allowProjectProviders: z.boolean(),
  allowYoloMode: z.boolean(),
  defaultPermissions: z.array(z.enum(AI_PERMISSION_VALUES)).default([]),
  maxPermissions: z.array(z.enum(AI_PERMISSION_VALUES)).default([]),
});

const conversationPermissionEnum = z.enum(AI_PERMISSION_VALUES);
const DEFAULT_AI_POLICY_DEFAULT_PERMISSIONS = [...AI_PERMISSION_PRESETS.read_only] satisfies AiPermission[];
const DEFAULT_AI_POLICY_MAX_PERMISSIONS = [...AI_PERMISSION_VALUES] satisfies AiPermission[];

type PrismaClient = typeof import("@/lib/prisma").prisma;

function mapExecutionForClient(execution: AiActionExecution) {
  return {
    ...execution,
    proposedPayload: execution.proposedPayload as Record<string, unknown>,
    executedPayload: execution.executedPayload as Record<string, unknown> | null,
    result: execution.result as Record<string, unknown> | null,
  };
}

async function getEffectiveProjectAiPolicy(prisma: PrismaClient, projectId: string) {
  const policy = await prisma.aiProjectPolicy.findUnique({ where: { projectId } });
  const maxPermissions = normalizeAiPermissions(policy?.maxPermissions ?? DEFAULT_AI_POLICY_MAX_PERMISSIONS);
  const defaultPermissions = normalizeAiPermissions(policy?.defaultPermissions ?? DEFAULT_AI_POLICY_DEFAULT_PERMISSIONS)
    .filter((permission) => maxPermissions.includes(permission));

  return {
    defaultProviderId: policy?.defaultProviderId ?? null,
    allowUserProviders: policy?.allowUserProviders ?? true,
    allowProjectProviders: policy?.allowProjectProviders ?? true,
    allowYoloMode: policy?.allowYoloMode ?? true,
    defaultPermissions,
    maxPermissions,
  };
}

async function normalizeSelectedTaskIdsOrThrow(prisma: PrismaClient, projectId: string, selectedTaskIds: string[] | undefined) {
  const normalized = [...new Set(selectedTaskIds ?? [])];
  if (normalized.length > 100) {
    throw new Error("AI conversations can include at most 100 selected tasks");
  }

  if (normalized.length === 0) {
    return normalized;
  }

  const matchingTaskCount = await prisma.task.count({
    where: {
      projectId,
      id: { in: normalized },
    },
  });

  if (matchingTaskCount !== normalized.length) {
    throw new Error("One or more selected tasks are missing or outside the project");
  }

  return normalized;
}

async function getUsableProviderForProjectOrThrow(
  prisma: PrismaClient,
  userId: string,
  input: {
    projectId: string;
    providerId: string;
    mode: "approval" | "yolo";
  }
) {
  const policy = await getEffectiveProjectAiPolicy(prisma, input.projectId);
  if (input.mode === "yolo" && !policy.allowYoloMode) {
    throw new Error("Yolo mode is disabled for this project");
  }

  const provider = await getVisibleProviderOrThrow(prisma, userId, input.providerId, input.projectId);
  if (!provider.isEnabled) {
    throw new Error("Selected provider is disabled");
  }

  if (provider.scope === "user" && !policy.allowUserProviders) {
    throw new Error("Personal AI providers are disabled for this project");
  }

  if (provider.scope === "project" && !policy.allowProjectProviders) {
    throw new Error("Project AI providers are disabled for this project");
  }

  return { provider, policy };
}

function getEffectiveConversationPermissions(policy: Awaited<ReturnType<typeof getEffectiveProjectAiPolicy>>, grantedPermissions: unknown) {
  const granted = normalizeAiPermissions(grantedPermissions);
  return granted.filter((permission) => policy.maxPermissions.includes(permission));
}

function getConversationSelectedTaskIds(conversation: { selectedTaskIds: unknown }) {
  return Array.isArray(conversation.selectedTaskIds) ? (conversation.selectedTaskIds as string[]) : [];
}

async function assertAiActionStillAllowed(
  prisma: PrismaClient,
  execution: AiActionExecution & { conversation: { grantedPermissions: unknown; selectedTaskIds: unknown } }
) {
  const policy = await getEffectiveProjectAiPolicy(prisma, execution.projectId);
  const selectedTaskIds = getConversationSelectedTaskIds(execution.conversation);
  const payload = await resolveAiActionPayload(prisma, execution.projectId, execution.actionType, execution.proposedPayload, { selectedTaskIds });
  const effectivePermissions = getEffectiveConversationPermissions(policy, execution.conversation.grantedPermissions);
  const grantedSet = new Set(effectivePermissions);
  const requiredPermissions = getRequiredPermissionsForActionPayload(execution.actionType, payload);

  if (!requiredPermissions.every((permission) => grantedSet.has(permission))) {
    throw new Error("This AI action is no longer allowed by the current project policy or conversation permissions");
  }

  return { selectedTaskIds };
}

async function runProviderTest(providerRecord: Awaited<ReturnType<typeof getVisibleProviderOrThrow>>) {
  const provider = resolveAiProvider(providerRecord);
  const messages = [
    {
      id: "provider-test",
      conversationId: "provider-test",
      role: "user",
      content: "Reply with exactly: OK",
      toolName: null,
      toolPayload: null,
      createdAt: new Date(),
    },
  ] satisfies AiMessage[];
  const content = provider.adapter === "anthropic"
    ? await completeWithAnthropicProvider(provider, messages)
    : await completeWithOpenAiCompatibleProvider(provider, messages);

  return content.slice(0, 500);
}

async function getVisibleProviderOrThrow(
  prisma: PrismaClient,
  userId: string,
  providerId: string,
  projectId?: string
) {
  const provider = await prisma.aiProviderConnection.findUniqueOrThrow({
    where: { id: providerId },
  });

  if (provider.scope === "user") {
    if (provider.ownerUserId !== userId) {
      throw new Error("You do not have access to this provider");
    }
    return provider;
  }

  if (!provider.projectId) {
    throw new Error("Project-scoped provider is missing a project association");
  }

  await requireProjectAccess(prisma, userId, provider.projectId);
  if (projectId && provider.projectId !== projectId) {
    throw new Error("Provider does not belong to the selected project");
  }

  return provider;
}

export const aiRouter = createTRPCRouter({
  listProviders: protectedProcedure
    .input(z.object({ projectId: z.string().cuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const projectId = input?.projectId;
      if (projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, projectId);
      }

      const providerVisibilityClauses: Prisma.AiProviderConnectionWhereInput[] = [
        { scope: "user", ownerUserId: ctx.session.user.id },
      ];

      if (projectId) {
        providerVisibilityClauses.push({ scope: "project", projectId });
      }

      return ctx.prisma.aiProviderConnection.findMany({
        where: {
          OR: providerVisibilityClauses,
        },
        orderBy: [{ scope: "asc" }, { label: "asc" }],
        select: {
          id: true,
          scope: true,
          ownerUserId: true,
          projectId: true,
          label: true,
          adapter: true,
          baseUrl: true,
          model: true,
          defaultHeaders: true,
          isEnabled: true,
          isDefault: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }),

  createUserProvider: protectedProcedure
    .input(providerInputSchema)
    .mutation(async ({ ctx, input }) => {
      const normalizedBaseUrl = validateAiProviderBaseUrl(input.baseUrl);
      const normalizedHeaders = normalizeAiProviderHeaders(input.defaultHeaders);
      const model = normalizeAiProviderModel(input.model);

      if (input.isDefault) {
        await ctx.prisma.aiProviderConnection.updateMany({
          where: { scope: "user", ownerUserId: ctx.session.user.id },
          data: { isDefault: false },
        });
      }

      return ctx.prisma.aiProviderConnection.create({
        data: {
          scope: "user",
          ownerUserId: ctx.session.user.id,
          label: input.label,
          adapter: input.adapter,
          baseUrl: normalizedBaseUrl,
          model,
          encryptedSecret: encryptAiSecret(input.secret),
          defaultHeaders: normalizedHeaders as Prisma.InputJsonValue,
          isEnabled: input.isEnabled,
          isDefault: input.isDefault,
        },
      });
    }),

  createProjectProvider: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }).merge(providerInputSchema))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { minimumRole: "owner" });

      const normalizedBaseUrl = validateAiProviderBaseUrl(input.baseUrl);
      const normalizedHeaders = normalizeAiProviderHeaders(input.defaultHeaders);
      const model = normalizeAiProviderModel(input.model);

      if (input.isDefault) {
        await ctx.prisma.aiProviderConnection.updateMany({
          where: { scope: "project", projectId: input.projectId },
          data: { isDefault: false },
        });
      }

      const provider = await ctx.prisma.aiProviderConnection.create({
        data: {
          scope: "project",
          projectId: input.projectId,
          label: input.label,
          adapter: input.adapter,
          baseUrl: normalizedBaseUrl,
          model,
          encryptedSecret: encryptAiSecret(input.secret),
          defaultHeaders: normalizedHeaders as Prisma.InputJsonValue,
          isEnabled: input.isEnabled,
          isDefault: input.isDefault,
        },
      });

      if (input.isDefault) {
        await ctx.prisma.aiProjectPolicy.upsert({
          where: { projectId: input.projectId },
          create: {
            projectId: input.projectId,
            defaultProviderId: provider.id,
            allowYoloMode: true,
            defaultPermissions: DEFAULT_AI_POLICY_DEFAULT_PERMISSIONS as Prisma.InputJsonValue,
            maxPermissions: DEFAULT_AI_POLICY_MAX_PERMISSIONS as Prisma.InputJsonValue,
          },
          update: {
            defaultProviderId: provider.id,
          },
        });
      }

      return provider;
    }),

  updateProvider: protectedProcedure
    .input(providerUpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.id);
      if (provider.scope === "project" && provider.projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, provider.projectId, { minimumRole: "owner" });
      }

      const baseUrl = input.baseUrl ? validateAiProviderBaseUrl(input.baseUrl) : undefined;
      const model = input.model ? normalizeAiProviderModel(input.model) : undefined;
      const defaultHeaders = input.defaultHeaders ? normalizeAiProviderHeaders(input.defaultHeaders) : undefined;
      const secret = input.secret?.trim();

      if (input.isDefault) {
        await ctx.prisma.aiProviderConnection.updateMany({
          where:
            provider.scope === "user"
              ? { scope: "user", ownerUserId: provider.ownerUserId }
              : { scope: "project", projectId: provider.projectId },
          data: { isDefault: false },
        });
      }

      const updatedProvider = await ctx.prisma.aiProviderConnection.update({
        where: { id: input.id },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(secret ? { encryptedSecret: encryptAiSecret(secret) } : {}),
          ...(defaultHeaders !== undefined ? { defaultHeaders: defaultHeaders as Prisma.InputJsonValue } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });

      if (provider.scope === "project" && provider.projectId) {
        if (input.isDefault === true) {
          await ctx.prisma.aiProjectPolicy.upsert({
            where: { projectId: provider.projectId },
            create: {
              projectId: provider.projectId,
              defaultProviderId: provider.id,
              allowYoloMode: true,
              defaultPermissions: DEFAULT_AI_POLICY_DEFAULT_PERMISSIONS as Prisma.InputJsonValue,
              maxPermissions: DEFAULT_AI_POLICY_MAX_PERMISSIONS as Prisma.InputJsonValue,
            },
            update: {
              defaultProviderId: provider.id,
            },
          });
        }

        if (input.isDefault === false) {
          await ctx.prisma.aiProjectPolicy.updateMany({
            where: { projectId: provider.projectId, defaultProviderId: provider.id },
            data: { defaultProviderId: null },
          });
        }
      }

      return updatedProvider;
    }),

  deleteProvider: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.id);
      if (provider.scope === "project" && provider.projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, provider.projectId, { minimumRole: "owner" });
        await ctx.prisma.aiProjectPolicy.updateMany({
          where: { projectId: provider.projectId, defaultProviderId: provider.id },
          data: { defaultProviderId: null },
        });
      }

      await ctx.prisma.aiProviderConnection.delete({ where: { id: input.id } });
      return { success: true };
    }),

  revealProviderSecret: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.id);
      if (provider.scope === "project" && provider.projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, provider.projectId, { minimumRole: "owner" });
      }

      return { secret: decryptAiSecret(provider.encryptedSecret) };
    }),

  testProvider: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const rateLimit = consumeRateLimit("ai-provider-test", ctx.session.user.id, {
        maxAttempts: 10,
        windowMs: 60 * 1000,
      });

      if (!rateLimit.allowed) {
        throw new Error("AI provider test rate limit exceeded");
      }

      const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.id);
      const responsePreview = await runProviderTest(provider);
      return {
        success: true,
        label: provider.label,
        adapter: provider.adapter,
        model: provider.model,
        responsePreview,
      };
    }),

  getProjectPolicy: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return getEffectiveProjectAiPolicy(ctx.prisma, input.projectId);
    }),

  updateProjectPolicy: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), policy: projectPolicySchema }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { minimumRole: "owner" });
      const maxPermissions = normalizeAiPermissions(input.policy.maxPermissions);
      const defaultPermissions = normalizeAiPermissions(input.policy.defaultPermissions)
        .filter((permission) => maxPermissions.includes(permission));

      if (input.policy.defaultProviderId && !input.policy.allowProjectProviders) {
        throw new Error("Project providers must be allowed to use a project default provider");
      }

      if (input.policy.defaultProviderId) {
        const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.policy.defaultProviderId, input.projectId);
        if (provider.scope === "user") {
          throw new Error("Project default provider must be project-scoped");
        }
        if (!provider.isEnabled) {
          throw new Error("Project default provider must be enabled");
        }
      }

      const policy = await ctx.prisma.aiProjectPolicy.upsert({
        where: { projectId: input.projectId },
        create: {
          projectId: input.projectId,
          defaultProviderId: input.policy.defaultProviderId ?? null,
          allowUserProviders: input.policy.allowUserProviders,
          allowProjectProviders: input.policy.allowProjectProviders,
          allowYoloMode: input.policy.allowYoloMode,
          defaultPermissions: defaultPermissions as Prisma.InputJsonValue,
          maxPermissions: maxPermissions as Prisma.InputJsonValue,
        },
        update: {
          defaultProviderId: input.policy.defaultProviderId ?? null,
          allowUserProviders: input.policy.allowUserProviders,
          allowProjectProviders: input.policy.allowProjectProviders,
          allowYoloMode: input.policy.allowYoloMode,
          defaultPermissions: defaultPermissions as Prisma.InputJsonValue,
          maxPermissions: maxPermissions as Prisma.InputJsonValue,
        },
      });

      await ctx.prisma.aiProviderConnection.updateMany({
        where: { scope: "project", projectId: input.projectId },
        data: { isDefault: false },
      });

      if (input.policy.defaultProviderId) {
        await ctx.prisma.aiProviderConnection.update({
          where: { id: input.policy.defaultProviderId },
          data: { isDefault: true },
        });
      }

      return policy;
    }),

  listConversations: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), taskId: z.string().cuid().optional() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      if (input.taskId) {
        await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      }

      return ctx.prisma.aiConversation.findMany({
        where: {
          projectId: input.projectId,
          createdByUserId: ctx.session.user.id,
          ...(input.taskId ? { taskId: input.taskId } : {}),
        },
        orderBy: { updatedAt: "desc" },
        include: {
          provider: {
            select: { id: true, label: true, scope: true, adapter: true, model: true, isEnabled: true },
          },
        },
      });
    }),

  getConversation: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.aiConversation.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          provider: {
            select: { id: true, label: true, scope: true, adapter: true, model: true, isEnabled: true },
          },
          messages: { orderBy: { createdAt: "asc" } },
          actionExecutions: { orderBy: { createdAt: "asc" } },
        },
      });

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, conversation.projectId);
      if (conversation.createdByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this conversation");
      }

      return {
        ...conversation,
        actionExecutions: conversation.actionExecutions.map(mapExecutionForClient),
      };
    }),

  startConversation: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        taskId: z.string().cuid().optional(),
        providerId: z.string().cuid(),
        title: z.string().trim().max(200).optional(),
        mode: z.enum(["approval", "yolo"]).default("approval"),
        grantedPermissions: z.array(conversationPermissionEnum).default([]),
        selectedTaskIds: z.array(z.string().cuid()).max(100).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      if (input.taskId) {
        await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      }

      const selectedTaskIds = await normalizeSelectedTaskIdsOrThrow(ctx.prisma, input.projectId, input.selectedTaskIds);
      const { policy } = await getUsableProviderForProjectOrThrow(ctx.prisma, ctx.session.user.id, {
        projectId: input.projectId,
        providerId: input.providerId,
        mode: input.mode,
      });

      const maxPermissions = policy.maxPermissions;
      const grantedPermissions = normalizeAiPermissions(input.grantedPermissions);
      const effectivePermissions = grantedPermissions.filter((permission) => maxPermissions.includes(permission));

      return ctx.prisma.aiConversation.create({
        data: {
          projectId: input.projectId,
          taskId: input.taskId ?? null,
          createdByUserId: ctx.session.user.id,
          providerId: input.providerId,
          title: input.title,
          mode: input.mode,
          grantedPermissions: effectivePermissions as Prisma.InputJsonValue,
          selectedTaskIds: selectedTaskIds as Prisma.InputJsonValue,
        },
      });
    }),

  sendMessage: protectedProcedure
    .input(z.object({ id: z.string().cuid(), content: z.string().trim().min(1).max(10000) }))
    .mutation(async ({ ctx, input }) => {
      const rateLimit = consumeRateLimit("ai-chat", ctx.session.user.id, {
        maxAttempts: 20,
        windowMs: 60 * 1000,
      });

      if (!rateLimit.allowed) {
        throw new Error("AI chat rate limit exceeded");
      }

      const conversation = await ctx.prisma.aiConversation.findUniqueOrThrow({
        where: { id: input.id },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, conversation.projectId);
      if (conversation.createdByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this conversation");
      }

      const selectedTaskIds = await normalizeSelectedTaskIdsOrThrow(
        ctx.prisma,
        conversation.projectId,
        getConversationSelectedTaskIds(conversation)
      );
      const { policy } = await getUsableProviderForProjectOrThrow(ctx.prisma, ctx.session.user.id, {
        projectId: conversation.projectId,
        providerId: conversation.providerId,
        mode: conversation.mode,
      });
      const effectivePermissions = getEffectiveConversationPermissions(policy, conversation.grantedPermissions);

      await ctx.prisma.aiMessage.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          content: input.content,
        },
      });

      await ctx.prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });

      return appendAiAssistantTurn(ctx.prisma, {
        conversation: {
          ...conversation,
          grantedPermissions: effectivePermissions as unknown as Prisma.JsonValue,
          selectedTaskIds: selectedTaskIds as unknown as Prisma.JsonValue,
        },
        requestedByUserId: ctx.session.user.id,
      });
    }),

  generateConversationTitle: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.aiConversation.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          provider: true,
          messages: { orderBy: { createdAt: "asc" } },
        },
      });

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, conversation.projectId);
      if (conversation.createdByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this conversation");
      }

      if (conversation.messages.length === 0) {
        throw new Error("Conversation must have messages before a title can be generated");
      }

      const { policy } = await getUsableProviderForProjectOrThrow(ctx.prisma, ctx.session.user.id, {
        projectId: conversation.projectId,
        providerId: conversation.providerId,
        mode: conversation.mode,
      });
      const effectivePermissions = getEffectiveConversationPermissions(policy, conversation.grantedPermissions);
      const provider = resolveAiProvider(conversation.provider);
      const summarizationMessages = [
        {
          id: "title-system",
          conversationId: conversation.id,
          role: "system",
          content: [
            "Generate a concise title for this Taskito AI conversation.",
            "Return only the title text.",
            "Do not use quotes, markdown, numbering, or trailing punctuation.",
            "Keep it under 8 words and 120 characters.",
          ].join("\n"),
          toolName: null,
          toolPayload: null,
          createdAt: new Date(0),
        },
        {
          id: "title-context",
          conversationId: conversation.id,
          role: "system",
          content: `Conversation mode: ${conversation.mode}\nAllowed permissions: ${effectivePermissions.join(", ") || "none"}`,
          toolName: null,
          toolPayload: null,
          createdAt: new Date(0),
        },
        ...conversation.messages,
      ] satisfies AiMessage[];

      const rawTitle = provider.adapter === "anthropic"
        ? await completeWithAnthropicProvider(provider, summarizationMessages)
        : await completeWithOpenAiCompatibleProvider(provider, summarizationMessages);
      const title = normalizeAiConversationTitle(rawTitle);

      if (!title) {
        throw new Error("AI provider returned an empty conversation title");
      }

      return ctx.prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { title },
        include: {
          provider: {
            select: { id: true, label: true, scope: true, adapter: true, model: true, isEnabled: true },
          },
        },
      });
    }),

  approveAction: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const execution = await ctx.prisma.aiActionExecution.findUniqueOrThrow({
        where: { id: input.id },
        include: { conversation: true },
      });

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, execution.projectId);
      if (execution.requestedByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this AI action");
      }

      const { selectedTaskIds } = await assertAiActionStillAllowed(ctx.prisma, execution);

      const claim = await ctx.prisma.aiActionExecution.updateMany({
        where: { id: input.id, status: "proposed" },
        data: { status: "approved", errorMessage: null },
      });

      if (claim.count !== 1) {
        throw new Error("This AI action is no longer pending approval");
      }

      const approved = await ctx.prisma.aiActionExecution.findUniqueOrThrow({ where: { id: input.id } });

      try {
        const result = await executeAiAction(ctx.prisma, {
          actionExecution: approved,
          requestedByUserId: ctx.session.user.id,
          selectedTaskIds,
        });

        return ctx.prisma.aiActionExecution.update({
          where: { id: input.id },
          data: {
            status: "executed",
            executedByUserId: ctx.session.user.id,
            executedPayload: approved.proposedPayload as Prisma.InputJsonValue,
            result: (result ?? null) as Prisma.InputJsonValue,
          },
        }).then(mapExecutionForClient);
      } catch (error) {
        return ctx.prisma.aiActionExecution.update({
          where: { id: input.id },
          data: {
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "AI action execution failed",
          },
        }).then(mapExecutionForClient);
      }
    }),

  rejectAction: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const execution = await ctx.prisma.aiActionExecution.findUniqueOrThrow({
        where: { id: input.id },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, execution.projectId);
      if (execution.requestedByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this AI action");
      }

      const rejected = await ctx.prisma.aiActionExecution.updateMany({
        where: { id: input.id, status: "proposed" },
        data: { status: "rejected" },
      });

      if (rejected.count !== 1) {
        throw new Error("This AI action is no longer pending rejection");
      }

      return ctx.prisma.aiActionExecution.findUniqueOrThrow({ where: { id: input.id } }).then(mapExecutionForClient);
    }),

  rollbackAction: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const execution = await ctx.prisma.aiActionExecution.findUniqueOrThrow({
        where: { id: input.id },
      });

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, execution.projectId);
      if (execution.requestedByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this AI action");
      }

      if (execution.status !== "executed") {
        throw new Error("Only executed AI actions can be rolled back");
      }

      if (execution.rollbackStatus !== "available") {
        throw new Error("This AI action is not currently rollbackable");
      }

      try {
        await rollbackAiActionCheckpoint(ctx.prisma, {
          execution,
          actorId: ctx.session.user.id,
        });

        return ctx.prisma.aiActionExecution.update({
          where: { id: input.id },
          data: {
            rollbackStatus: "rolledBack",
            rollbackErrorMessage: null,
            rolledBackAt: new Date(),
            rolledBackByUserId: ctx.session.user.id,
          },
        }).then(mapExecutionForClient);
      } catch (error) {
        return ctx.prisma.aiActionExecution.update({
          where: { id: input.id },
          data: {
            rollbackStatus: "failed",
            rollbackErrorMessage: error instanceof Error ? error.message : "AI rollback failed",
          },
        }).then(mapExecutionForClient);
      }
    }),

  listActionExecutions: protectedProcedure
    .input(z.object({ conversationId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.aiConversation.findUniqueOrThrow({
        where: { id: input.conversationId },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, conversation.projectId);
      if (conversation.createdByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this conversation");
      }

      return ctx.prisma.aiActionExecution.findMany({
        where: { conversationId: input.conversationId },
        orderBy: { createdAt: "asc" },
      }).then((executions) => executions.map(mapExecutionForClient));
    }),

  listPermissions: protectedProcedure.query(() => AI_PERMISSION_VALUES),
});
