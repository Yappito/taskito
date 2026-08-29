import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ProjectPermission } from "@prisma/client";

import {
  assertOutboundUrlAllowed,
  OutboundUrlValidationError,
} from "@/lib/ai-provider-validation";
import { encryptSecret } from "@/lib/secret-crypto";
import { maxWebhooksPerProject } from "@/lib/webhook-limits";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";
import { requireProjectAccess } from "@/server/authz";
import { withSecretRotationLock } from "@/server/services/ai/secret-reencryption";
import { deliverWebhook, sendWebhookPing } from "@/server/services/webhooks/dispatcher";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

type PrismaClient = typeof import("@/lib/prisma").prisma;

/**
 * Outbound webhook management. Webhook endpoints receive task metadata on
 * every matching event, so every procedure requires the project-scoped
 * `automation_manage` permission AND `task_read`: a principal that can manage
 * automations but has been denied task read would otherwise register an
 * endpoint and keep receiving task metadata it can no longer see itself
 * (confused-deputy exfiltration, review finding 8). Delivery-time fan-out
 * re-checks the creator in the dispatcher.
 */

const WEBHOOK_MANAGE_PERMISSIONS: ProjectPermission[] = ["automation_manage", "task_read"];

const webhookUrlSchema = z.string().trim().min(1).max(2048);

const eventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);

const webhookSelect = {
  id: true,
  url: true,
  events: true,
  isEnabled: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const deliverySelect = {
  id: true,
  webhookId: true,
  event: true,
  status: true,
  responseCode: true,
  attempts: true,
  lastError: true,
  nextAttemptAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function webhookUrlPolicy() {
  return {
    label: "Webhook URL",
    allowPrivateHosts: process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS === "true",
    privateHostsHint: "Set WEBHOOK_ALLOW_PRIVATE_HOSTS=true to allow webhook delivery to private, self-hosted targets",
  };
}

async function validateWebhookUrl(url: string) {
  try {
    return await assertOutboundUrlAllowed(url, webhookUrlPolicy());
  } catch (error) {
    if (error instanceof OutboundUrlValidationError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

/** Loads a webhook for the given id and requires webhook-manage permissions on its project. */
async function requireWebhookAccess(
  prisma: PrismaClient,
  userId: string,
  webhookId: string,
) {
  const webhook = await prisma.webhook.findUnique({
    where: { id: webhookId },
    select: { id: true, projectId: true },
  });
  if (!webhook) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
  }
  await requireProjectAccess(prisma, userId, webhook.projectId, {
    permissions: WEBHOOK_MANAGE_PERMISSIONS,
  });
  return webhook;
}

export const webhookRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "automation_manage" });
      return ctx.prisma.webhook.findMany({
        where: { projectId: input.projectId },
        select: webhookSelect,
        orderBy: { createdAt: "desc" },
      });
    }),

  /** Creates a webhook. The plaintext signing secret is returned exactly once. */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        url: webhookUrlSchema,
        events: eventsSchema,
        isEnabled: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permissions: WEBHOOK_MANAGE_PERMISSIONS });
      await validateWebhookUrl(input.url);

      // Resource cap: bound the per-project fan-out surface before adding one more.
      const existingCount = Number((await ctx.prisma.webhook.count({ where: { projectId: input.projectId } })) ?? 0);
      const limit = maxWebhooksPerProject();
      if (existingCount >= limit) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `This project already has ${existingCount} webhook(s), which meets the per-project limit of ${limit}. Remove one before adding another.`,
        });
      }

      const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
      // The encryptedSecret is written under the shared rotation lock so a
      // concurrent master-key rotation can neither miss this row nor stomp it
      // with stale ciphertext (same guarantee as the AI/OIDC/S3 secret writers).
      const webhook = await withSecretRotationLock(ctx.prisma, (tx) =>
        tx.webhook.create({
          data: {
            projectId: input.projectId,
            url: input.url,
            events: input.events,
            isEnabled: input.isEnabled,
            createdByUserId: ctx.session.user.id,
            encryptedSecret: encryptSecret(secret),
          },
          select: webhookSelect,
        }),
      );

      return { ...webhook, secret };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        url: webhookUrlSchema.optional(),
        events: eventsSchema.optional(),
        isEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWebhookAccess(ctx.prisma, ctx.session.user.id, input.id);
      if (input.url !== undefined) {
        await validateWebhookUrl(input.url);
      }
      const updated = await ctx.prisma.webhook.update({
        where: { id: input.id },
        data: {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.events !== undefined ? { events: input.events } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        },
        select: webhookSelect,
      });
      return updated;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireWebhookAccess(ctx.prisma, ctx.session.user.id, input.id);
      await ctx.prisma.webhook.delete({ where: { id: input.id } });
      return { success: true };
    }),

  /** Sends a synchronous signed `ping` and reports the bounded outcome. */
  testDelivery: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const webhook = await ctx.prisma.webhook.findUnique({
        where: { id: input.id },
        select: { id: true, projectId: true, url: true, encryptedSecret: true },
      });
      if (!webhook) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
      }
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, webhook.projectId, {
        permissions: WEBHOOK_MANAGE_PERMISSIONS,
      });

      const result = await sendWebhookPing(ctx.prisma, {
        webhookId: webhook.id,
        url: webhook.url,
        encryptedSecret: webhook.encryptedSecret,
        projectId: webhook.projectId,
      });

      return {
        status: result.status,
        responseCode: result.responseCode,
        ...(result.error ? { error: result.error } : {}),
      };
    }),

  /** Delivery log for the project (optionally scoped to one webhook). */
  listDeliveries: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        webhookId: z.string().cuid().optional(),
        take: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "automation_manage" });
      return ctx.prisma.webhookDelivery.findMany({
        where: { webhook: { projectId: input.projectId }, ...(input.webhookId ? { webhookId: input.webhookId } : {}) },
        select: deliverySelect,
        orderBy: { createdAt: "desc" },
        take: input.take ?? 50,
      });
    }),

  /** Requeues a delivery from the log with a fresh attempt budget. */
  redeliver: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const delivery = (await ctx.prisma.webhookDelivery.findUnique({
        where: { id: input.id },
        select: { id: true, status: true, webhook: { select: { projectId: true, isEnabled: true } } },
      })) as { id: string; status: string; webhook: { projectId: string; isEnabled: boolean } } | null;
      if (!delivery) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
      }
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, delivery.webhook.projectId, {
        permissions: WEBHOOK_MANAGE_PERMISSIONS,
      });
      if (!delivery.webhook.isEnabled) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Webhook is disabled" });
      }

      await ctx.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "pending",
          attempts: 0,
          responseCode: null,
          lastError: null,
          nextAttemptAt: new Date(),
          leaseExpiresAt: null,
        },
      });

      // Fire-and-forget: the POST happens outside the mutation; the row is
      // already requeued, so the scheduler sweep would also pick it up.
      void deliverWebhook(ctx.prisma, delivery.id).catch(() => {});

      return { success: true };
    }),
});