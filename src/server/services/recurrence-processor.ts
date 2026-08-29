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

/**
 * UTC "YYYY-MM-DD" day key — the SAME day granularity the recurrence router
 * (src/server/routers/recurrence.ts `dateKey`) uses to validate that
 * nextDueDate is on/before endDate. End-date comparisons must be made on
 * this granularity, never on exact timestamps (CITADEL-ae2 finding 4).
 */
function dayKey(date: Date) {
  return date.toISOString().split("T")[0];
}

export async function processDueRecurrences(prisma: PrismaClient, options: { projectId?: string; now?: Date; limit?: number; signal?: AbortSignal } = {}) {
  const now = options.now ?? new Date();
  // CITADEL-ae2 (finding 4): selection gates on a DUE occurrence existing
  // (nextDueDate <= now), NOT on endDate >= now. The old `endDate >= now`
  // gate permanently excluded a rule whose final valid occurrence fell due
  // on/before the endDate but could only be processed AFTER the endDate
  // (scheduler downtime spanning the end date) — that occurrence was never
  // created. Validity is instead decided per rule in the loop below, on the
  // router's dateKey day granularity: an occurrence whose DAY is on/before
  // the endDate's day is valid and gets created (then retired by its own
  // claim advance); only a rule whose current occurrence is already past the
  // end day hits the standalone retirement branch. Rules already past their
  // end day are still selected here and retire themselves through that
  // branch one interval per tick until nextDueDate moves past `now` (a plain
  // CAS advance, no task created), so they drain out of the due pool instead
  // of accumulating unseen as under the old gate.
  const rules = await prisma.recurrenceRule.findMany({
    where: {
      nextDueDate: { lte: now },
      ...(options.projectId ? { task: { projectId: options.projectId } } : {}),
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

      // CITADEL-e10 (finding 9) / CITADEL-ae2 (finding 4): distinguish two
      // end-date situations, compared on the router's dateKey DAY
      // granularity (an endDate stored as midnight must not exclude a
      // same-day occurrence later in that day — the router explicitly
      // accepts nextDueDate on the endDate's calendar day).
      //
      //  - The CURRENT occurrence (rule.nextDueDate) is already past the
      //    end DAY: nothing to create — retire the rule with a standalone
      //    advance (a plain CAS with no task creation, so there is no
      //    claim/create gap to protect). Reachable for rules selected after
      //    their end day has passed (e.g. scheduler downtime spanning the
      //    endDate, or pre-existing data drift). A crash here simply re-runs
      //    the retirement on the next tick.
      //
      //  - The current occurrence is still on/before the end day —
      //    including the downtime case where `now` itself is already past
      //    the endDate — so it is VALID and MUST get its task created. The
      //    flow falls through to the ordinary claim+create transaction
      //    below; when the FOLLOWING occurrence would land beyond the end
      //    day, the claimed advance moves nextDueDate past it and the rule
      //    is retired by that very claim — inside the same transaction as
      //    the task creation, so a crash rolls both back together. (The
      //    old exact-timestamp comparison `nextDueDate > endDate` retired
      //    rules in this situation WITHOUT creating the final occurrence.)
      if (rule.endDate && dayKey(rule.nextDueDate) > dayKey(rule.endDate)) {
        await prisma.recurrenceRule.updateMany({
          where: { id: rule.id, nextDueDate: rule.nextDueDate },
          data: { nextDueDate },
        });
        continue;
      }

      // Occurrence claim AND task creation now run in ONE database
      // transaction (finding 5): the compare-and-swap on the durable
      // nextDueDate column is the unique occurrence key, and it commits
      // atomically with the created task. The previous two-transaction shape
      // (advance first, then create) permanently consumed the occurrence when
      // the process crashed between the CAS and the task creation — the
      // advance was already committed and the compensating rollback below
      // never ran. Now a crash (or any failure) between claim and create
      // rolls the advance back with the task: nothing is consumed, and the
      // next tick recreates the occurrence. The CAS still guarantees only one
      // concurrent caller wins the occurrence.
      const created = await createTaskWithNextNumber(prisma, source.projectId, async (tx, taskNumber) => {
        const claim = await tx.recurrenceRule.updateMany({
          where: { id: rule.id, nextDueDate: rule.nextDueDate },
          data: { nextDueDate },
        });
        if (!claim || claim.count !== 1) {
          // Lost the race: another caller already claimed this occurrence.
          // Returning null aborts this attempt before any task row is written.
          return null;
        }
        return tx.task.create({
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
        });
      });
      if (created) {
        createdTaskIds.push(created.id);
        createTaskActivity({
          taskId: created.id,
          actorId: source.creatorId,
          action: "created",
          details: { recurringFromTaskId: source.id, recurrenceRuleId: rule.id },
        }).catch(() => {});
      }
    } catch {
      // The claim and the task creation share one transaction: any failure —
      // including a task-number conflict after createTaskWithNextNumber's
      // retries are exhausted — rolls the claimed advance back together with
      // the (partial) task, so the occurrence stays due and is retried on the
      // next tick. No compensation write is needed and no occurrence is lost.
      // Continue processing other recurrence rules; a single bad rule should
      // not block the batch.
    }
  }

  return { processed: rules.length, createdTaskIds };
}