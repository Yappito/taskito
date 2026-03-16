import { z } from "zod";
import { Prisma } from "@prisma/client";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { autoTagTask } from "../services/auto-tagger";
import { indexTask, removeTaskFromIndex } from "../services/meilisearch";
import {
  requireProjectAccess,
  requireTagAccess,
  requireTaskAccess,
  requireTaskLinkAccess,
  requireWorkflowStatusAccess,
} from "../authz";

async function validateNoCycle(
  ctx: { prisma: typeof import("@/lib/prisma").prisma },
  projectId: string,
  sourceTaskId: string,
  targetTaskId: string
) {
  const links = await ctx.prisma.taskLink.findMany({
    where: {
      sourceTask: { projectId },
    },
    select: {
      sourceTaskId: true,
      targetTaskId: true,
    },
  });

  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    const current = adjacency.get(link.sourceTaskId) ?? [];
    current.push(link.targetTaskId);
    adjacency.set(link.sourceTaskId, current);
  }

  const stack = [targetTaskId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceTaskId) {
      throw new Error("Task links may not create dependency cycles");
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      stack.push(next);
    }
  }
}

async function validateAssigneeAccess(
  ctx: { prisma: typeof import("@/lib/prisma").prisma },
  projectId: string,
  assigneeId: string | null | undefined
) {
  if (!assigneeId) {
    return;
  }

  const user = await ctx.prisma.user.findUnique({
    where: { id: assigneeId },
    select: {
      id: true,
      role: true,
      projectMemberships: {
        where: { projectId },
        select: { userId: true },
      },
    },
  });

  if (!user) {
    throw new Error("Assignee does not exist");
  }

  if (user.role !== "admin" && user.projectMemberships.length === 0) {
    throw new Error("Assignee must be a member of the selected project");
  }
}

/** Task CRUD router */
export const taskRouter = createTRPCRouter({
  /** List tasks with filtering and cursor pagination */
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        statusIds: z.array(z.string()).optional(),
        tagIds: z.array(z.string()).optional(),
        priorities: z.array(z.enum(["none", "low", "medium", "high", "urgent"])).optional(),
        dueDateFrom: z.date().optional(),
        dueDateTo: z.date().optional(),
        search: z.string().optional(),
        assigneeIds: z.array(z.string().cuid()).optional(),
        includeArchived: z.boolean().optional(),
        archivedOnly: z.boolean().optional(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      const { projectId, cursor, limit, statusIds, tagIds, priorities, dueDateFrom, dueDateTo, search, assigneeIds, includeArchived, archivedOnly } = input;

      const now = new Date();
      const where = {
        projectId,
        ...(archivedOnly
          ? { AND: [{ archivedAt: { not: null } }, { archivedAt: { lte: now } }] }
          : includeArchived
            ? {}
            : { OR: [{ archivedAt: null }, { archivedAt: { gt: now } }] }),
        ...(statusIds?.length ? { statusId: { in: statusIds } } : {}),
        ...(priorities?.length ? { priority: { in: priorities } } : {}),
        ...(dueDateFrom || dueDateTo
          ? {
              dueDate: {
                ...(dueDateFrom ? { gte: dueDateFrom } : {}),
                ...(dueDateTo ? { lte: dueDateTo } : {}),
              },
            }
          : {}),
        ...(tagIds?.length
          ? { tags: { some: { tagId: { in: tagIds } } } }
          : {}),
        ...(assigneeIds?.length ? { assigneeId: { in: assigneeIds } } : {}),
        ...(search
          ? { title: { contains: search, mode: "insensitive" as const } }
          : {}),
      };

      const items = await ctx.prisma.task.findMany({
        where,
        include: {
          status: true,
          tags: { include: { tag: true } },
          creator: { select: { id: true, name: true, email: true, image: true } },
          assignee: { select: { id: true, name: true, email: true, image: true } },
          project: { select: { key: true } },
        },
        orderBy: { dueDate: "asc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      let nextCursor: string | null = null;
      if (items.length > limit) {
        const nextItem = items.pop();
        nextCursor = nextItem!.id;
      }

      const totalCount = await ctx.prisma.task.count({ where });

      return { items, nextCursor, totalCount };
    }),

  /** Get a single task with all relations */
  byId: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      return ctx.prisma.task.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          status: true,
          project: { select: { key: true } },
          creator: { select: { id: true, name: true, email: true, image: true } },
          assignee: { select: { id: true, name: true, email: true, image: true } },
          tags: { include: { tag: true } },
          sourceLinks: {
            include: {
              targetTask: {
                select: { id: true, taskNumber: true, title: true, project: { select: { key: true } } },
              },
            },
          },
          targetLinks: {
            include: {
              sourceTask: {
                select: { id: true, taskNumber: true, title: true, project: { select: { key: true } } },
              },
            },
          },
          comments: {
            include: { author: { select: { id: true, name: true, image: true } } },
            orderBy: { createdAt: "asc" },
          },
          customFieldValues: { include: { customField: true } },
        },
      });
    }),

  /** Create a new task */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        title: z.string().min(1).max(200),
        description: z.unknown().optional(),
        body: z.string().max(20000).nullable().optional(),
        assigneeId: z.string().cuid().nullable().optional(),
        statusId: z.string().cuid().optional(),
        priority: z.enum(["none", "low", "medium", "high", "urgent"]).default("none"),
        dueDate: z.date(),
        startDate: z.date().optional(),
        tagIds: z.array(z.string().cuid()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { tagIds, description, body, assigneeId, ...data } = input;
      const effectiveAssigneeId = assigneeId ?? ctx.session.user.id;
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, data.projectId);
      await validateAssigneeAccess(ctx, data.projectId, effectiveAssigneeId);

      if (data.statusId) {
        const status = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, data.statusId);
        if (status.projectId !== data.projectId) {
          throw new Error("Status does not belong to the specified project");
        }
      }

      if (tagIds?.length) {
        const matchingTags = await ctx.prisma.tag.findMany({
          where: {
            projectId: data.projectId,
            id: { in: tagIds },
          },
          select: { id: true },
        });
        if (matchingTags.length !== tagIds.length) {
          throw new Error("One or more tags do not belong to the specified project");
        }
      }

      // If no statusId, use project default
      if (!data.statusId) {
        const project = await ctx.prisma.project.findUniqueOrThrow({
          where: { id: data.projectId },
        });
        const settings = project.settings as Record<string, unknown>;
        const defaultStatusId = settings.defaultStatusId as string | undefined;

        if (defaultStatusId) {
          data.statusId = defaultStatusId;
        } else {
          const firstStatus = await ctx.prisma.workflowStatus.findFirst({
            where: { projectId: data.projectId },
            orderBy: { order: "asc" },
          });
          if (firstStatus) data.statusId = firstStatus.id;
        }
      }

      const task = await ctx.prisma.$transaction(async (tx) => {
        // Get the next task number for this project
        const lastTask = await tx.task.findFirst({
          where: { projectId: data.projectId },
          orderBy: { taskNumber: "desc" },
          select: { taskNumber: true },
        });
        const nextNumber = (lastTask?.taskNumber ?? 0) + 1;

        return tx.task.create({
          data: {
            ...data,
            taskNumber: nextNumber,
            creatorId: ctx.session.user.id,
            assigneeId: effectiveAssigneeId,
            description: (description ?? body ?? undefined) as Prisma.InputJsonValue | undefined,
            body,
            statusId: data.statusId!,
            ...(tagIds?.length
              ? { tags: { create: tagIds.map((tagId) => ({ tagId })) } }
              : {}),
          },
          include: {
            status: true,
            tags: { include: { tag: true } },
            creator: { select: { id: true, name: true, email: true, image: true } },
            assignee: { select: { id: true, name: true, email: true, image: true } },
            project: { select: { key: true, slug: true } },
          },
        });
      });

      // Fire-and-forget auto-tagging and search indexing
      autoTagTask(ctx.prisma, task.id).catch(() => {});
      indexTask(task).catch(() => {});

      return task;
    }),

  /** Update a task */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(200).optional(),
        description: z.unknown().optional(),
        body: z.string().nullable().optional(),
        assigneeId: z.string().cuid().nullable().optional(),
        statusId: z.string().cuid().optional(),
        priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
        dueDate: z.date().optional(),
        startDate: z.date().nullable().optional(),
        alertAcknowledged: z.boolean().optional(),
        tagIds: z.array(z.string().cuid()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, title, description, body, assigneeId, statusId, priority, dueDate, startDate, alertAcknowledged, tagIds } = input;
      const currentTask = await requireTaskAccess(ctx.prisma, ctx.session.user.id, id);
      await validateAssigneeAccess(ctx, currentTask.projectId, assigneeId);

      if (tagIds) {
        const matchingTags = await ctx.prisma.tag.findMany({
          where: {
            projectId: currentTask.projectId,
            id: { in: tagIds },
          },
          select: { id: true },
        });

        if (matchingTags.length !== tagIds.length) {
          throw new Error("One or more tags do not belong to the task project");
        }
      }

      // Validate status transition if statusId is being changed
      if (statusId) {
        const targetStatus = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, statusId);
        if (targetStatus.projectId !== currentTask.projectId) {
          throw new Error("Status does not belong to the same project as the task");
        }

        if (statusId !== currentTask.statusId) {
          const transition = await ctx.prisma.workflowTransition.findFirst({
            where: {
              projectId: currentTask.projectId,
              fromStatusId: currentTask.statusId,
              toStatusId: statusId,
            },
          });

          if (!transition) {
            throw new Error(
              `Invalid status transition: no transition defined from current status to target status`
            );
          }
        }
      }

      // Auto-archive: if moving to a status with autoArchive enabled, set archivedAt
      let archivedAt: Date | null | undefined;
      if (statusId) {
        const targetStatus = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, statusId);
        if (targetStatus?.autoArchive) {
          const delayMs = (targetStatus.autoArchiveDays || 0) * 86_400_000;
          archivedAt = new Date(Date.now() + delayMs);
        } else {
          // Un-archive if moving away from an auto-archive status
          archivedAt = null;
        }
      }

      // Build Prisma-safe update data — only include fields that were explicitly provided
      const updateData: import("@prisma/client").Prisma.TaskUpdateInput = {
        ...(title !== undefined && { title }),
        ...((description !== undefined || body !== undefined)
          ? {
              description:
                description ??
                body ??
                Prisma.JsonNull,
            }
          : {}),
        ...(body !== undefined && { body }),
        ...(assigneeId !== undefined && { assigneeId }),
        ...(statusId !== undefined && { statusId }),
        ...(priority !== undefined && { priority }),
        ...(dueDate !== undefined && { dueDate }),
        ...(startDate !== undefined && { startDate }),
        ...(alertAcknowledged !== undefined && { alertAcknowledged }),
        ...(archivedAt !== undefined && { archivedAt }),
      };

      const updated = await ctx.prisma.$transaction(async (tx) => {
        const task = await tx.task.update({
          where: { id },
          data: {
            ...updateData,
            ...(tagIds !== undefined
              ? {
                  tags: {
                    deleteMany: {},
                    ...(tagIds.length
                      ? {
                          create: tagIds.map((tagId) => ({ tagId })),
                        }
                      : {}),
                  },
                }
              : {}),
          },
          include: {
            status: true,
            tags: { include: { tag: true } },
            creator: { select: { id: true, name: true, email: true, image: true } },
            assignee: { select: { id: true, name: true, email: true, image: true } },
            project: { select: { key: true, slug: true } },
          },
        });

        return task;
      });

      // Sync to search index
      indexTask(updated).catch(() => {});

      return updated;
    }),

  /** Delete a task */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      await ctx.prisma.task.delete({ where: { id: input.id } });
      removeTaskFromIndex(input.id).catch(() => {});
      return { success: true };
    }),

  /** List all links for a project */
  links: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.taskLink.findMany({
        where: {
          sourceTask: { projectId: input.projectId },
        },
      });
    }),

  /** Add a link between tasks */
  addLink: protectedProcedure
    .input(
      z.object({
        sourceTaskId: z.string().cuid(),
        targetTaskId: z.string().cuid(),
        linkType: z.enum(["blocks", "relates", "parent", "child"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.sourceTaskId === input.targetTaskId) {
        throw new Error("A task cannot link to itself");
      }

      const sourceTask = await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.sourceTaskId);
      const targetTask = await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.targetTaskId);

      if (sourceTask.projectId !== targetTask.projectId) {
        throw new Error("Task links must stay within a single project");
      }

      await validateNoCycle(ctx, sourceTask.projectId, input.sourceTaskId, input.targetTaskId);
      return ctx.prisma.taskLink.create({ data: input });
    }),

  /** Remove a link between tasks */
  removeLink: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskLinkAccess(ctx.prisma, ctx.session.user.id, input.id);
      await ctx.prisma.taskLink.delete({ where: { id: input.id } });
      return { success: true };
    }),

  /** Add tags to a task */
  addTags: protectedProcedure
    .input(
      z.object({
        taskId: z.string().cuid(),
        tagIds: z.array(z.string().cuid()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const task = await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      const matchingTags = await ctx.prisma.tag.findMany({
        where: {
          projectId: task.projectId,
          id: { in: input.tagIds },
        },
        select: { id: true },
      });

      if (matchingTags.length !== input.tagIds.length) {
        throw new Error("One or more tags do not belong to the task project");
      }

      await ctx.prisma.taskTag.createMany({
        data: input.tagIds.map((tagId) => ({
          taskId: input.taskId,
          tagId,
        })),
        skipDuplicates: true,
      });
      return { success: true };
    }),

  /** Remove a tag from a task */
  removeTag: protectedProcedure
    .input(
      z.object({
        taskId: z.string().cuid(),
        tagId: z.string().cuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const task = await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      const tag = await requireTagAccess(ctx.prisma, ctx.session.user.id, input.tagId);
      if (task.projectId !== tag.projectId) {
        throw new Error("Tag does not belong to the same project as the task");
      }

      await ctx.prisma.taskTag.delete({
        where: {
          taskId_tagId: {
            taskId: input.taskId,
            tagId: input.tagId,
          },
        },
      });
      return { success: true };
    }),

  /** Add a comment to a task */
  addComment: protectedProcedure
    .input(
      z.object({
        taskId: z.string().cuid(),
        content: z.string().min(1).max(5000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      return ctx.prisma.comment.create({
        data: {
          taskId: input.taskId,
          authorId: ctx.session.user.id!,
          content: input.content,
        },
        include: {
          author: { select: { id: true, name: true, image: true } },
        },
      });
    }),

  /** Archive a task */
  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      return ctx.prisma.task.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });
    }),

  /** Unarchive a task */
  unarchive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      return ctx.prisma.task.update({
        where: { id: input.id },
        data: { archivedAt: null },
      });
    }),
});
