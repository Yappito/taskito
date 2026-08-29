import { Prisma, type AiActionExecution, type AiMessage } from "@prisma/client";
import { z } from "zod";

import { decryptAiSecret, encryptAiSecret } from "@/lib/ai-crypto";
import { normalizeAiPermissions } from "@/lib/ai-permissions";
import {
  AiProviderUrlValidationError,
  normalizeAiProviderHeaders,
  normalizeAiProviderModel,
  validateAiProviderBaseUrl,
} from "@/lib/ai-provider-validation";
import { AI_PERMISSION_PRESETS, AI_PERMISSION_VALUES, type AiPermission } from "@/lib/ai-types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requireGlobalAdmin, requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { appendAiAssistantTurn } from "@/server/services/ai/orchestrator";
import { executeAiAction } from "@/server/services/ai/action-executor";
import { rollbackAiActionCheckpoint } from "@/server/services/ai/checkpoints";
import {
  buildAiToolMessageContent,
  createAiToolResultMessage,
  getAiToolNameForActionType,
  serializeAiActionExecutionOutcome,
} from "@/server/services/ai/tool-results";
import { normalizeAiConversationTitle } from "@/server/services/ai/presenter";
import { completeWithAnthropicProvider } from "@/server/services/ai/provider-anthropic";
import { completeWithOpenAiCompatibleProvider } from "@/server/services/ai/provider-openai-compatible";
import { resolveAiProvider } from "@/server/services/ai/provider-registry";
import { AiProviderError } from "@/server/services/ai/provider-request";
import { withSecretRotationLock } from "@/server/services/ai/secret-reencryption";
import { getRequiredPermissionsForActionPayload, resolveAiActionPayload } from "@/server/services/ai/tools";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
// CITADEL-d77.32 (smart quick-add + task summaries): one-shot provider services.
import { AiParseTaskError, parseTaskFromText } from "@/server/services/ai/parse-task";
import {
  AiSummarizeError,
  TASK_SUMMARY_CACHE_VERSION,
  buildTaskBreakdownUserMessage,
  computeTaskSummaryContentHash,
  readStoredTaskAiSummary,
  summarizeTask as summarizeTaskWithProvider,
} from "@/server/services/ai/summarize";

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
  allowSharedProviders: z.boolean(),
  allowYoloMode: z.boolean(),
  // When true, yolo mode may also auto-execute YOLO_DESTRUCTIVE_ACTIONS.
  allowYoloDestructive: z.boolean().default(false),
  defaultPermissions: z.array(z.enum(AI_PERMISSION_VALUES)).default([]),
  maxPermissions: z.array(z.enum(AI_PERMISSION_VALUES)).default([]),
});

const conversationPermissionEnum = z.enum(AI_PERMISSION_VALUES);
const DEFAULT_AI_POLICY_DEFAULT_PERMISSIONS = [...AI_PERMISSION_PRESETS.read_only] satisfies AiPermission[];
const DEFAULT_AI_POLICY_MAX_PERMISSIONS = [...AI_PERMISSION_VALUES] satisfies AiPermission[];

type PrismaClient = typeof import("@/lib/prisma").prisma;

function canManageProvider(
  provider: { scope: "user" | "project" | "shared"; ownerUserId: string | null; projectId: string | null },
  options: {
    userId: string;
    isGlobalAdmin: boolean;
    projectOwnerScope: boolean;
  }
) {
  if (provider.scope === "user") {
    return provider.ownerUserId === options.userId;
  }
  if (provider.scope === "project") {
    return options.isGlobalAdmin || options.projectOwnerScope;
  }
  return options.isGlobalAdmin;
}

function sanitizeProviderForList(
  provider: {
    id: string;
    scope: "user" | "project" | "shared";
    ownerUserId: string | null;
    projectId: string | null;
    label: string;
    adapter: "openai_compatible" | "anthropic";
    baseUrl: string;
    model: string;
    defaultHeaders: Prisma.JsonValue | null;
    isEnabled: boolean;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  options: {
    userId: string;
    isGlobalAdmin: boolean;
    projectOwnerScope: boolean;
    includeConfig: boolean;
  }
) {
  const canManage = canManageProvider(provider, options);
  const shouldIncludeConfig = options.includeConfig && canManage;

  return {
    id: provider.id,
    scope: provider.scope,
    ownerUserId: provider.ownerUserId,
    projectId: provider.projectId,
    label: provider.label,
    adapter: shouldIncludeConfig ? provider.adapter : null,
    baseUrl: shouldIncludeConfig ? provider.baseUrl : null,
    model: shouldIncludeConfig ? provider.model : null,
    defaultHeaders: shouldIncludeConfig ? provider.defaultHeaders : null,
    isEnabled: provider.isEnabled,
    isDefault: provider.isDefault,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    canManage,
  };
}

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
    allowSharedProviders: policy?.allowSharedProviders ?? true,
    allowYoloMode: policy?.allowYoloMode ?? true,
    allowYoloDestructive: policy?.allowYoloDestructive ?? false,
    defaultPermissions,
    maxPermissions,
  };
}

/** Effective shape of getEffectiveProjectAiPolicy (avoids a forward type ref). */
type EffectiveProjectAiPolicy = Awaited<ReturnType<typeof getEffectiveProjectAiPolicy>>;

type PolicyScopeCheckProvider = {
  scope: "user" | "project" | "shared";
  ownerUserId: string | null;
  projectId: string | null;
  isEnabled: boolean;
};

/**
 * CITADEL-amv (finding 12): the single policy clamp that decides whether a
 * provider record may be used for one-shot AI features in a project. Enforces
 * exactly the same semantics as the fallback scope scan below and
 * getUsableProviderForProjectOrThrow: the provider must be enabled, its scope
 * must be allowed by the project policy, and a project-scoped provider must
 * belong to THIS project (a default pointing at another project's provider is
 * never usable). A user-scoped provider additionally must be owned by the
 * caller.
 */
function isProviderUsableUnderPolicy(
  provider: PolicyScopeCheckProvider | null | undefined,
  policy: Pick<EffectiveProjectAiPolicy, "allowUserProviders" | "allowProjectProviders" | "allowSharedProviders">,
  userId: string,
  projectId: string
): boolean {
  if (!provider || !provider.isEnabled) {
    return false;
  }
  if (provider.scope === "user") {
    return policy.allowUserProviders && provider.ownerUserId === userId;
  }
  if (provider.scope === "project") {
    return policy.allowProjectProviders && provider.projectId === projectId;
  }
  return policy.allowSharedProviders;
}

// CITADEL-d77.32 (smart quick-add + task summaries): resolve a usable provider
// for one-shot AI features — the project's default provider first, then any
// enabled provider visible to the user under the project policy.
async function findDefaultOrFirstUsableAiProvider(
  prisma: PrismaClient,
  userId: string,
  projectId: string
) {
  const policy = await getEffectiveProjectAiPolicy(prisma, projectId);
  if (policy.defaultProviderId) {
    const provider = await prisma.aiProviderConnection.findUnique({ where: { id: policy.defaultProviderId } });
    // CITADEL-amv (finding 12): the default fast path previously accepted any
    // enabled project/shared provider without checking the allow flags or the
    // provider's project association. It now applies the exact same clamps as
    // the fallback scan / getUsableProviderForProjectOrThrow; an unusable
    // default falls through to the policy-filtered fallback scan.
    if (isProviderUsableUnderPolicy(provider, policy, userId, projectId)) {
      return provider;
    }
  }

  const scopeClauses: Prisma.AiProviderConnectionWhereInput[] = [];
  if (policy.allowProjectProviders) {
    scopeClauses.push({ scope: "project", projectId });
  }
  if (policy.allowUserProviders) {
    scopeClauses.push({ scope: "user", ownerUserId: userId });
  }
  if (policy.allowSharedProviders) {
    scopeClauses.push({ scope: "shared" });
  }
  if (scopeClauses.length === 0) {
    return null;
  }

  return prisma.aiProviderConnection.findFirst({
    where: { isEnabled: true, OR: scopeClauses },
    orderBy: [{ scope: "asc" }, { updatedAt: "desc" }],
  });
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

  if (provider.scope === "shared" && !policy.allowSharedProviders) {
    throw new Error("Shared AI providers are disabled for this project");
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
  execution: AiActionExecution & { conversation: { grantedPermissions: unknown; selectedTaskIds: unknown } },
  payloadOverride?: Record<string, unknown>
) {
  const policy = await getEffectiveProjectAiPolicy(prisma, execution.projectId);
  const selectedTaskIds = getConversationSelectedTaskIds(execution.conversation);
  const payload = await resolveAiActionPayload(prisma, execution.projectId, execution.actionType, payloadOverride ?? execution.proposedPayload, { selectedTaskIds });
  const effectivePermissions = getEffectiveConversationPermissions(policy, execution.conversation.grantedPermissions);
  const grantedSet = new Set(effectivePermissions);
  const requiredPermissions = getRequiredPermissionsForActionPayload(execution.actionType, payload);

  if (!requiredPermissions.every((permission) => grantedSet.has(permission))) {
    throw new Error("This AI action is no longer allowed by the current project policy or conversation permissions");
  }

  return { selectedTaskIds, payload };
}

const PROVIDER_TEST_SUMMARY_MAX_CHARS = 200;

// Per-conversation in-memory mutex for AI action approvals. A simple
// Map<conversationId, Promise> chain is acceptable here because Taskito
// currently runs as a single server instance: each approveAction for a
// conversation is chained onto the previous one so checkpointBefore for a
// proposal is always captured after the earlier proposal finished writing.
const conversationApprovalChains = new Map<string, Promise<unknown>>();

function runExclusivelyPerConversation<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationApprovalChains.get(conversationId) ?? Promise.resolve();
  const run = previous.then(task);
  const settled = run.then(() => undefined, () => undefined);
  conversationApprovalChains.set(conversationId, settled);
  void settled.finally(() => {
    if (conversationApprovalChains.get(conversationId) === settled) {
      conversationApprovalChains.delete(conversationId);
    }
  });
  return run;
}

function normalizeUpstreamTextForSummary(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeProviderTestOutcome(status: number | null, rawMessage: string) {
  const header = status === null
    ? "Provider test failed"
    : `Provider test completed with status ${status}`;
  const detail = normalizeUpstreamTextForSummary(rawMessage)
    .slice(0, PROVIDER_TEST_SUMMARY_MAX_CHARS - header.length - 2);
  return detail ? `${header}: ${detail}` : header;
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
      toolCalls: null,
      toolCallId: null,
      usage: null,
      isStreaming: false,
      createdAt: new Date(),
    },
  ] satisfies AiMessage[];

  try {
    if (provider.adapter === "anthropic") {
      await completeWithAnthropicProvider(provider, messages);
    } else {
      await completeWithOpenAiCompatibleProvider(provider, messages);
    }
  } catch (error) {
    const status =
      error instanceof AiProviderError && error.status !== null && Number.isInteger(error.status) && error.status > 0
        ? error.status
        : null;
    // Only typed error classes are surfaced: AiProviderError messages are
    // bounded and sanitized by the adapters, and URL validation messages are
    // authored by Taskito. An arbitrary Error.message is never interpolated —
    // it can embed upstream response bytes (e.g. from JSON parse failures).
    const knownMessage =
      error instanceof AiProviderError || error instanceof AiProviderUrlValidationError
        ? error.message
        : "AI provider request failed";
    // Bounded, sanitized status/summary only — never raw upstream body text.
    throw new Error(summarizeProviderTestOutcome(status, knownMessage));
  }

  // Deliberately do not surface raw upstream body/model text to the client.
  return summarizeProviderTestOutcome(200, "Upstream accepted the request.");
}

async function getVisibleProviderOrThrow(
  prisma: PrismaClient,
  userId: string,
  providerId: string,
  projectId?: string
) {
  const actor = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true },
  });
  const provider = await prisma.aiProviderConnection.findUniqueOrThrow({
    where: { id: providerId },
  });

  if (provider.scope === "user") {
    if (provider.ownerUserId !== userId) {
      throw new Error("You do not have access to this provider");
    }
    return provider;
  }

  if (provider.scope === "shared") {
    if (projectId) {
      await requireProjectAccess(prisma, userId, projectId);
    } else if (actor.role !== "admin") {
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
    .input(z.object({ projectId: z.string().cuid().optional(), actorScope: z.enum(["chat", "manage"]).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const projectId = input?.projectId;
      const actorScope = input?.actorScope ?? "chat";
      if (projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, projectId);
      }

      const actor = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { role: true },
      });
      const isProjectOwnerScope = actorScope === "manage" && Boolean(projectId);

      if (projectId && isProjectOwnerScope) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, projectId, { permission: "ai_manage" });
      }

      const providerVisibilityClauses: Prisma.AiProviderConnectionWhereInput[] = [
        { scope: "user", ownerUserId: ctx.session.user.id },
      ];

      if (projectId) {
        providerVisibilityClauses.push({ scope: "project", projectId });
        providerVisibilityClauses.push({ scope: "shared" });
      } else if (actor.role === "admin") {
        providerVisibilityClauses.push({ scope: "shared" });
      }

      const providers = await ctx.prisma.aiProviderConnection.findMany({
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

      return providers.map((provider) => sanitizeProviderForList(provider, {
        userId: ctx.session.user.id,
        isGlobalAdmin: actor.role === "admin",
        projectOwnerScope: isProjectOwnerScope,
        includeConfig: actorScope === "manage",
      }));
    }),

  createSharedProvider: protectedProcedure
    .input(providerInputSchema)
    .mutation(async ({ ctx, input }) => {
      await requireGlobalAdmin(ctx.prisma, ctx.session.user.id, { authMethod: ctx.session.authMethod });

      const normalizedBaseUrl = validateAiProviderBaseUrl(input.baseUrl);
      const normalizedHeaders = normalizeAiProviderHeaders(input.defaultHeaders);
      const model = normalizeAiProviderModel(input.model);

      // M6: serialize with secret rotation — the encryptedSecret write takes
      // the re-encryption advisory lock inside its own transaction.
      return withSecretRotationLock(ctx.prisma, (tx) =>
        tx.aiProviderConnection.create({
          data: {
            scope: "shared",
            label: input.label,
            adapter: input.adapter,
            baseUrl: normalizedBaseUrl,
            model,
            encryptedSecret: encryptAiSecret(input.secret),
            defaultHeaders: normalizedHeaders as Prisma.InputJsonValue,
            isEnabled: input.isEnabled,
            isDefault: false,
          },
        }),
      );
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

      // M6: serialize with secret rotation (the encryptedSecret write must not
      // interleave with a key rotation run).
      return withSecretRotationLock(ctx.prisma, (tx) =>
        tx.aiProviderConnection.create({
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
        }),
      );
    }),

  createProjectProvider: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }).merge(providerInputSchema))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "ai_manage" });

      // CITADEL-amv (finding 12): never install a project default provider
      // while project providers are disallowed by the current policy — the
      // default would be unusable (and is now also clamped at read time).
      if (input.isDefault) {
        const policy = await ctx.prisma.aiProjectPolicy.findUnique({ where: { projectId: input.projectId } });
        if (policy && !policy.allowProjectProviders) {
          throw new Error("Project providers must be allowed to use a project default provider");
        }
      }

      const normalizedBaseUrl = validateAiProviderBaseUrl(input.baseUrl);
      const normalizedHeaders = normalizeAiProviderHeaders(input.defaultHeaders);
      const model = normalizeAiProviderModel(input.model);

      if (input.isDefault) {
        await ctx.prisma.aiProviderConnection.updateMany({
          where: { scope: "project", projectId: input.projectId },
          data: { isDefault: false },
        });
      }

      // M6: serialize with secret rotation (writes the encryptedSecret).
      const provider = await withSecretRotationLock(ctx.prisma, (tx) =>
        tx.aiProviderConnection.create({
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
        }),
      );

      if (input.isDefault) {
        await ctx.prisma.aiProjectPolicy.upsert({
          where: { projectId: input.projectId },
          create: {
            projectId: input.projectId,
            defaultProviderId: provider.id,
            allowYoloMode: true,
            allowYoloDestructive: false,
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
      if (provider.scope === "shared") {
        await requireGlobalAdmin(ctx.prisma, ctx.session.user.id, { authMethod: ctx.session.authMethod });
      } else if (provider.scope === "project" && provider.projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, provider.projectId, { permission: "ai_manage" });
      }

      const baseUrl = input.baseUrl ? validateAiProviderBaseUrl(input.baseUrl) : undefined;
      const model = input.model ? normalizeAiProviderModel(input.model) : undefined;
      const defaultHeaders = input.defaultHeaders ? normalizeAiProviderHeaders(input.defaultHeaders) : undefined;
      const secret = input.secret?.trim();

      // CITADEL-amv (finding 12): never flag a project provider as default
      // while project providers are disallowed by the project's policy —
      // mirror of the updateProjectPolicy rejection and the create path.
      if (input.isDefault && provider.scope === "project" && provider.projectId) {
        const policy = await ctx.prisma.aiProjectPolicy.findUnique({ where: { projectId: provider.projectId } });
        if (policy && !policy.allowProjectProviders) {
          throw new Error("Project providers must be allowed to use a project default provider");
        }
      }

      if (input.isDefault && provider.scope !== "shared") {
        await ctx.prisma.aiProviderConnection.updateMany({
          where:
            provider.scope === "user"
              ? { scope: "user", ownerUserId: provider.ownerUserId }
              : provider.scope === "project"
                ? { scope: "project", projectId: provider.projectId }
                : { scope: "shared" },
          data: { isDefault: false },
        });
      }

      const updatedProvider = await withSecretRotationLock(ctx.prisma, (tx) =>
        tx.aiProviderConnection.update({
          where: { id: input.id },
          data: {
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
            ...(baseUrl !== undefined ? { baseUrl } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(secret ? { encryptedSecret: encryptAiSecret(secret) } : {}),
            ...(defaultHeaders !== undefined ? { defaultHeaders: defaultHeaders as Prisma.InputJsonValue } : {}),
            ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
            ...(provider.scope !== "shared" && input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          },
        }),
      );

      if (provider.scope === "project" && provider.projectId) {
        if (input.isDefault === true) {
          await ctx.prisma.aiProjectPolicy.upsert({
            where: { projectId: provider.projectId },
            create: {
              projectId: provider.projectId,
              defaultProviderId: provider.id,
              allowYoloMode: true,
              allowYoloDestructive: false,
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
      if (provider.scope === "shared") {
        await requireGlobalAdmin(ctx.prisma, ctx.session.user.id, { authMethod: ctx.session.authMethod });
        await ctx.prisma.aiProjectPolicy.updateMany({
          where: { defaultProviderId: provider.id },
          data: { defaultProviderId: null },
        });
      } else if (provider.scope === "project" && provider.projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, provider.projectId, { permission: "ai_manage" });
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
      if (provider.scope === "shared") {
        await requireGlobalAdmin(ctx.prisma, ctx.session.user.id, { authMethod: ctx.session.authMethod });
      } else if (provider.scope === "project" && provider.projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, provider.projectId, { permission: "ai_manage" });
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
      if (provider.scope === "shared") {
        await requireGlobalAdmin(ctx.prisma, ctx.session.user.id, { authMethod: ctx.session.authMethod });
      }
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
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "ai_manage" });
      const maxPermissions = normalizeAiPermissions(input.policy.maxPermissions);
      const defaultPermissions = normalizeAiPermissions(input.policy.defaultPermissions)
        .filter((permission) => maxPermissions.includes(permission));

      if (input.policy.defaultProviderId && !input.policy.allowProjectProviders) {
        const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.policy.defaultProviderId, input.projectId);
        if (provider.scope === "project") {
          throw new Error("Project providers must be allowed to use a project default provider");
        }
      }

      if (input.policy.defaultProviderId && !input.policy.allowSharedProviders) {
        const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.policy.defaultProviderId, input.projectId);
        if (provider.scope === "shared") {
          throw new Error("Shared providers must be allowed to use a shared default provider");
        }
      }

      if (input.policy.defaultProviderId) {
        const provider = await getVisibleProviderOrThrow(ctx.prisma, ctx.session.user.id, input.policy.defaultProviderId, input.projectId);
        if (provider.scope === "user") {
          throw new Error("Project default provider must be project-scoped or shared");
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
          allowSharedProviders: input.policy.allowSharedProviders,
          allowYoloMode: input.policy.allowYoloMode,
          allowYoloDestructive: input.policy.allowYoloDestructive,
          defaultPermissions: defaultPermissions as Prisma.InputJsonValue,
          maxPermissions: maxPermissions as Prisma.InputJsonValue,
        },
        update: {
          defaultProviderId: input.policy.defaultProviderId ?? null,
          allowUserProviders: input.policy.allowUserProviders,
          allowProjectProviders: input.policy.allowProjectProviders,
          allowSharedProviders: input.policy.allowSharedProviders,
          allowYoloMode: input.policy.allowYoloMode,
          allowYoloDestructive: input.policy.allowYoloDestructive,
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
            select: { id: true, label: true, scope: true, isEnabled: true },
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
            select: { id: true, label: true, scope: true, isEnabled: true },
          },
          messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          actionExecutions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
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
          toolCalls: null,
          toolCallId: null,
          usage: null,
          isStreaming: false,
          createdAt: new Date(0),
        },
        {
          id: "title-context",
          conversationId: conversation.id,
          role: "system",
          content: `Conversation mode: ${conversation.mode}\nAllowed permissions: ${effectivePermissions.join(", ") || "none"}`,
          toolName: null,
          toolPayload: null,
          toolCalls: null,
          toolCallId: null,
          usage: null,
          isStreaming: false,
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
            select: { id: true, label: true, scope: true, isEnabled: true },
          },
        },
      });
    }),

  approveAction: protectedProcedure
    .input(z.object({ id: z.string().cuid(), overridePayload: z.record(z.string(), z.unknown()).optional() }))
    .mutation(async ({ ctx, input }) => {
      const execution = await ctx.prisma.aiActionExecution.findUniqueOrThrow({
        where: { id: input.id },
        include: { conversation: true },
      });

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, execution.projectId);
      if (execution.requestedByUserId !== ctx.session.user.id) {
        throw new Error("You do not have access to this AI action");
      }

      return runExclusivelyPerConversation(execution.conversationId, async () => {
        const { selectedTaskIds, payload } = await assertAiActionStillAllowed(ctx.prisma, execution, input.overridePayload);
        const executionPayload = payload as Prisma.JsonValue;

        const claim = await ctx.prisma.aiActionExecution.updateMany({
          where: { id: input.id, status: "proposed" },
          data: {
            status: "approved",
            errorMessage: null,
            ...(input.overridePayload ? { proposedPayload: executionPayload as Prisma.InputJsonValue } : {}),
          },
        });

        if (claim.count !== 1) {
          throw new Error("This AI action is no longer pending approval");
        }

        const approved = await ctx.prisma.aiActionExecution.findUniqueOrThrow({ where: { id: input.id } });

        try {
          const result = await executeAiAction(ctx.prisma, {
            actionExecution: {
              ...approved,
              proposedPayload: executionPayload,
            },
            requestedByUserId: ctx.session.user.id,
            selectedTaskIds,
          });

          const executed = await ctx.prisma.aiActionExecution.update({
            where: { id: input.id },
            data: {
              status: "executed",
              executedByUserId: ctx.session.user.id,
              executedPayload: executionPayload as Prisma.InputJsonValue,
              result: (result ?? null) as Prisma.InputJsonValue,
            },
          }).then(mapExecutionForClient);

          // Tool-result loop: answer the model's tool call so the next turn
          // learns the proposal was executed.
          await createAiToolResultMessage(ctx.prisma, {
            conversationId: execution.conversationId,
            toolCallId: approved.toolCallId ?? null,
            toolName: getAiToolNameForActionType(approved.actionType),
            content: buildAiToolMessageContent(serializeAiActionExecutionOutcome({ status: "executed", result: approved.result ?? null })),
          });

          return executed;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "AI action execution failed";
          const failed = await ctx.prisma.aiActionExecution.update({
            where: { id: input.id },
            data: {
              status: "failed",
              errorMessage,
            },
          }).then(mapExecutionForClient);

          await createAiToolResultMessage(ctx.prisma, {
            conversationId: execution.conversationId,
            toolCallId: approved.toolCallId ?? null,
            toolName: getAiToolNameForActionType(approved.actionType),
            content: buildAiToolMessageContent(serializeAiActionExecutionOutcome({ status: "failed", errorMessage })),
          });

          return failed;
        }
      });
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

      const updated = await ctx.prisma.aiActionExecution.findUniqueOrThrow({ where: { id: input.id } });

      // Tool-result loop: the model must learn its proposal was rejected.
      await createAiToolResultMessage(ctx.prisma, {
        conversationId: updated.conversationId,
        toolCallId: updated.toolCallId ?? null,
        toolName: getAiToolNameForActionType(updated.actionType),
        content: buildAiToolMessageContent(serializeAiActionExecutionOutcome({ status: "rejected", errorMessage: "proposal rejected by the user" })),
      });

      return mapExecutionForClient(updated);
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

        const rolledBack = await ctx.prisma.aiActionExecution.update({
          where: { id: input.id },
          data: {
            rollbackStatus: "rolledBack",
            rollbackErrorMessage: null,
            rolledBackAt: new Date(),
            rolledBackByUserId: ctx.session.user.id,
          },
        }).then(mapExecutionForClient);

        await createAiToolResultMessage(ctx.prisma, {
          conversationId: execution.conversationId,
          toolCallId: execution.toolCallId ?? null,
          toolName: getAiToolNameForActionType(execution.actionType),
          content: buildAiToolMessageContent(serializeAiActionExecutionOutcome({ status: "rolled_back" })),
        });

        return rolledBack;
      } catch (error) {
        const rolledBackFailed = await ctx.prisma.aiActionExecution.update({
          where: { id: input.id },
          data: {
            rollbackStatus: "failed",
            rollbackErrorMessage: error instanceof Error ? error.message : "AI rollback failed",
          },
        }).then(mapExecutionForClient);

        await createAiToolResultMessage(ctx.prisma, {
          conversationId: execution.conversationId,
          toolCallId: execution.toolCallId ?? null,
          toolName: getAiToolNameForActionType(execution.actionType),
          content: buildAiToolMessageContent(serializeAiActionExecutionOutcome({ status: "failed", errorMessage: error instanceof Error ? error.message : "AI rollback failed" })),
        });

        return rolledBackFailed;
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }).then((executions) => executions.map(mapExecutionForClient));
    }),

  // ── CITADEL-d77.32 (smart quick-add + task summaries) ────────────────────

  // Whether any AI provider is usable for the project (default provider, then
  // project/user/shared scope per policy). UI hides AI entry points when not.
  hasUsableProvider: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      const provider = await findDefaultOrFirstUsableAiProvider(ctx.prisma, ctx.session.user.id, input.projectId);
      return { hasUsableProvider: Boolean(provider) };
    }),

  // Smart quick-add: parse a natural-language request into a prefilled task
  // draft. Nothing is written; unresolved candidate references are reported.
  parseTask: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), text: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

      const rateLimit = consumeRateLimit("ai-chat", ctx.session.user.id, {
        maxAttempts: 20,
        windowMs: 60 * 1000,
      });
      if (!rateLimit.allowed) {
        throw new Error("AI chat rate limit exceeded");
      }

      const providerRecord = await findDefaultOrFirstUsableAiProvider(ctx.prisma, ctx.session.user.id, input.projectId);
      if (!providerRecord) {
        throw new Error("No AI provider is available for this project");
      }

      const projectId = input.projectId;
      const [statuses, people, tags] = await Promise.all([
        ctx.prisma.workflowStatus.findMany({
          where: { projectId },
          orderBy: { order: "asc" },
          select: { id: true, name: true },
        }),
        ctx.prisma.user.findMany({
          where: {
            disabledAt: null,
            OR: [
              { role: "admin" },
              { projectMemberships: { some: { projectId } } },
              { groupMemberships: { some: { group: { projectMemberships: { some: { projectId } } } } } },
            ],
          },
          orderBy: [{ name: "asc" }, { email: "asc" }],
          select: { id: true, name: true, email: true },
        }),
        ctx.prisma.tag.findMany({
          where: { projectId },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
      ]);

      try {
        return await parseTaskFromText(resolveAiProvider(providerRecord), {
          text: input.text,
          statuses,
          people,
          tags,
          now: new Date(),
        });
      } catch (error) {
        if (error instanceof AiParseTaskError) {
          // Typed, fixed client-safe message — never raw model output.
          throw error;
        }
        throw new Error("AI quick-add parsing failed. Try again or fill the form manually.");
      }
    }),

  // Task/thread summary. Cached in Task.aiSummary keyed on a hash of the
  // exact serialized task snapshot (content-hash CAS, CITADEL-amv);
  // `force: true` bypasses the cache.
  summarizeTask: protectedProcedure
    .input(z.object({ taskId: z.string().cuid(), force: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);

      const task = await ctx.prisma.task.findUnique({
        where: { id: input.taskId },
        include: {
          project: { select: { key: true } },
          status: true,
          creator: { select: { id: true, name: true, email: true, image: true } },
          assignee: { select: { id: true, name: true, email: true, image: true } },
          tags: { include: { tag: true } },
          comments: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 50,
            include: { author: { select: { id: true, name: true, email: true, image: true } } },
          },
        },
      });
      if (!task) {
        throw new Error("Task not found");
      }

      // CITADEL-amv (finding 11): cache validity is keyed on a hash of the
      // exact serialized snapshot the provider summarizes — not on
      // task.updatedAt. The hash covers the comment thread (which does not
      // bump updatedAt) and cannot be fooled by updatedAt restore tricks.
      const contentHash = computeTaskSummaryContentHash(task);

      const stored = readStoredTaskAiSummary(task.aiSummary);
      if (
        !input.force
        && stored
        && stored.forContentHash === contentHash
      ) {
        return { ...stored.result, generatedAt: stored.generatedAt, cached: true, persisted: true };
      }

      const rateLimit = consumeRateLimit("ai-chat", ctx.session.user.id, {
        maxAttempts: 20,
        windowMs: 60 * 1000,
      });
      if (!rateLimit.allowed) {
        throw new Error("AI chat rate limit exceeded");
      }

      const providerRecord = await findDefaultOrFirstUsableAiProvider(ctx.prisma, ctx.session.user.id, task.projectId);
      if (!providerRecord) {
        throw new Error("No AI provider is available for this project");
      }

      let result;
      try {
        result = await summarizeTaskWithProvider(resolveAiProvider(providerRecord), task);
      } catch (error) {
        if (error instanceof AiSummarizeError) {
          // Typed, fixed client-safe message — never raw model output.
          throw error;
        }
        throw new Error("AI task summarization failed. Try again later.");
      }

      const generatedAt = new Date().toISOString();

      // CITADEL-amv (finding 11): the provider call above can take a long
      // time. Instead of unconditionally writing the summary, the write is a
      // compare-and-swap: it only lands while the task row still carries the
      // exact state observed at read time. On count 0 the task (or thread)
      // changed under us — the just-computed summary is discarded without
      // persisting and returned as uncached; the next request recomputes
      // against the fresh content. updatedAt is pinned to its own current
      // value to suppress the Prisma @updatedAt bump (storing a summary is
      // not a task edit) — the CAS guarantees this is never a rollback.
      // Content-hash keying means even a racing write could not serve a
      // stale entry afterwards: validity is re-checked against current
      // content on every read.
      //
      // CITADEL-e10 (finding 5): the thread half of the CAS is now the
      // durable Task.commentThreadVersion counter (bumped by every comment
      // create, edit, AND delete). The previous predicate — some comment
      // still had the old newest createdAt and none a greater one — missed
      // in-place edits of the newest comment (createdAt unchanged) and
      // deletions of older comments, letting a summary computed from a
      // since-changed thread land with persisted:true. updatedAt stays in
      // the predicate because plain task edits (title/body/…) do not move
      // the thread version; the version is additionally folded into the
      // content hash so a persisted entry can never outlive the thread it
      // was computed from.
      const cacheWrite = await ctx.prisma.task.updateMany({
        where: {
          id: input.taskId,
          updatedAt: task.updatedAt,
          commentThreadVersion: task.commentThreadVersion,
        },
        data: {
          aiSummary: {
            v: TASK_SUMMARY_CACHE_VERSION,
            generatedAt,
            forContentHash: contentHash,
            result,
          } as unknown as Prisma.InputJsonValue,
          updatedAt: task.updatedAt,
        },
      });

      if (cacheWrite.count === 0) {
        // The task was edited (or its thread changed) while the model ran:
        // never persist the stale summary, never move updatedAt backward.
        return { ...result, generatedAt, cached: false, persisted: false };
      }

      return { ...result, generatedAt, cached: false, persisted: true };
    }),

  // "Break down into subtasks": opens a task-scoped AI conversation seeded
  // with a breakdown request. The assistant turn proposes createTask/addLink
  // actions that flow through the normal approval cards — nothing is executed
  // automatically (conversation is always approval mode).
  startBreakdown: protectedProcedure
    .input(z.object({ taskId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);

      const task = await ctx.prisma.task.findUniqueOrThrow({
        where: { id: input.taskId },
        include: { project: { select: { key: true } } },
      });

      const rateLimit = consumeRateLimit("ai-chat", ctx.session.user.id, {
        maxAttempts: 20,
        windowMs: 60 * 1000,
      });
      if (!rateLimit.allowed) {
        throw new Error("AI chat rate limit exceeded");
      }

      const providerRecord = await findDefaultOrFirstUsableAiProvider(ctx.prisma, ctx.session.user.id, task.projectId);
      if (!providerRecord) {
        throw new Error("No AI provider is available for this project");
      }

      const policy = await getEffectiveProjectAiPolicy(ctx.prisma, task.projectId);
      const requestedPermissions = normalizeAiPermissions([
        "read_current_task",
        "read_selected_tasks",
        "search_project",
        "create_task",
        "link_tasks",
      ]);
      const effectivePermissions = requestedPermissions.filter((permission) => policy.maxPermissions.includes(permission));

      const taskKey = task.project.key ? `${task.project.key}-${task.taskNumber}` : String(task.taskNumber);
      const conversation = await ctx.prisma.aiConversation.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          createdByUserId: ctx.session.user.id,
          providerId: providerRecord.id,
          title: `Break down ${taskKey}`.slice(0, 200),
          mode: "approval",
          grantedPermissions: effectivePermissions as Prisma.InputJsonValue,
          selectedTaskIds: [task.id] as Prisma.InputJsonValue,
        },
      });

      await ctx.prisma.aiMessage.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          content: buildTaskBreakdownUserMessage(taskKey),
        },
      });

      const turn = await appendAiAssistantTurn(ctx.prisma, {
        conversation: {
          id: conversation.id,
          projectId: task.projectId,
          taskId: task.id,
          providerId: providerRecord.id,
          mode: "approval",
          grantedPermissions: effectivePermissions as unknown as Prisma.JsonValue,
          selectedTaskIds: [task.id] as unknown as Prisma.JsonValue,
        },
        requestedByUserId: ctx.session.user.id,
      });

      return {
        conversationId: conversation.id,
        message: turn.message,
        proposals: turn.proposals.map(mapExecutionForClient),
      };
    }),

  listPermissions: protectedProcedure.query(() => AI_PERMISSION_VALUES),
});
