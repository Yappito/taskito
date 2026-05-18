import { z } from "zod";

import { requireProjectAccess } from "@/server/authz";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

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

      const [tasks, totalLogged] = await Promise.all([
        ctx.prisma.task.findMany({
          where: baseWhere,
          include: {
            status: { select: { id: true, name: true, color: true, category: true, isFinal: true } },
            assignee: { select: { id: true, name: true, email: true, image: true } },
            sprint: { select: { id: true, name: true, status: true, startDate: true, endDate: true } },
          },
          orderBy: [{ dueDate: "asc" }, { taskNumber: "asc" }],
          take: 500,
        }),
        ctx.prisma.timeLog.aggregate({
          where: { task: baseWhere },
          _sum: { duration: true },
        }),
      ]);

      const activeTasks = tasks.filter((task) => !task.archivedAt || task.archivedAt > now);
      const completedTasks = tasks.filter((task) => task.closedAt || task.status.category === "done" || task.status.category === "cancelled");
      const overdueTasks = activeTasks.filter((task) => task.dueDate < today && !task.closedAt && task.status.category !== "done" && task.status.category !== "cancelled");

      const statusDistribution = Object.values(tasks.reduce<Record<string, { id: string; name: string; color: string; count: number }>>((acc, task) => {
        acc[task.status.id] ??= { id: task.status.id, name: task.status.name, color: task.status.color, count: 0 };
        acc[task.status.id].count += 1;
        return acc;
      }, {}));

      const priorityDistribution = Object.values(tasks.reduce<Record<string, { priority: string; count: number }>>((acc, task) => {
        acc[task.priority] ??= { priority: task.priority, count: 0 };
        acc[task.priority].count += 1;
        return acc;
      }, {}));

      const velocity = Array.from({ length: 7 }, (_, index) => {
        const day = addDays(weekStart, index);
        const nextDay = addDays(day, 1);
        return {
          date: day.toISOString(),
          created: tasks.filter((task) => task.createdAt >= day && task.createdAt < nextDay).length,
          completed: tasks.filter((task) => task.closedAt && task.closedAt >= day && task.closedAt < nextDay).length,
        };
      });

      const closedDurations = completedTasks
        .filter((task) => task.closedAt)
        .map((task) => Math.max(0, task.closedAt!.getTime() - task.createdAt.getTime()));
      const avgCycleTimeHours = closedDurations.length
        ? Math.round((closedDurations.reduce((sum, value) => sum + value, 0) / closedDurations.length / 3_600_000) * 10) / 10
        : null;

      return {
        totalTasks: tasks.length,
        activeTasks: activeTasks.length,
        completedTasks: completedTasks.length,
        overdueTasks: overdueTasks.length,
        completionRate: tasks.length ? Math.round((completedTasks.length / tasks.length) * 100) : 0,
        avgCycleTimeHours,
        loggedSeconds: totalLogged._sum.duration ?? 0,
        statusDistribution,
        priorityDistribution,
        velocity,
        atRiskTasks: overdueTasks.slice(0, 10).map((task) => ({
          id: task.id,
          taskNumber: task.taskNumber,
          title: task.title,
          dueDate: task.dueDate,
          status: task.status,
          assignee: task.assignee,
        })),
      };
    }),
});
