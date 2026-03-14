import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { requireProjectAccess, requireWorkflowStatusAccess, requireWorkflowTransitionAccess } from "../authz";

/** Workflow management router */
export const workflowRouter = createTRPCRouter({
  /** List statuses for a project */
  statuses: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.workflowStatus.findMany({
        where: { projectId: input.projectId },
        orderBy: { order: "asc" },
      });
    }),

  /** List transitions for a project */
  transitions: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.workflowTransition.findMany({
        where: { projectId: input.projectId },
        include: { fromStatus: true, toStatus: true },
      });
    }),

  /** Create or update a workflow status */
  upsertStatus: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid().optional(),
        projectId: z.string().cuid(),
        name: z.string().min(1).max(50),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        order: z.number().int().min(0),
        category: z.enum(["backlog", "todo", "active", "done", "cancelled"]),
        autoArchive: z.boolean().optional(),
        autoArchiveDays: z.number().int().min(0).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        minimumRole: "owner",
      });

      if (input.id) {
        const existing = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, input.id, {
          minimumRole: "owner",
        });
        if (existing.projectId !== input.projectId) {
          throw new Error("Status does not belong to the specified project");
        }

        return ctx.prisma.workflowStatus.update({
          where: { id: input.id },
          data: {
            name: input.name,
            color: input.color,
            order: input.order,
            category: input.category,
            ...(input.autoArchive !== undefined ? { autoArchive: input.autoArchive } : {}),
            ...(input.autoArchiveDays !== undefined ? { autoArchiveDays: input.autoArchiveDays } : {}),
          },
        });
      }
      return ctx.prisma.workflowStatus.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          color: input.color,
          order: input.order,
          category: input.category,
          autoArchive: input.autoArchive ?? false,
          autoArchiveDays: input.autoArchiveDays ?? 0,
        },
      });
    }),

  /** Delete a workflow status */
  deleteStatus: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, input.id, {
        minimumRole: "owner",
      });
      await ctx.prisma.workflowStatus.delete({ where: { id: input.id } });
      return { success: true };
    }),

  /** Add a workflow transition */
  addTransition: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        fromStatusId: z.string().cuid(),
        toStatusId: z.string().cuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        minimumRole: "owner",
      });
      const fromStatus = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, input.fromStatusId, {
        minimumRole: "owner",
      });
      const toStatus = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, input.toStatusId, {
        minimumRole: "owner",
      });

      if (fromStatus.projectId !== input.projectId || toStatus.projectId !== input.projectId) {
        throw new Error("Workflow transitions must stay within a single project");
      }

      return ctx.prisma.workflowTransition.create({ data: input });
    }),

  /** Remove a workflow transition */
  removeTransition: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowTransitionAccess(ctx.prisma, ctx.session.user.id, input.id, {
        minimumRole: "owner",
      });
      await ctx.prisma.workflowTransition.delete({ where: { id: input.id } });
      return { success: true };
    }),

  /** Reorder statuses */
  reorderStatuses: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        statusIds: z.array(z.string().cuid()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        minimumRole: "owner",
      });
      const matchingStatuses = await ctx.prisma.workflowStatus.findMany({
        where: {
          projectId: input.projectId,
          id: { in: input.statusIds },
        },
        select: { id: true },
      });

      if (matchingStatuses.length !== input.statusIds.length) {
        throw new Error("One or more statuses do not belong to the specified project");
      }

      await ctx.prisma.$transaction(
        input.statusIds.map((id, index) =>
          ctx.prisma.workflowStatus.update({
            where: { id },
            data: { order: index },
          })
        )
      );
      return { success: true };
    }),

  /** Get valid transitions from a given status */
  validTransitionsFrom: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        fromStatusId: z.string().cuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const fromStatus = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, input.fromStatusId);
      if (fromStatus.projectId !== input.projectId) {
        throw new Error("Status does not belong to the specified project");
      }

      const transitions = await ctx.prisma.workflowTransition.findMany({
        where: {
          projectId: input.projectId,
          fromStatusId: input.fromStatusId,
        },
        include: { toStatus: true },
      });
      return transitions.map((t) => t.toStatus);
    }),
});
