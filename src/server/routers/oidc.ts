import { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { encryptOidcClientSecret, getEnvOidcProviderConfigs, getReservedEnvOidcProviderIds, normalizeAdminEmails, normalizeOidcProviderId, normalizeOidcRole, oidcProviderWriteData, serializeOidcProvider, validateOidcIssuer } from "@/server/services/oidc-provider-settings";
import { withSecretRotationLock } from "@/server/services/ai/secret-reencryption";
import { adminProcedure, createTRPCRouter } from "@/server/trpc";

const providerIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const oidcProviderInput = z.object({
  providerId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  issuer: z.string().trim().min(1).max(500),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().min(1).max(5000),
  scope: z.string().trim().min(1).max(300).default("openid email profile"),
  groupsClaim: z.string().trim().min(1).max(100).default("groups"),
  defaultRole: z.enum(["admin", "member"]).default("member"),
  allowSignup: z.boolean().default(true),
  allowEmailAccountLinking: z.boolean().default(false),
  requireEmailVerified: z.boolean().default(false),
  adminEmails: z.array(z.string().email()).default([]),
  isEnabled: z.boolean().default(true),
});

const oidcProviderUpdateInput = oidcProviderInput.omit({ clientSecret: true }).partial().extend({
  id: z.string().cuid(),
  clientSecret: z.string().max(5000).optional(),
});

function assertValidProviderId(providerId: string) {
  if (!providerIdPattern.test(providerId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Provider ID must use lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen",
    });
  }
}

function assertNotReservedProviderId(providerId: string) {
  if (getReservedEnvOidcProviderIds().has(providerId) || providerId === "credentials") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Provider ID is reserved by an existing auth provider" });
  }
}

function mapPrismaError(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "An OIDC provider with this provider ID already exists" });
  }
  throw error;
}

export const oidcRouter = createTRPCRouter({
  list: adminProcedure.query(async ({ ctx }) => {
    const providers = await ctx.prisma.oidcProviderConnection.findMany({
      orderBy: [{ isEnabled: "desc" }, { name: "asc" }],
    });

    return {
      providers: providers.map(serializeOidcProvider),
      envProviders: getEnvOidcProviderConfigs().map((provider) => ({
        providerId: provider.id,
        name: provider.name,
        issuer: provider.issuer,
        clientId: provider.clientId,
        scope: provider.scope,
        groupsClaim: provider.groupsClaim,
        defaultRole: provider.defaultRole,
        allowSignup: provider.allowSignup,
        allowEmailAccountLinking: provider.allowEmailAccountLinking,
        requireEmailVerified: provider.requireEmailVerified,
        adminEmails: [...provider.adminEmails],
        isEnabled: true,
        hasClientSecret: true,
      })),
    };
  }),

  create: adminProcedure
    .input(oidcProviderInput)
    .mutation(async ({ ctx, input }) => {
      const providerId = normalizeOidcProviderId(input.providerId);
      assertValidProviderId(providerId);
      assertNotReservedProviderId(providerId);

      try {
        // M6: serialize with secret rotation (writes encryptedClientSecret).
        const provider = await withSecretRotationLock(ctx.prisma, (tx) =>
          tx.oidcProviderConnection.create({
            data: oidcProviderWriteData({ ...input, providerId }),
          }),
        );
        return serializeOidcProvider(provider);
      } catch (error) {
        mapPrismaError(error);
      }
    }),

  update: adminProcedure
    .input(oidcProviderUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.oidcProviderConnection.findUniqueOrThrow({ where: { id: input.id } });
      const providerId = input.providerId === undefined
        ? existing.providerId
        : normalizeOidcProviderId(input.providerId);
      assertValidProviderId(providerId);
      if (providerId !== existing.providerId) {
        assertNotReservedProviderId(providerId);
      }

      try {
        // M6: serialize with secret rotation (writes encryptedClientSecret).
        const provider = await withSecretRotationLock(ctx.prisma, (tx) =>
          tx.oidcProviderConnection.update({
            where: { id: input.id },
            data: {
              ...(input.providerId !== undefined ? { providerId } : {}),
              ...(input.name !== undefined ? { name: input.name.trim() } : {}),
              ...(input.issuer !== undefined ? { issuer: validateOidcIssuer(input.issuer.trim()) } : {}),
              ...(input.clientId !== undefined ? { clientId: input.clientId.trim() } : {}),
              ...(input.clientSecret?.trim() ? { encryptedClientSecret: encryptOidcClientSecret(input.clientSecret) } : {}),
              ...(input.scope !== undefined ? { scope: input.scope.trim() || "openid email profile" } : {}),
              ...(input.groupsClaim !== undefined ? { groupsClaim: input.groupsClaim.trim() || "groups" } : {}),
              ...(input.defaultRole !== undefined ? { defaultRole: normalizeOidcRole(input.defaultRole) } : {}),
              ...(input.allowSignup !== undefined ? { allowSignup: input.allowSignup } : {}),
              ...(input.allowEmailAccountLinking !== undefined ? { allowEmailAccountLinking: input.allowEmailAccountLinking } : {}),
              ...(input.requireEmailVerified !== undefined ? { requireEmailVerified: input.requireEmailVerified } : {}),
              ...(input.adminEmails !== undefined ? { adminEmails: normalizeAdminEmails(input.adminEmails) as Prisma.InputJsonValue } : {}),
              ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
            },
          }),
        );
        return serializeOidcProvider(provider);
      } catch (error) {
        mapPrismaError(error);
      }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.oidcProviderConnection.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
