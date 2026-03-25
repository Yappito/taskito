import { z } from "zod";
import { Prisma } from "@prisma/client";
import { createTRPCRouter, publicProcedure, protectedProcedure } from "../trpc";
import { getAccessibleProjectIds, requireProjectAccess } from "../authz";

const filterPresetSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  search: z.string().default(""),
  tagIds: z.array(z.string().cuid()).default([]),
  assigneeIds: z.array(z.string().cuid()).default([]),
  dueDateFrom: z.string().max(10).default(""),
  dueDateTo: z.string().max(10).default(""),
  closedAtFrom: z.string().max(10).default(""),
  closedAtTo: z.string().max(10).default(""),
});

function getSavedFilterPresets(settings: unknown, projectId: string) {
  const root = (settings ?? {}) as Record<string, unknown>;
  const presetStore = (root.savedFilterPresets ?? {}) as Record<string, unknown>;
  const projectPresets = presetStore[projectId];
  return Array.isArray(projectPresets) ? projectPresets : [];
}

function normalizeFilterPreset(preset: unknown) {
  const parsed = filterPresetSchema.safeParse(preset);
  return parsed.success ? parsed.data : null;
}

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

  /** List people who can be assigned work inside a project */
  people: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

      return ctx.prisma.projectMember.findMany({
        where: { projectId: input.projectId },
        select: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
        orderBy: [
          { user: { name: "asc" } },
          { user: { email: "asc" } },
        ],
      }).then(async (memberships) => {
        const users = memberships.map((membership) => membership.user);

        if (!users.some((user) => user.id === ctx.session.user.id)) {
          const currentUser = await ctx.prisma.user.findUnique({
            where: { id: ctx.session.user.id },
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          });

          if (currentUser) {
            users.push(currentUser);
          }
        }

        return users.sort((left, right) => {
          if (left.id === ctx.session.user.id) return -1;
          if (right.id === ctx.session.user.id) return 1;
          const leftLabel = left.name?.trim() || left.email;
          const rightLabel = right.name?.trim() || right.email;
          return leftLabel.localeCompare(rightLabel);
        });
      });
    }),

    /** Read saved task filter presets for the current user and project */
    filterPresets: protectedProcedure
      .input(z.object({ projectId: z.string().cuid() }))
      .query(async ({ ctx, input }) => {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: ctx.session.user.id },
          select: { settings: true },
        });

        return getSavedFilterPresets(user.settings, input.projectId)
          .map(normalizeFilterPreset)
          .filter((preset): preset is z.infer<typeof filterPresetSchema> => preset !== null);
      }),

    /** Save or update a task filter preset for the current user */
    saveFilterPreset: protectedProcedure
      .input(
        z.object({
          projectId: z.string().cuid(),
          preset: filterPresetSchema,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: ctx.session.user.id },
          select: { settings: true },
        });

        const settings = (user.settings ?? {}) as Record<string, unknown>;
        const presetStore = ((settings.savedFilterPresets ?? {}) as Record<string, unknown>);
        const currentPresets = getSavedFilterPresets(user.settings, input.projectId) as Array<Record<string, unknown>>;
        const nextPresets = [
          ...currentPresets.filter((preset) => preset.id !== input.preset.id),
          input.preset,
        ];

        await ctx.prisma.user.update({
          where: { id: ctx.session.user.id },
          data: {
            settings: {
              ...settings,
              savedFilterPresets: {
                ...presetStore,
                [input.projectId]: nextPresets,
              },
            } as Prisma.InputJsonValue,
          },
        });

        return input.preset;
      }),

    /** Delete a saved task filter preset for the current user */
    deleteFilterPreset: protectedProcedure
      .input(
        z.object({
          projectId: z.string().cuid(),
          presetId: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: ctx.session.user.id },
          select: { settings: true },
        });

        const settings = (user.settings ?? {}) as Record<string, unknown>;
        const presetStore = ((settings.savedFilterPresets ?? {}) as Record<string, unknown>);
        const currentPresets = getSavedFilterPresets(user.settings, input.projectId) as Array<Record<string, unknown>>;
        const nextPresets = currentPresets.filter((preset) => preset.id !== input.presetId);

        await ctx.prisma.user.update({
          where: { id: ctx.session.user.id },
          data: {
            settings: {
              ...settings,
              savedFilterPresets: {
                ...presetStore,
                [input.projectId]: nextPresets,
              },
            } as Prisma.InputJsonValue,
          },
        });

        return { success: true };
      }),

  /** List saved task templates for a project */
  templates: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

      const project = await ctx.prisma.project.findUniqueOrThrow({
        where: { id: input.projectId },
        select: { settings: true },
      });

      const settings = (project.settings ?? {}) as Record<string, unknown>;
      const templates = settings.taskTemplates;
      return Array.isArray(templates) ? templates : [];
    }),

  /** Save a reusable task template in project settings */
  saveTemplate: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        name: z.string().min(1).max(100),
        title: z.string().min(1).max(200),
        body: z.string().max(20000).nullable().optional(),
        statusId: z.string().cuid().optional(),
        priority: z.enum(["none", "low", "medium", "high", "urgent"]).default("none"),
        tagIds: z.array(z.string().cuid()).optional(),
        assigneeId: z.string().cuid().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        minimumRole: "owner",
      });

      if (input.statusId) {
        const status = await ctx.prisma.workflowStatus.findUnique({
          where: { id: input.statusId },
          select: { projectId: true },
        });

        if (!status || status.projectId !== input.projectId) {
          throw new Error("Template status must belong to the selected project");
        }
      }

      if (input.tagIds?.length) {
        const matchingTags = await ctx.prisma.tag.findMany({
          where: {
            projectId: input.projectId,
            id: { in: input.tagIds },
          },
          select: { id: true },
        });

        if (matchingTags.length !== input.tagIds.length) {
          throw new Error("One or more template tags do not belong to the selected project");
        }
      }

      if (input.assigneeId) {
        const assignee = await ctx.prisma.user.findUnique({
          where: { id: input.assigneeId },
          select: {
            id: true,
            role: true,
            projectMemberships: {
              where: { projectId: input.projectId },
              select: { userId: true },
            },
          },
        });

        if (!assignee || (assignee.role !== "admin" && assignee.projectMemberships.length === 0)) {
          throw new Error("Template assignee must be able to access the selected project");
        }
      }

      const project = await ctx.prisma.project.findUniqueOrThrow({
        where: { id: input.projectId },
        select: { settings: true },
      });

      const settings = (project.settings ?? {}) as Record<string, unknown>;
      const templates = Array.isArray(settings.taskTemplates) ? settings.taskTemplates : [];
      const nextTemplate = {
        id: crypto.randomUUID(),
        name: input.name,
        title: input.title,
        body: input.body ?? null,
        statusId: input.statusId ?? null,
        priority: input.priority,
        tagIds: input.tagIds ?? [],
        assigneeId: input.assigneeId ?? null,
      };

      await ctx.prisma.project.update({
        where: { id: input.projectId },
        data: {
          settings: {
            ...settings,
            taskTemplates: [...templates, nextTemplate],
          } as import("@prisma/client").Prisma.InputJsonValue,
        },
      });

      return nextTemplate;
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
          { name: "Backlog", color: "#6b7280", order: 0, category: "backlog" as const, isFinal: false },
          { name: "To Do", color: "#3b82f6", order: 1, category: "todo" as const, isFinal: false },
          { name: "In Progress", color: "#f59e0b", order: 2, category: "active" as const, isFinal: false },
          { name: "In Review", color: "#8b5cf6", order: 3, category: "active" as const, isFinal: false },
          { name: "Done", color: "#10b981", order: 4, category: "done" as const, isFinal: true },
          { name: "Cancelled", color: "#ef4444", order: 5, category: "cancelled" as const, isFinal: false },
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
