import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { requireProjectAccess, requireTagAccess } from "../authz";

/** Tag management router */
export const tagRouter = createTRPCRouter({
  /** List all tags for a project */
  list: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.tag.findMany({
        where: { projectId: input.projectId },
        orderBy: { name: "asc" },
      });
    }),

  /** Create a new tag */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        name: z.string().min(1).max(50),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#6b7280"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        minimumRole: "owner",
      });
      return ctx.prisma.tag.create({ data: input });
    }),

  /** Update a tag */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(50).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await requireTagAccess(ctx.prisma, ctx.session.user.id, id, {
        minimumRole: "owner",
      });
      return ctx.prisma.tag.update({ where: { id }, data });
    }),

  /** Delete a tag */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTagAccess(ctx.prisma, ctx.session.user.id, input.id, {
        minimumRole: "owner",
      });
      await ctx.prisma.tag.delete({ where: { id: input.id } });
      return { success: true };
    }),

  /** Merge source tag into target: reassign all tasks, then delete source */
  merge: protectedProcedure
    .input(
      z.object({
        sourceTagId: z.string().cuid(),
        targetTagId: z.string().cuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { sourceTagId, targetTagId } = input;
      const sourceTag = await requireTagAccess(ctx.prisma, ctx.session.user.id, sourceTagId, {
        minimumRole: "owner",
      });
      const targetTag = await requireTagAccess(ctx.prisma, ctx.session.user.id, targetTagId, {
        minimumRole: "owner",
      });

      if (sourceTag.projectId !== targetTag.projectId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cross-project tag merges are not allowed",
        });
      }

      const mergedCount = await ctx.prisma.$transaction(
        async (tx) => {
          const currentSourceTaskTags = await tx.taskTag.findMany({
            where: { tagId: sourceTagId },
          });

          const existingTargetTaskIds = new Set(
            (
              await tx.taskTag.findMany({
                where: { tagId: targetTagId },
                select: { taskId: true },
              })
            ).map((taskTag) => taskTag.taskId)
          );

          const toCreate = currentSourceTaskTags
            .filter((taskTag) => !existingTargetTaskIds.has(taskTag.taskId))
            .map((taskTag) => ({ taskId: taskTag.taskId, tagId: targetTagId }));

          if (toCreate.length > 0) {
            await tx.taskTag.createMany({ data: toCreate, skipDuplicates: true });
          }
          await tx.taskTag.deleteMany({ where: { tagId: sourceTagId } });
          await tx.tag.delete({ where: { id: sourceTagId } });
          return currentSourceTaskTags.length;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return { success: true, mergedCount };
    }),
});
