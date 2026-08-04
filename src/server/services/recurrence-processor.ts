import { Prisma, type RecurrenceRule } from "@prisma/client";

import { createTaskActivity } from "@/server/services/task-activity";

type PrismaClient = typeof import("@/lib/prisma").prisma;

const ruleInclude = {
  task: {
    include: {
      tags: { select: { tagId: true } },
      customFieldValues: { select: { customFieldId: true, value: true } },
    },
  },
} as const;

type RecurrenceRuleWithTask = Prisma.RecurrenceRuleGetPayload<{ include: typeof ruleInclude }>;

function addInterval(date: Date, frequency: "daily" | "weekly" | "monthly" | "yearly", interval: number) {
  const next = new Date(date);
  if (frequency === "daily") next.setDate(next.getDate() + interval);
  if (frequency === "weekly") next.setDate(next.getDate() + interval * 7);
  if (frequency === "monthly") next.setMonth(next.getMonth() + interval);
  if (frequency === "yearly") next.setFullYear(next.getFullYear() + interval);
  return next;
}

function computeNextDueDate(rule: Pick<RecurrenceRule, "frequency" | "interval" | "dayOfWeek" | "dayOfMonth" | "nextDueDate">) {
  const interval = Math.max(1, rule.interval);
  const next = addInterval(rule.nextDueDate, rule.frequency, interval);

  if (rule.frequency === "weekly" && rule.dayOfWeek != null) {
    const daysToAdd = (rule.dayOfWeek - next.getDay() + 7) % 7;
    if (daysToAdd > 0) next.setDate(next.getDate() + daysToAdd);
  } else if (rule.frequency === "monthly" && rule.dayOfMonth != null) {
    const lastDayOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(rule.dayOfMonth, lastDayOfMonth));
  }

  // Guarantee progress: a clamped result must never leave the rule due on the
  // same date (which would re-trigger it on every cron tick).
  if (next.getTime() <= rule.nextDueDate.getTime()) {
    return addInterval(next, rule.frequency, interval);
  }
  return next;
}

function isTaskNumberConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002"
    && Array.isArray(error.meta?.target)
    && error.meta.target.includes("projectId")
    && error.meta.target.includes("taskNumber");
}

async function processRule(prisma: PrismaClient, rule: RecurrenceRuleWithTask) {
  const source = rule.task;
  const nextDueDate = computeNextDueDate(rule);

  // Past the end date: advance so the rule stops being due; nothing to create.
  if (rule.endDate && nextDueDate > rule.endDate) {
    await prisma.recurrenceRule.update({ where: { id: rule.id }, data: { nextDueDate } });
    return undefined;
  }

  // Task creation and the nextDueDate advance must commit together. Prisma's
  // interactive transaction client has no $transaction method, so the task
  // number is allocated inline and the whole per-rule transaction is retried
  // on a (projectId, taskNumber) unique conflict — mirroring
  // createTaskWithNextNumber's retry semantics.
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const lastTask = await tx.task.findFirst({
          where: { projectId: source.projectId },
          orderBy: { taskNumber: "desc" },
          select: { taskNumber: true },
        });
        const task = await tx.task.create({
          data: {
            projectId: source.projectId,
            taskNumber: (lastTask?.taskNumber ?? 0) + 1,
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
        });
        await tx.recurrenceRule.update({ where: { id: rule.id }, data: { nextDueDate } });
        return task;
      });
      createTaskActivity({
        taskId: created.id,
        actorId: source.creatorId,
        action: "created",
        details: { recurringFromTaskId: source.id, recurrenceRuleId: rule.id },
      }).catch(() => {});
      return created;
    } catch (error) {
      if (!isTaskNumberConflict(error) || attempt === maxAttempts) {
        throw error;
      }
    }
  }

  throw new Error("Unable to allocate a task number");
}

export async function processDueRecurrences(prisma: PrismaClient, options: { projectId?: string; now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const rules = await prisma.recurrenceRule.findMany({
    where: {
      nextDueDate: { lte: now },
      ...(options.projectId ? { task: { projectId: options.projectId } } : {}),
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    include: ruleInclude,
    orderBy: { nextDueDate: "asc" },
    take: options.limit ?? 50,
  });

  const createdTaskIds: string[] = [];
  const failedRuleIds: string[] = [];
  for (const rule of rules) {
    try {
      const created = await processRule(prisma, rule);
      if (created) createdTaskIds.push(created.id);
    } catch (error) {
      failedRuleIds.push(rule.id);
      console.error("Recurrence rule processing failed", { ruleId: rule.id, error });
    }
  }

  return { processed: rules.length, createdTaskIds, failedRuleIds };
}
