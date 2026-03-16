import { Prisma } from "@prisma/client";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "../trpc";

function getNotificationPreferences(settings: unknown) {
  const root = (settings ?? {}) as Record<string, unknown>;
  const preferences = (root.notificationPreferences ?? {}) as Record<string, unknown>;

  return {
    assignments: preferences.assignments !== false,
    comments: preferences.comments !== false,
    statusChanges: preferences.statusChanges !== false,
    mentions: preferences.mentions !== false,
  };
}

export const notificationRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.notification.findMany({
      where: { recipientId: ctx.session.user.id },
      include: {
        actor: { select: { id: true, name: true, email: true, image: true } },
        task: { select: { id: true, title: true, project: { select: { slug: true, key: true } }, taskNumber: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.notification.count({
      where: {
        recipientId: ctx.session.user.id,
        readAt: null,
      },
    });
  }),

  markRead: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.notification.updateMany({
        where: {
          id: input.id,
          recipientId: ctx.session.user.id,
        },
        data: { readAt: new Date() },
      });
      return { success: true };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.prisma.notification.updateMany({
      where: {
        recipientId: ctx.session.user.id,
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return { success: true };
  }),

  clearAll: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.prisma.notification.deleteMany({
      where: {
        recipientId: ctx.session.user.id,
      },
    });
    return { success: true };
  }),

  preferences: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { settings: true },
    });

    return getNotificationPreferences(user.settings);
  }),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        assignments: z.boolean(),
        comments: z.boolean(),
        statusChanges: z.boolean(),
        mentions: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { settings: true },
      });

      const settings = (user.settings ?? {}) as Record<string, unknown>;

      await ctx.prisma.user.update({
        where: { id: ctx.session.user.id },
        data: {
          settings: {
            ...settings,
            notificationPreferences: input,
          } as Prisma.InputJsonValue,
        },
      });

      return input;
    }),
});