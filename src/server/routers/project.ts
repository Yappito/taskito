import { z } from "zod";
import { createTRPCRouter, publicProcedure, protectedProcedure } from "../trpc";
import { getAccessibleProjectIds, requireProjectAccess } from "../authz";

/** Health check and project router */
export const projectRouter = createTRPCRouter({
  /** Health check endpoint */
  health: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  /** List all projects */
  list: protectedProcedure.query(async ({ ctx }) => {
    const projectIds = await getAccessibleProjectIds(ctx.prisma, ctx.session.user.id);
    if (projectIds.length === 0) {
      return [];
    }

    return ctx.prisma.project.findMany({
      where: { id: { in: projectIds } },
      orderBy: { createdAt: "desc" },
    });
  }),

  /** Get a single project by slug */
  bySlug: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.prisma.project.findUnique({
        where: { slug: input.slug },
        include: {
          statuses: { orderBy: { order: "asc" } },
        },
      });

      if (!project) {
        return null;
      }

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, project.id);
      return project;
    }),

  /** Create a new project with default workflow */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
        key: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/),
        description: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            name: input.name,
            slug: input.slug,
            key: input.key,
            description: input.description,
              members: {
                create: {
                  userId: ctx.session.user.id,
                  role: "owner",
                },
              },
          },
        });

        // Create default workflow statuses
        const defaultStatuses = [
          { name: "Backlog", color: "#6b7280", order: 0, category: "backlog" as const },
          { name: "To Do", color: "#3b82f6", order: 1, category: "todo" as const },
          { name: "In Progress", color: "#f59e0b", order: 2, category: "active" as const },
          { name: "In Review", color: "#8b5cf6", order: 3, category: "active" as const },
          { name: "Done", color: "#10b981", order: 4, category: "done" as const },
          { name: "Cancelled", color: "#ef4444", order: 5, category: "cancelled" as const },
        ];

        const statuses = await Promise.all(
          defaultStatuses.map((s) =>
            tx.workflowStatus.create({
              data: { ...s, projectId: project.id },
            })
          )
        );

        // Create default transitions (linear flow + skip to cancelled)
        const transitions: Array<{ fromStatusId: string; toStatusId: string }> = [];
        for (let i = 0; i < statuses.length - 2; i++) {
          transitions.push({
            fromStatusId: statuses[i].id,
            toStatusId: statuses[i + 1].id,
          });
          // Allow skip to Cancelled from any non-terminal status
          transitions.push({
            fromStatusId: statuses[i].id,
            toStatusId: statuses[statuses.length - 1].id,
          });
        }

        await Promise.all(
          transitions.map((t) =>
            tx.workflowTransition.create({
              data: { ...t, projectId: project.id },
            })
          )
        );

        // Set default status
        await tx.project.update({
          where: { id: project.id },
          data: {
            settings: { defaultStatusId: statuses[0].id },
          },
        });

        return project;
      });
    }),

  /** Update project name / description / settings */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        settings: z.record(z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, id, {
        minimumRole: "owner",
      });

      return ctx.prisma.project.update({
        where: { id },
        data: {
          ...data,
          settings: data.settings as import("@prisma/client").Prisma.InputJsonValue | undefined,
        },
      });
    }),

  /** Delete a project and all its data */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.id, {
        minimumRole: "owner",
      });
      await ctx.prisma.project.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
