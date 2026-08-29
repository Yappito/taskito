import { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { canAccessProject, requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { FINISHED_CATEGORIES, upsertSprintSnapshot } from "@/server/services/sprint-snapshot";

const sprintInput = z.object({
  projectId: z.string().cuid(),
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(2000).nullable().optional(),
  startDate: z.date(),
  endDate: z.date(),
  memberIds: z.array(z.string().cuid()).max(50).optional(),
  status: z.enum(["planning", "active", "completed"]).default("planning"),
});

function normalizeSprintMemberIds(memberIds: string[] | undefined) {
  const uniqueMemberIds = [...new Set(memberIds ?? [])];
  if (uniqueMemberIds.length === 0) {
    return [];
  }

  return uniqueMemberIds;
}

function ensureSprintDateRange(startDate: Date, endDate: Date) {
  if (endDate < startDate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Sprint end date must be after the start date",
    });
  }
}

async function validateSprintMembers(
  prisma: Prisma.TransactionClient,
  projectId: string,
  memberIds: string[] | undefined
) {
  const uniqueMemberIds = normalizeSprintMemberIds(memberIds);
  if (uniqueMemberIds.length === 0) {
    return [];
  }

  const users = await prisma.user.findMany({
    where: { id: { in: uniqueMemberIds } },
    select: { id: true },
  });
  const accessResults = await Promise.all(
    uniqueMemberIds.map((userId) => canAccessProject(prisma, userId, projectId))
  );

  if (users.length !== uniqueMemberIds.length || accessResults.some((hasAccess) => !hasAccess)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "All sprint members must belong to the project",
    });
  }

  return uniqueMemberIds;
}

function mapSprintMutationError(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A sprint with this name already exists in the project",
    });
  }

  throw error;
}

const sprintInclude = {
  _count: { select: { tasks: true } },
  members: {
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.SprintInclude;

export const sprintRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.sprint.findMany({
        where: { projectId: input.projectId },
        include: {
          _count: { select: { tasks: true } },
          members: {
            include: {
              user: { select: { id: true, name: true, email: true, image: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: [{ status: "asc" }, { startDate: "desc" }, { order: "asc" }],
      });
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const sprint = await ctx.prisma.sprint.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          tasks: {
            include: {
              status: true,
              tags: { include: { tag: true } },
              assignee: { select: { id: true, name: true, email: true, image: true } },
              creator: { select: { id: true, name: true, email: true, image: true } },
              project: { select: { key: true, slug: true } },
            },
            orderBy: [{ status: { order: "asc" } }, { dueDate: "asc" }],
          },
          members: {
            include: {
              user: { select: { id: true, name: true, email: true, image: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId);
      return sprint;
    }),

  create: protectedProcedure
    .input(sprintInput.refine((value) => value.endDate >= value.startDate, { message: "Sprint end date must be after the start date" }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "sprint_manage" });
      try {
        return await ctx.prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} FOR UPDATE`);
          const last = await tx.sprint.findFirst({ where: { projectId: input.projectId }, orderBy: { order: "desc" }, select: { order: true } });
          const memberIds = await validateSprintMembers(tx, input.projectId, input.memberIds);

          return tx.sprint.create({
            data: {
              projectId: input.projectId,
              name: input.name,
              goal: input.goal ?? null,
              startDate: input.startDate,
              endDate: input.endDate,
              status: input.status,
              order: (last?.order ?? 0) + 1,
              members: memberIds.length ? { createMany: { data: memberIds.map((userId) => ({ userId })) } } : undefined,
            },
            include: {
              _count: { select: { tasks: true } },
              members: {
                include: { user: { select: { id: true, name: true, email: true, image: true } } },
                orderBy: { createdAt: "asc" },
              },
            },
          });
        });
      } catch (error) {
        mapSprintMutationError(error);
      }
    }),

  update: protectedProcedure
    .input(sprintInput.omit({ projectId: true }).partial().extend({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const sprint = await ctx.prisma.sprint.findUniqueOrThrow({
        where: { id: input.id },
        select: { projectId: true, startDate: true, endDate: true },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { permission: "sprint_manage" });
      ensureSprintDateRange(input.startDate ?? sprint.startDate, input.endDate ?? sprint.endDate);

      try {
        return await ctx.prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sprint" WHERE "id" = ${input.id} FOR UPDATE`);
          const memberIds = input.memberIds !== undefined
            ? await validateSprintMembers(tx, sprint.projectId, input.memberIds)
            : null;

          const updated = await tx.sprint.update({
            where: { id: input.id },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.goal !== undefined ? { goal: input.goal } : {}),
              ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
              ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
            },
          });

          if (memberIds !== null) {
            await tx.sprintMember.deleteMany({ where: { sprintId: input.id } });
            if (memberIds.length > 0) {
              await tx.sprintMember.createMany({
                data: memberIds.map((userId) => ({ sprintId: input.id, userId })),
                skipDuplicates: true,
              });
            }
          }

          return tx.sprint.findUniqueOrThrow({
            where: { id: updated.id },
            include: {
              _count: { select: { tasks: true } },
              members: {
                include: { user: { select: { id: true, name: true, email: true, image: true } } },
                orderBy: { createdAt: "asc" },
              },
            },
          });
        });
      } catch (error) {
        mapSprintMutationError(error);
      }
    }),

  assignMembers: protectedProcedure
    .input(z.object({ id: z.string().cuid(), memberIds: z.array(z.string().cuid()).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const sprint = await ctx.prisma.sprint.findUniqueOrThrow({ where: { id: input.id }, select: { projectId: true } });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { permission: "sprint_manage" });

      return ctx.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sprint" WHERE "id" = ${input.id} FOR UPDATE`);
        const memberIds = await validateSprintMembers(tx, sprint.projectId, input.memberIds);

        await tx.sprintMember.deleteMany({ where: { sprintId: input.id } });
        if (memberIds.length > 0) {
          await tx.sprintMember.createMany({
            data: memberIds.map((userId) => ({ sprintId: input.id, userId })),
            skipDuplicates: true,
          });
        }

        return tx.sprint.findUniqueOrThrow({
          where: { id: input.id },
          include: {
            _count: { select: { tasks: true } },
            members: {
              include: { user: { select: { id: true, name: true, email: true, image: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        });
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const sprint = await ctx.prisma.sprint.findUniqueOrThrow({ where: { id: input.id }, select: { projectId: true } });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { permission: "sprint_manage" });
      await ctx.prisma.sprint.delete({ where: { id: input.id } });
      return { success: true };
    }),

  start: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const sprint = await ctx.prisma.sprint.findUniqueOrThrow({
        where: { id: input.id },
        select: { id: true, projectId: true, status: true },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { permission: "sprint_manage" });

      try {
        return await ctx.prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sprint" WHERE "id" = ${input.id} FOR UPDATE`);
          const current = await tx.sprint.findUniqueOrThrow({
            where: { id: input.id },
            select: { id: true, status: true },
          });
          if (current.status === "completed") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot start a completed sprint" });
          }

          const activeSprint = await tx.sprint.findFirst({
            where: {
              projectId: sprint.projectId,
              status: "active",
              id: { not: input.id },
            },
            select: { id: true, name: true },
          });
          if (activeSprint) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Project already has an active sprint: ${activeSprint.name}`,
            });
          }

          const now = new Date();
          const updated = await tx.sprint.update({
            where: { id: input.id },
            data: { status: "active", startedAt: now },
          });

          // First burndown data point for the newly started sprint.
          const snapshotTasks = await tx.task.findMany({
            where: { sprintId: input.id },
            select: { status: { select: { category: true } } },
          });
          const finishedCount = snapshotTasks.filter((task) => (FINISHED_CATEGORIES as readonly string[]).includes(task.status.category)).length;
          await upsertSprintSnapshot(tx, {
            sprintId: input.id,
            date: now,
            remainingCount: snapshotTasks.length - finishedCount,
            completedCount: finishedCount,
          });

          return tx.sprint.findUniqueOrThrow({ where: { id: updated.id }, include: sprintInclude });
        });
      } catch (error) {
        mapSprintMutationError(error);
      }
    }),

  complete: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        // Where unfinished work goes: back to the backlog, to the next planned
        // sprint (earliest startDate), or into a specific sprint (id).
        carryOverTo: z.union([z.literal("backlog"), z.literal("next"), z.string().cuid()]).default("backlog"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const sprint = await ctx.prisma.sprint.findUniqueOrThrow({
        where: { id: input.id },
        select: { id: true, projectId: true, status: true },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { permission: "sprint_manage" });

      try {
        return await ctx.prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sprint" WHERE "id" = ${input.id} FOR UPDATE`);
          const current = await tx.sprint.findUniqueOrThrow({
            where: { id: input.id },
            select: { id: true, status: true },
          });
          if (current.status === "completed") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Sprint is already completed" });
          }

          let targetSprintId: string | null = null;
          if (input.carryOverTo === "next") {
            const nextSprint = await tx.sprint.findFirst({
              where: {
                projectId: sprint.projectId,
                status: "planning",
                id: { not: input.id },
              },
              orderBy: [{ startDate: "asc" }, { order: "asc" }],
              select: { id: true, name: true },
            });
            if (!nextSprint) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "No planned sprint available to carry work over to",
              });
            }
            targetSprintId = nextSprint.id;
          } else if (input.carryOverTo !== "backlog") {
            const targetSprint = await tx.sprint.findUnique({
              where: { id: input.carryOverTo },
              select: { id: true, projectId: true, status: true },
            });
            if (!targetSprint || targetSprint.projectId !== sprint.projectId) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "Carry-over target sprint must belong to the same project",
              });
            }
            if (targetSprint.id === sprint.id) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "Cannot carry work over to the sprint being completed",
              });
            }
            if (targetSprint.status === "completed") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "Cannot carry work over to a completed sprint",
              });
            }
            targetSprintId = targetSprint.id;
          }

          const tasks = await tx.task.findMany({
            where: { sprintId: input.id },
            select: { id: true, status: { select: { category: true } } },
          });
          const finishedIds = tasks
            .filter((task) => (FINISHED_CATEGORIES as readonly string[]).includes(task.status.category))
            .map((task) => task.id);
          const carriedIds = tasks
            .filter((task) => !(FINISHED_CATEGORIES as readonly string[]).includes(task.status.category))
            .map((task) => task.id);

          if (carriedIds.length > 0) {
            await tx.task.updateMany({
              where: { id: { in: carriedIds } },
              data: { sprintId: targetSprintId },
            });
          }

          // Completion-day snapshot: after the carry-over every unfinished task
          // has left the sprint, so the remaining work is zero.
          const now = new Date();
          await upsertSprintSnapshot(tx, {
            sprintId: input.id,
            date: now,
            remainingCount: 0,
            completedCount: finishedIds.length,
          });

          const updated = await tx.sprint.update({
            where: { id: input.id },
            data: {
              status: "completed",
              completedAt: now,
              summary: {
                committedCount: tasks.length,
                completedCount: finishedIds.length,
                carriedOverCount: carriedIds.length,
                completedTaskIds: finishedIds,
              },
            },
          });

          return tx.sprint.findUniqueOrThrow({
            where: { id: updated.id },
            include: sprintInclude,
          });
        });
      } catch (error) {
        mapSprintMutationError(error);
      }
    }),

  assignTask: protectedProcedure
    .input(z.object({ taskId: z.string().cuid(), sprintId: z.string().cuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const task = await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId, { permission: "task_update" });
      if (input.sprintId) {
        const sprint = await ctx.prisma.sprint.findUniqueOrThrow({ where: { id: input.sprintId }, select: { projectId: true, status: true } });
        if (sprint.projectId !== task.projectId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Sprint must belong to the same project as the task" });
        }
        if (sprint.status === "completed") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot assign tasks to a completed sprint" });
        }
      }
      return ctx.prisma.task.update({ where: { id: input.taskId }, data: { sprintId: input.sprintId } });
    }),
});
