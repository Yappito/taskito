import { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

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

  const memberships = await prisma.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT "userId"
    FROM "ProjectMember"
    WHERE "projectId" = ${projectId}
      AND "userId" IN (${Prisma.join(uniqueMemberIds)})
    FOR UPDATE
  `);

  if (memberships.length !== uniqueMemberIds.length) {
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
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { minimumRole: "owner" });
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
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { minimumRole: "owner" });
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
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { minimumRole: "owner" });

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
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, sprint.projectId, { minimumRole: "owner" });
      await ctx.prisma.sprint.delete({ where: { id: input.id } });
      return { success: true };
    }),

  assignTask: protectedProcedure
    .input(z.object({ taskId: z.string().cuid(), sprintId: z.string().cuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const task = await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
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
