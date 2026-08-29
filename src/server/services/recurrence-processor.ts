import { Prisma } from "@prisma/client";

import { createTaskWithNextNumber } from "@/server/routers/task";
import { createTaskActivity } from "@/server/services/task-activity";
import { assertTickAlive } from "@/server/services/scheduler-deadline";

type PrismaClient = typeof import("@/lib/prisma").prisma;
type Frequency = "daily" | "weekly" | "monthly" | "yearly";

/**
 * Advances `date` by `frequency` × `interval`.
 *
 * `dayOfWeek` / `dayOfMonth` refine `weekly` / `monthly` rules respectively:
 *  - weekly + dayOfWeek (0=Sunday..6=Saturday): lands on the next occurrence of
 *    that weekday on/after the stepped date, so off-weekday due dates re-align
 *    instead of drifting.
 *  - monthly + dayOfMonth: explicit day-of-month clamped to the target month's
 *    length (Jan 31 → Feb 28, not an overflow into March).
 * When both are null the historical behaviour is preserved unchanged.
 */
function addInterval(
  date: Date,
  frequency: Frequency,
  interval: number,
  dayOfWeek: number | null = null,
  dayOfMonth: number | null = null,
) {
  const next = new Date(date);
  if (frequency === "daily") next.setDate(next.getDate() + interval);
  if (frequency === "weekly") next.setDate(next.getDate() + interval * 7);
  if (frequency === "monthly") {
    if (dayOfMonth != null) {
      const totalMonths = date.getFullYear() * 12 + date.getMonth() + interval;
      const year = Math.floor(totalMonths / 12);
      const month = totalMonths % 12;
      const daysInTargetMonth = new Date(year, month + 1, 0).getDate();
      const clamped = new Date(year, month, Math.min(dayOfMonth, daysInTargetMonth));
      clamped.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
      return clamped;
    }
    next.setMonth(next.getMonth() + interval);
    return next;
  }
  if (frequency === "yearly") next.setFullYear(next.getFullYear() + interval);

  if (frequency === "weekly" && dayOfWeek != null) {
    const daysUntilTarget = (dayOfWeek - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + daysUntilTarget);
  }
  return next;
}

export async function processDueRecurrences(prisma: PrismaClient, options: { projectId?: string; now?: Date; limit?: number; signal?: AbortSignal } = {}) {
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
  if (!Array.isArray(rules)) {
    return { processed: 0, createdTaskIds: [] as string[] };
  }

  const createdTaskIds: string[] = [];
  for (const rule of rules) {
    // Stop promptly at the tick deadline (checked between units of work).
    assertTickAlive(options.signal);
    try {
      const source = rule.task;
      const nextDueDate = addInterval(
        rule.nextDueDate,
        rule.frequency,
        Math.max(1, rule.interval),
        rule.dayOfWeek ?? null,
        rule.dayOfMonth ?? null,
      );

      // M8: claim this occurrence with a compare-and-swap on nextDueDate
      // BEFORE creating the task. nextDueDate doubles as the occurrence's
      // version: the atomic updateMany only succeeds for one concurrent
      // caller (`count === 1`), so the loser never creates a duplicate task.
      const claim = await prisma.recurrenceRule.updateMany({
        where: { id: rule.id, nextDueDate: rule.nextDueDate },
        data: { nextDueDate },
      });
      if (!claim || claim.count !== 1) {
        continue;
      }

      if (rule.endDate && nextDueDate > rule.endDate) {
        // The next occurrence would be past the end date: the advance
        // (already committed by the CAS above) retires this occurrence.
        continue;
      }

      try {
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
        createTaskActivity({
          taskId: created.id,
          actorId: source.creatorId,
          action: "created",
          details: { recurringFromTaskId: source.id, recurrenceRuleId: rule.id },
        }).catch(() => {});
      } catch (createError) {
        // The claim succeeded but the task creation failed — roll the advance
        // back so the occurrence is retried on the next tick instead of being
        // silently skipped.
        await prisma.recurrenceRule.updateMany({
          where: { id: rule.id, nextDueDate },
          data: { nextDueDate: rule.nextDueDate },
        }).catch(() => {});
        throw createError;
      }
    } catch {
      // Continue processing other recurrence rules; a single bad rule should not block the batch.
    }
  }

  return { processed: rules.length, createdTaskIds };
}