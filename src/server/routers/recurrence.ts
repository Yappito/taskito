import { z } from "zod";

import { requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { processDueRecurrences } from "@/server/services/recurrence-processor";
import { withSchedulerLock } from "@/server/services/scheduler";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

function dateKey(date: Date) {
  return date.toISOString().split("T")[0];
}

export const recurrenceRouter = createTRPCRouter({
  set: protectedProcedure
    .input(z.object({
      taskId: z.string().cuid(),
      frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
      interval: z.number().int().min(1).max(365).default(1),
      dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
      dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
      endDate: z.date().nullable().optional(),
      nextDueDate: z.date(),
    }).superRefine((value, refinementCtx) => {
      if (value.endDate && dateKey(value.nextDueDate) > dateKey(value.endDate)) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Next due date must be on or before the recurrence end date",
          path: ["nextDueDate"],
        });
      }

      if (dateKey(value.nextDueDate) < dateKey(new Date())) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Next due date must be today or later",
          path: ["nextDueDate"],
        });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId, { permission: "task_update" });
      return ctx.prisma.recurrenceRule.upsert({
        where: { taskId: input.taskId },
        create: {
          taskId: input.taskId,
          frequency: input.frequency,
          interval: input.interval,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
          endDate: input.endDate ?? null,
          nextDueDate: input.nextDueDate,
        },
        update: {
          frequency: input.frequency,
          interval: input.interval,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
          endDate: input.endDate ?? null,
          nextDueDate: input.nextDueDate,
        },
      });
    }),

  remove: protectedProcedure
    .input(z.object({ taskId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId, { permission: "task_update" });
      await ctx.prisma.recurrenceRule.deleteMany({ where: { taskId: input.taskId } });
      return { success: true };
    }),

  processDue: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), limit: z.number().int().min(1).max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "automation_manage" });
      // M8: take the same scheduler advisory lock as the built-in tick, so a
      // manual run never races a concurrent tick and double-creates the next
      // occurrence of a recurring task. `null` means the lock was held (a tick
      // is in flight) — surface that as a skipped result. M9: the lock helper
      // also hands over the tick deadline signal. The lock is session-scoped
      // on a dedicated connection, so it protects exclusively across replicas
      // for exactly as long as the run is live (finding 7) and never occupies
      // a shared-pool connection the jobs need (finding 8).
      const result = await withSchedulerLock((signal) =>
        processDueRecurrences(ctx.prisma, { projectId: input.projectId, limit: input.limit, signal }),
      );
      return result ?? { processed: 0, createdTaskIds: [], skipped: true as const };
    }),
});
