import { z } from "zod";
import { Prisma } from "@prisma/client";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { autoTagTask } from "../services/auto-tagger";
import { createTaskActivity } from "../services/task-activity";
import { createNotification, notifyTaskWatchers } from "../services/notifications";
import { createTaskComment } from "../services/comment-service";
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

const customFieldValueInputSchema = z.object({
  customFieldId: z.string().cuid(),
  value: z.union([z.string(), z.number(), z.null()]),
});

async function validateCustomFieldValues(
  ctx: { prisma: typeof import("@/lib/prisma").prisma },
  projectId: string,
  values: Array<{ customFieldId: string; value: string | number | null }> | undefined
) {
  if (!values || values.length === 0) {
    return [] as Array<{ customFieldId: string; value: Prisma.InputJsonValue }>;
  }

  const fields = await ctx.prisma.customField.findMany({
    where: {
      projectId,
      id: { in: values.map((entry) => entry.customFieldId) },
    },
    select: {
      id: true,
      type: true,
      required: true,
      options: true,
    },
  });

  if (fields.length !== values.length) {
    throw new Error("One or more custom fields do not belong to the selected project");
  }

  return values.map((entry) => {
    const field = fields.find((item) => item.id === entry.customFieldId);
    if (!field) {
      throw new Error("Custom field not found");
    }

    const rawValue = entry.value;
    const stringValue = typeof rawValue === "string" ? rawValue.trim() : rawValue;

    if (field.required && (stringValue === "" || stringValue === null)) {
      throw new Error(`Custom field \"${field.id}\" is required`);
    }

    if (stringValue === "" || stringValue === null) {
      return {
        customFieldId: entry.customFieldId,
        value: Prisma.JsonNull as unknown as Prisma.InputJsonValue,
      };
    }

    if (field.type === "number") {
      const numericValue = typeof stringValue === "number" ? stringValue : Number(stringValue);
      if (Number.isNaN(numericValue)) {
        throw new Error("Number custom fields require numeric values");
      }

      return {
        customFieldId: entry.customFieldId,
        value: numericValue as Prisma.InputJsonValue,
      };
    }

    if (field.type === "date") {
      const parsedDate = new Date(String(stringValue));
      if (Number.isNaN(parsedDate.getTime())) {
        throw new Error("Date custom fields require valid date values");
      }

      return {
        customFieldId: entry.customFieldId,
        value: parsedDate.toISOString() as Prisma.InputJsonValue,
      };
    }

    if (field.type === "select") {
      const choices = Array.isArray((field.options as { choices?: string[] } | null)?.choices)
        ? (((field.options as { choices?: string[] } | null)?.choices) ?? [])
        : [];

      if (!choices.includes(String(stringValue))) {
        throw new Error("Select custom fields require one of the configured choices");
      }
    }

    return {
      customFieldId: entry.customFieldId,
      value: String(stringValue) as Prisma.InputJsonValue,
    };
  });
}

function hasCommentAttachmentDelegate(prisma: typeof import("@/lib/prisma").prisma) {
  return "commentAttachment" in prisma;
}

function isTerminalStatusCategory(category: string | null | undefined) {
  return category === "done" || category === "cancelled";
}

function getDependencyState(task: {
  sourceLinks?: Array<{ linkType: string; targetTask?: { status?: { category?: string | null } | null } | null }>;
  targetLinks?: Array<{ linkType: string; sourceTask?: { status?: { category?: string | null } | null } | null }>;
}) {
  const blockingTaskCount = (task.targetLinks ?? []).filter(
    (link) => link.linkType === "blocks" && !isTerminalStatusCategory(link.sourceTask?.status?.category)
  ).length;

  const openChildCount = [
    ...(task.sourceLinks ?? []).filter(
      (link) => link.linkType === "parent" && !isTerminalStatusCategory(link.targetTask?.status?.category)
    ),
    ...(task.targetLinks ?? []).filter(
      (link) => link.linkType === "child" && !isTerminalStatusCategory(link.sourceTask?.status?.category)
    ),
  ].length;

  return {
    blockingTaskCount,
    openChildCount,
  };
}

function assertCanEnterTerminalStatus(dependencyState: {
  blockingTaskCount: number;
  openChildCount: number;
}) {
  if (dependencyState.blockingTaskCount > 0) {
    throw new Error("Cannot move task to a terminal status while blocking tasks are still open");
  }

  if (dependencyState.openChildCount > 0) {
    throw new Error("Cannot move task to a terminal status while child tasks are still open");
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
          watchers: { select: { userId: true } },
          sourceLinks: {
            select: {
              linkType: true,
              targetTask: {
                select: {
                  status: { select: { category: true } },
                },
              },
            },
          },
          targetLinks: {
            select: {
              linkType: true,
              sourceTask: {
                select: {
                  status: { select: { category: true } },
                },
              },
            },
          },
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

      const enrichedItems = items.map((task) => ({
        ...task,
        dependencyState: getDependencyState(task),
      }));

      return { items: enrichedItems, nextCursor, totalCount };
    }),

  /** Get a single task with all relations */
  byId: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      const includeCommentAttachments = hasCommentAttachmentDelegate(ctx.prisma);
      const task = await ctx.prisma.task.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          status: true,
          project: { select: { key: true } },
          creator: { select: { id: true, name: true, email: true, image: true } },
          assignee: { select: { id: true, name: true, email: true, image: true } },
          watchers: { select: { userId: true } },
          tags: { include: { tag: true } },
          sourceLinks: {
            include: {
              targetTask: {
                select: { id: true, taskNumber: true, title: true, status: { select: { category: true, name: true } }, project: { select: { key: true } } },
              },
            },
          },
          targetLinks: {
            include: {
              sourceTask: {
                select: { id: true, taskNumber: true, title: true, status: { select: { category: true, name: true } }, project: { select: { key: true } } },
              },
            },
          },
          comments: {
            include: {
              author: { select: { id: true, name: true, image: true } },
              ...(includeCommentAttachments
                ? {
                    attachments: {
                      select: {
                        id: true,
                        originalName: true,
                        mimeType: true,
                        sizeBytes: true,
                        createdAt: true,
                      },
                      orderBy: { createdAt: "asc" },
                    },
                  }
                : {}),
            },
            orderBy: { createdAt: "asc" },
          },
          activityEvents: {
            include: {
              actor: { select: { id: true, name: true, email: true, image: true } },
            },
            orderBy: { createdAt: "desc" },
          },
          customFieldValues: { include: { customField: true } },
        },
      });

      return {
        ...task,
        dependencyState: getDependencyState(task),
      };
    }),

  isWatching: protectedProcedure
    .input(z.object({ taskId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      const watcher = await ctx.prisma.taskWatcher.findUnique({
        where: {
          taskId_userId: {
            taskId: input.taskId,
            userId: ctx.session.user.id,
          },
        },
        select: { taskId: true },
      });

      return Boolean(watcher);
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
        customFieldValues: z.array(customFieldValueInputSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { tagIds, description, body, assigneeId, customFieldValues, ...data } = input;
      const effectiveAssigneeId = assigneeId ?? ctx.session.user.id;
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, data.projectId);
      await validateAssigneeAccess(ctx, data.projectId, effectiveAssigneeId);
      const normalizedCustomFieldValues = await validateCustomFieldValues(ctx, data.projectId, customFieldValues);

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
            ...(normalizedCustomFieldValues.length
              ? {
                  customFieldValues: {
                    create: normalizedCustomFieldValues.map((entry) => ({
                      customFieldId: entry.customFieldId,
                      value: entry.value,
                    })),
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
      });

      // Fire-and-forget auto-tagging
      autoTagTask(ctx.prisma, task.id).catch(() => {});
      createTaskActivity({
        taskId: task.id,
        actorId: ctx.session.user.id,
        action: "created",
        details: {
          title: task.title,
          statusId: task.statusId,
          assigneeId: task.assigneeId,
        },
      }).catch(() => {});
      ctx.prisma.taskWatcher.create({
        data: {
          taskId: task.id,
          userId: ctx.session.user.id,
        },
      }).catch(() => {});

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
        customFieldValues: z.array(customFieldValueInputSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, title, description, body, assigneeId, statusId, priority, dueDate, startDate, alertAcknowledged, tagIds, customFieldValues } = input;
      const currentTask = await requireTaskAccess(ctx.prisma, ctx.session.user.id, id);
      const currentTaskSnapshot = await ctx.prisma.task.findUniqueOrThrow({
        where: { id },
        select: { assigneeId: true },
      });
      await validateAssigneeAccess(ctx, currentTask.projectId, assigneeId);
      const normalizedCustomFieldValues = await validateCustomFieldValues(ctx, currentTask.projectId, customFieldValues);

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

        if (isTerminalStatusCategory(targetStatus.category)) {
          const dependencyTask = await ctx.prisma.task.findUniqueOrThrow({
            where: { id },
            include: {
              sourceLinks: {
                select: {
                  linkType: true,
                  targetTask: {
                    select: { status: { select: { category: true } } },
                  },
                },
              },
              targetLinks: {
                select: {
                  linkType: true,
                  sourceTask: {
                    select: { status: { select: { category: true } } },
                  },
                },
              },
            },
          });

          assertCanEnterTerminalStatus(getDependencyState(dependencyTask));
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
            ...(customFieldValues !== undefined
              ? {
                  customFieldValues: {
                    deleteMany: {},
                    ...(normalizedCustomFieldValues.length
                      ? {
                          create: normalizedCustomFieldValues.map((entry) => ({
                            customFieldId: entry.customFieldId,
                            value: entry.value,
                          })),
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
      createTaskActivity({
        taskId: updated.id,
        actorId: ctx.session.user.id,
        action: "updated",
        details: {
          changedFields: [
            ...(title !== undefined ? ["title"] : []),
            ...(description !== undefined || body !== undefined ? ["description"] : []),
            ...(assigneeId !== undefined ? ["assigneeId"] : []),
            ...(statusId !== undefined ? ["statusId"] : []),
            ...(priority !== undefined ? ["priority"] : []),
            ...(dueDate !== undefined ? ["dueDate"] : []),
            ...(startDate !== undefined ? ["startDate"] : []),
            ...(alertAcknowledged !== undefined ? ["alertAcknowledged"] : []),
            ...(tagIds !== undefined ? ["tags"] : []),
          ],
        },
      }).catch(() => {});

      if (statusId !== undefined && statusId !== currentTask.statusId) {
        notifyTaskWatchers({
          taskId: updated.id,
          actorId: ctx.session.user.id,
          type: "statusChanged",
          payload: {
            fromStatusId: currentTask.statusId,
            toStatusId: statusId,
          },
        }).catch(() => {});
      }

      if (assigneeId !== undefined && assigneeId && assigneeId !== currentTaskSnapshot.assigneeId) {
        createNotification({
          recipientId: assigneeId,
          actorId: ctx.session.user.id,
          taskId: updated.id,
          type: "assigned",
          payload: {
            taskTitle: updated.title,
          },
        }).catch(() => {});
      }

      return updated;
    }),

  /** Bulk update multiple tasks */
  bulkUpdate: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        taskIds: z.array(z.string().cuid()).min(1).max(100),
        statusId: z.string().cuid().optional(),
        assigneeId: z.string().cuid().nullable().optional(),
        addTagIds: z.array(z.string().cuid()).optional(),
        removeTagIds: z.array(z.string().cuid()).optional(),
        archive: z.boolean().optional(),
      }).refine(
        (value) =>
          value.statusId !== undefined ||
          value.assigneeId !== undefined ||
          (value.addTagIds?.length ?? 0) > 0 ||
          (value.removeTagIds?.length ?? 0) > 0 ||
          value.archive !== undefined,
        { message: "At least one bulk change is required" }
      )
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

      const tasks = await ctx.prisma.task.findMany({
        where: {
          id: { in: input.taskIds },
          projectId: input.projectId,
        },
        select: {
          id: true,
          projectId: true,
          statusId: true,
          sourceLinks: {
            select: {
              linkType: true,
              targetTask: {
                select: {
                  status: { select: { category: true } },
                },
              },
            },
          },
          targetLinks: {
            select: {
              linkType: true,
              sourceTask: {
                select: {
                  status: { select: { category: true } },
                },
              },
            },
          },
        },
      });

      if (tasks.length !== input.taskIds.length) {
        throw new Error("One or more selected tasks are missing or outside the project");
      }

      if (input.assigneeId !== undefined) {
        await validateAssigneeAccess(ctx, input.projectId, input.assigneeId);
      }

      let archivedAt: Date | null | undefined;
      if (input.archive !== undefined) {
        archivedAt = input.archive ? new Date() : null;
      }

      if (input.statusId) {
        const targetStatus = await requireWorkflowStatusAccess(ctx.prisma, ctx.session.user.id, input.statusId);
        if (targetStatus.projectId !== input.projectId) {
          throw new Error("Status does not belong to the selected project");
        }

        if (isTerminalStatusCategory(targetStatus.category)) {
          for (const task of tasks) {
            if (task.statusId === input.statusId) {
              continue;
            }

            assertCanEnterTerminalStatus(getDependencyState(task));
          }
        }

        for (const task of tasks) {
          if (task.statusId === input.statusId) {
            continue;
          }

          const transition = await ctx.prisma.workflowTransition.findFirst({
            where: {
              projectId: input.projectId,
              fromStatusId: task.statusId,
              toStatusId: input.statusId,
            },
          });

          if (!transition) {
            throw new Error("One or more selected tasks cannot transition to the chosen status");
          }
        }

        if (archivedAt === undefined) {
          if (targetStatus.autoArchive) {
            const delayMs = (targetStatus.autoArchiveDays || 0) * 86_400_000;
            archivedAt = new Date(Date.now() + delayMs);
          } else {
            archivedAt = null;
          }
        }
      }

      const requestedTagIds = [...new Set([...(input.addTagIds ?? []), ...(input.removeTagIds ?? [])])];
      if (requestedTagIds.length > 0) {
        const tags = await ctx.prisma.tag.findMany({
          where: {
            projectId: input.projectId,
            id: { in: requestedTagIds },
          },
          select: { id: true },
        });

        if (tags.length !== requestedTagIds.length) {
          throw new Error("One or more selected tags do not belong to the project");
        }
      }

      await ctx.prisma.$transaction(async (tx) => {
        if (input.statusId !== undefined || input.assigneeId !== undefined || archivedAt !== undefined) {
          await Promise.all(
            tasks.map((task) =>
              tx.task.update({
                where: { id: task.id },
                data: {
                  ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
                  ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
                  ...(archivedAt !== undefined ? { archivedAt } : {}),
                },
              })
            )
          );
        }

        if (input.addTagIds?.length) {
          await tx.taskTag.createMany({
            data: input.taskIds.flatMap((taskId) =>
              input.addTagIds!.map((tagId) => ({ taskId, tagId }))
            ),
            skipDuplicates: true,
          });
        }

        if (input.removeTagIds?.length) {
          await tx.taskTag.deleteMany({
            where: {
              taskId: { in: input.taskIds },
              tagId: { in: input.removeTagIds },
            },
          });
        }
      });

      const updatedTasks = await ctx.prisma.task.findMany({
        where: { id: { in: input.taskIds } },
        include: {
          status: true,
          tags: { include: { tag: true } },
          creator: { select: { id: true, name: true, email: true, image: true } },
          assignee: { select: { id: true, name: true, email: true, image: true } },
          project: { select: { key: true, slug: true } },
        },
      });

      updatedTasks.forEach((task) => {
        createTaskActivity({
          taskId: task.id,
          actorId: ctx.session.user.id,
          action: "bulkUpdated",
          details: {
            statusId: input.statusId,
            assigneeId: input.assigneeId,
            addTagIds: input.addTagIds ?? [],
            removeTagIds: input.removeTagIds ?? [],
            archive: input.archive,
          },
        }).catch(() => {});
      });

      return {
        success: true,
        updatedCount: updatedTasks.length,
      };
    }),

  /** Delete a task */
  duplicate: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(200).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);

      const task = await ctx.prisma.$transaction(async (tx) => {
        const currentTask = await tx.task.findUniqueOrThrow({
          where: { id: input.id },
          include: {
            tags: { select: { tagId: true } },
          },
        });

        const lastTask = await tx.task.findFirst({
          where: { projectId: currentTask.projectId },
          orderBy: { taskNumber: "desc" },
          select: { taskNumber: true },
        });

        const duplicatedTask = await tx.task.create({
          data: {
            projectId: currentTask.projectId,
            taskNumber: (lastTask?.taskNumber ?? 0) + 1,
            title: input.title ?? `Copy of ${currentTask.title}`,
            description: currentTask.description ?? Prisma.JsonNull,
            body: currentTask.body,
            statusId: currentTask.statusId,
            priority: currentTask.priority,
            dueDate: currentTask.dueDate,
            startDate: currentTask.startDate,
            creatorId: ctx.session.user.id,
            assigneeId: currentTask.assigneeId,
            tags: currentTask.tags.length
              ? {
                  create: currentTask.tags.map(({ tagId }) => ({ tagId })),
                }
              : undefined,
          },
          include: {
            status: true,
            tags: { include: { tag: true } },
            creator: { select: { id: true, name: true, email: true, image: true } },
            assignee: { select: { id: true, name: true, email: true, image: true } },
            project: { select: { key: true, slug: true } },
          },
        });

        return duplicatedTask;
      });
      createTaskActivity({
        taskId: task.id,
        actorId: ctx.session.user.id,
        action: "duplicated",
        details: { sourceTaskId: input.id },
      }).catch(() => {});

      return task;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      await ctx.prisma.task.delete({ where: { id: input.id } });
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
      return createTaskComment(ctx.prisma, {
        taskId: input.taskId,
        authorId: ctx.session.user.id,
        content: input.content,
      });
    }),

  watch: protectedProcedure
    .input(z.object({ taskId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      await ctx.prisma.taskWatcher.upsert({
        where: {
          taskId_userId: {
            taskId: input.taskId,
            userId: ctx.session.user.id,
          },
        },
        update: {},
        create: {
          taskId: input.taskId,
          userId: ctx.session.user.id,
        },
      });
      return { success: true };
    }),

  unwatch: protectedProcedure
    .input(z.object({ taskId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId);
      await ctx.prisma.taskWatcher.deleteMany({
        where: {
          taskId: input.taskId,
          userId: ctx.session.user.id,
        },
      });
      return { success: true };
    }),

  /** Archive a task */
  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      const task = await ctx.prisma.task.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });

      createTaskActivity({
        taskId: task.id,
        actorId: ctx.session.user.id,
        action: "archived",
      }).catch(() => {});

      return task;
    }),

  /** Unarchive a task */
  unarchive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.id);
      const task = await ctx.prisma.task.update({
        where: { id: input.id },
        data: { archivedAt: null },
      });

      createTaskActivity({
        taskId: task.id,
        actorId: ctx.session.user.id,
        action: "unarchived",
      }).catch(() => {});

      return task;
    }),
});
