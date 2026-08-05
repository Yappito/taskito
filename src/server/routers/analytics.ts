import { Prisma } from "@prisma/client";
import { z } from "zod";

import { requireProjectAccess } from "@/server/authz";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

/** Number of most recently closed tasks sampled for cycle-time calculation. */
const CYCLE_TIME_SAMPLE_SIZE = 500;

/** Top-N overdue tasks included in the summary. */
const AT_RISK_LIMIT = 10;

const priorityRank: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export const analyticsRouter = createTRPCRouter({
  projectSummary: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), sprintId: z.string().cuid().optional() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

      const now = new Date();
      const today = startOfDay(now);
      const weekStart = addDays(today, -6);
      const baseWhere = {
        projectId: input.projectId,
        ...(input.sprintId ? { sprintId: input.sprintId } : {}),
      };

      const activeArchivedWhere: Prisma.TaskWhereInput = {
        OR: [{ archivedAt: null }, { archivedAt: { gt: now } }],
      };
      const completedWhere: Prisma.TaskWhereInput = {
        ...baseWhere,
        OR: [
          { closedAt: { not: null } },
          { status: { category: { in: ["done", "cancelled"] } } },
        ],
      };
      const overdueWhere: Prisma.TaskWhereInput = {
        ...baseWhere,
        ...activeArchivedWhere,
        dueDate: { lt: today },
        closedAt: null,
        status: { category: { notIn: ["done", "cancelled"] } },
      };

      const velocityDays = Array.from({ length: 7 }, (_, index) => {
        const day = addDays(weekStart, index);
        return { day, nextDay: addDays(day, 1) };
      });

      const [
        totalTasks,
        activeTasks,
        completedTasks,
        overdueTasks,
        statusGroups,
        priorityGroups,
        statuses,
        // Cycle time is sampled on the most recent 500 completed tasks (bounded
        // by design — the full history is not fetched for the average).
        recentClosedTasks,
        atRiskTasks,
        totalLogged,
      ] = await Promise.all([
        ctx.prisma.task.count({ where: baseWhere }),
        ctx.prisma.task.count({ where: { ...baseWhere, ...activeArchivedWhere } }),
        ctx.prisma.task.count({ where: completedWhere }),
        ctx.prisma.task.count({ where: overdueWhere }),
        ctx.prisma.task.groupBy({
          by: ["statusId"],
          where: baseWhere,
          _count: { _all: true },
        }),
        ctx.prisma.task.groupBy({
          by: ["priority"],
          where: baseWhere,
          _count: { _all: true },
        }),
        ctx.prisma.workflowStatus.findMany({
          where: { projectId: input.projectId },
          select: { id: true, name: true, color: true, order: true },
          orderBy: { order: "asc" },
        }),
        ctx.prisma.task.findMany({
          where: { ...completedWhere, closedAt: { not: null } },
          select: { createdAt: true, closedAt: true },
          orderBy: { closedAt: "desc" },
          take: CYCLE_TIME_SAMPLE_SIZE,
        }),
        ctx.prisma.task.findMany({
          where: overdueWhere,
          select: {
            id: true,
            taskNumber: true,
            title: true,
            dueDate: true,
            status: { select: { id: true, name: true, color: true, category: true, isFinal: true } },
            assignee: { select: { id: true, name: true, email: true, image: true } },
          },
          orderBy: [{ dueDate: "asc" }, { taskNumber: "asc" }],
          take: AT_RISK_LIMIT,
        }),
        ctx.prisma.timeLog.aggregate({
          where: { task: baseWhere },
          _sum: { duration: true },
        }),
      ]);

      const statusById = new Map(statuses.map((status) => [status.id, status]));
      const statusDistribution = statusGroups
        .map((group) => ({
          id: group.statusId,
          name: statusById.get(group.statusId)?.name ?? "Unknown",
          color: statusById.get(group.statusId)?.color ?? "#6b7280",
          count: group._count._all,
        }))
        .sort((a, b) => (statusById.get(a.id)?.order ?? 0) - (statusById.get(b.id)?.order ?? 0));

      const priorityDistribution = priorityGroups
        .map((group) => ({ priority: group.priority, count: group._count._all }))
        .sort((a, b) => (priorityRank[a.priority] ?? 0) - (priorityRank[b.priority] ?? 0));

      const velocityCounts = await Promise.all(
        velocityDays.flatMap(({ day, nextDay }) => [
          ctx.prisma.task.count({ where: { ...baseWhere, createdAt: { gte: day, lt: nextDay } } }),
          ctx.prisma.task.count({ where: { ...baseWhere, closedAt: { gte: day, lt: nextDay } } }),
        ])
      );
      const velocity = velocityDays.map(({ day }, index) => ({
        date: day.toISOString(),
        created: velocityCounts[index * 2],
        completed: velocityCounts[index * 2 + 1],
      }));

      const closedDurations = recentClosedTasks
        .filter((task) => task.closedAt)
        .map((task) => Math.max(0, task.closedAt!.getTime() - task.createdAt.getTime()));
      const avgCycleTimeHours = closedDurations.length
        ? Math.round((closedDurations.reduce((sum, value) => sum + value, 0) / closedDurations.length / 3_600_000) * 10) / 10
        : null;

      return {
        totalTasks,
        activeTasks,
        completedTasks,
        overdueTasks,
        completionRate: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
        avgCycleTimeHours,
        loggedSeconds: totalLogged._sum.duration ?? 0,
        statusDistribution,
        priorityDistribution,
        velocity,
        atRiskTasks,
      };
    }),
});
