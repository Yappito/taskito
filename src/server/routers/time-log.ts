import { z } from "zod";

import { requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

const MAX_LOG_SECONDS = 24 * 60 * 60;

function durationFromDates(startedAt: Date, endedAt: Date) {
  return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
}

export const timeLogRouter = createTRPCRouter({
  listForTask: protectedProcedure
    .input(z.object({ taskId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId, { permission: "time_log" });
      return ctx.prisma.timeLog.findMany({
        where: { taskId: input.taskId },
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
        orderBy: { startedAt: "desc" },
        take: 100,
      });
    }),

  summary: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), taskId: z.string().cuid().optional() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "time_log" });
      const where = { task: { projectId: input.projectId }, ...(input.taskId ? { taskId: input.taskId } : {}) };
      const [total, mine, running] = await Promise.all([
        ctx.prisma.timeLog.aggregate({ where, _sum: { duration: true } }),
        ctx.prisma.timeLog.aggregate({ where: { ...where, userId: ctx.session.user.id }, _sum: { duration: true } }),
        ctx.prisma.timeLog.findFirst({
          where: { ...where, userId: ctx.session.user.id, endedAt: null },
          orderBy: { startedAt: "desc" },
        }),
      ]);

      return {
        totalSeconds: total._sum.duration ?? 0,
        mySeconds: mine._sum.duration ?? 0,
        running,
      };
    }),

  startTimer: protectedProcedure
    .input(z.object({ taskId: z.string().cuid(), description: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId, { permission: "time_log" });
      const existing = await ctx.prisma.timeLog.findFirst({ where: { userId: ctx.session.user.id, endedAt: null } });
      if (existing) {
        throw new Error("Stop your running timer before starting a new one");
      }
      return ctx.prisma.timeLog.create({
        data: {
          taskId: input.taskId,
          userId: ctx.session.user.id,
          description: input.description,
          duration: 0,
          startedAt: new Date(),
        },
      });
    }),

  stopTimer: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const entry = await ctx.prisma.timeLog.findUniqueOrThrow({ where: { id: input.id }, include: { task: { select: { projectId: true } } } });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, entry.task.projectId, { permission: "time_log" });
      if (entry.userId !== ctx.session.user.id) {
        throw new Error("You can only stop your own timer");
      }
      if (entry.endedAt) {
        return entry;
      }
      const endedAt = new Date();
      const duration = Math.min(durationFromDates(entry.startedAt, endedAt), MAX_LOG_SECONDS);
      return ctx.prisma.timeLog.update({ where: { id: input.id }, data: { endedAt, duration } });
    }),

  addManual: protectedProcedure
    .input(z.object({
      taskId: z.string().cuid(),
      startedAt: z.date(),
      endedAt: z.date().optional(),
      duration: z.number().int().min(1).max(MAX_LOG_SECONDS).optional(),
      description: z.string().trim().max(500).optional(),
    }).refine((value) => value.duration !== undefined || value.endedAt !== undefined, { message: "Manual time logs require a duration or end time" }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId, { permission: "time_log" });
      const endedAt = input.endedAt;
      const duration = input.duration ?? (endedAt ? durationFromDates(input.startedAt, endedAt) : 0);
      if (duration <= 0 || duration > MAX_LOG_SECONDS) {
        throw new Error("Time log duration must be between 1 second and 24 hours");
      }
      return ctx.prisma.timeLog.create({
        data: {
          taskId: input.taskId,
          userId: ctx.session.user.id,
          description: input.description,
          startedAt: input.startedAt,
          endedAt: endedAt ?? new Date(input.startedAt.getTime() + duration * 1000),
          duration,
        },
      });
    }),
});
