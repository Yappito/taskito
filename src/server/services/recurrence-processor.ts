import { Prisma } from "@prisma/client";

import { createTaskWithNextNumber } from "@/server/routers/task";
import { createTaskActivity } from "@/server/services/task-activity";

type PrismaClient = typeof import("@/lib/prisma").prisma;

function addInterval(date: Date, frequency: "daily" | "weekly" | "monthly" | "yearly", interval: number) {
  const next = new Date(date);
  if (frequency === "daily") next.setDate(next.getDate() + interval);
  if (frequency === "weekly") next.setDate(next.getDate() + interval * 7);
  if (frequency === "monthly") next.setMonth(next.getMonth() + interval);
  if (frequency === "yearly") next.setFullYear(next.getFullYear() + interval);
  return next;
}

export async function processDueRecurrences(prisma: PrismaClient, options: { projectId?: string; now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const rules = await prisma.recurrenceRule.findMany({
    where: {
      nextDueDate: { lte: now },
      ...(options.projectId ? { task: { projectId: options.projectId } } : {}),
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    include: {
      task: {
        include: {
          tags: { select: { tagId: true } },
          customFieldValues: { select: { customFieldId: true, value: true } },
        },
      },
    },
    orderBy: { nextDueDate: "asc" },
    take: options.limit ?? 50,
  });

  const createdTaskIds: string[] = [];
  for (const rule of rules) {
    try {
      const source = rule.task;
      const nextDueDate = addInterval(rule.nextDueDate, rule.frequency, Math.max(1, rule.interval));
      if (rule.endDate && nextDueDate > rule.endDate) {
        await prisma.recurrenceRule.update({ where: { id: rule.id }, data: { nextDueDate } });
        continue;
      }

      const created = await createTaskWithNextNumber(prisma, source.projectId, (tx, taskNumber) => tx.task.create({
        data: {
          projectId: source.projectId,
          taskNumber,
          creatorId: source.creatorId,
          assigneeId: source.assigneeId,
          title: source.title,
          description: source.description ?? Prisma.JsonNull,
          body: source.body,
          statusId: source.statusId,
          priority: source.priority,
          dueDate: rule.nextDueDate,
          startDate: source.startDate,
          sprintId: source.sprintId,
          tags: source.tags.length ? { create: source.tags.map(({ tagId }) => ({ tagId })) } : undefined,
          customFieldValues: source.customFieldValues.length
            ? {
                create: source.customFieldValues.map((entry) => ({
                  customFieldId: entry.customFieldId,
                  value: entry.value as Prisma.InputJsonValue,
                })),
              }
            : undefined,
        },
      }));
      createdTaskIds.push(created.id);
      await prisma.recurrenceRule.update({ where: { id: rule.id }, data: { nextDueDate } });
      createTaskActivity({
        taskId: created.id,
        actorId: source.creatorId,
        action: "created",
        details: { recurringFromTaskId: source.id, recurrenceRuleId: rule.id },
      }).catch(() => {});
    } catch {
      // Continue processing other recurrence rules; a single bad rule should not block the batch.
    }
  }

  return { processed: rules.length, createdTaskIds };
}
