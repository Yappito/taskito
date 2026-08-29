import type { Prisma, PrismaClient } from "@prisma/client";

type SprintDbClient = PrismaClient | Prisma.TransactionClient;

/** Finished statuses: anything else counts as remaining work. */
export const FINISHED_CATEGORIES = ["done", "cancelled"] as const;

/**
 * Truncate a date to its UTC day, so snapshots line up no matter which
 * replica/timezone recorded them (the scheduler and routers always pass UTC
 * midnights into SprintSnapshot.date).
 */
export function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** ISO day key ("2026-05-19") used by the burndown series. */
export function utcDayKey(date: Date): string {
  return utcDay(date).toISOString().slice(0, 10);
}

function sprintTaskCounts(categories: Array<{ category: string }>) {
  let remaining = 0;
  let completed = 0;
  for (const item of categories) {
    if ((FINISHED_CATEGORIES as readonly string[]).includes(item.category)) {
      completed += 1;
    } else {
      remaining += 1;
    }
  }
  return { remaining, completed };
}

/**
 * Upsert the daily snapshot row for one sprint. Idempotent: re-running it for
 * the same sprint/day rewrites the same (sprintId, date) row instead of
 * creating duplicates.
 */
export async function upsertSprintSnapshot(
  client: SprintDbClient,
  input: { sprintId: string; date: Date; remainingCount: number; completedCount: number }
) {
  const date = utcDay(input.date);
  return client.sprintSnapshot.upsert({
    where: { sprintId_date: { sprintId: input.sprintId, date } },
    create: {
      sprintId: input.sprintId,
      date,
      remainingCount: input.remainingCount,
      completedCount: input.completedCount,
    },
    update: {
      remainingCount: input.remainingCount,
      completedCount: input.completedCount,
    },
  });
}

/**
 * Write a snapshot for one sprint based on its current task statuses.
 * `tasks` should be the sprint's tasks with their status category included.
 */
export async function writeSprintSnapshotFromTasks(
  client: SprintDbClient,
  input: { sprintId: string; now?: Date; tasks: Array<{ category: string }> }
) {
  const { remaining, completed } = sprintTaskCounts(input.tasks);
  return upsertSprintSnapshot(client, {
    sprintId: input.sprintId,
    date: input.now ?? new Date(),
    remainingCount: remaining,
    completedCount: completed,
  });
}

/**
 * Record a snapshot row for every active sprint in the app for `now`'s UTC
 * day. Called by the scheduler's sprintSnapshotJob (and reused by the sprint
 * router when a sprint starts or completes). Idempotent via upsert.
 */
export async function recordSprintSnapshots(client: SprintDbClient, now: Date = new Date()) {
  const activeSprints = await client.sprint.findMany({
    where: { status: "active" },
    select: { id: true },
  });

  let recorded = 0;
  for (const sprint of activeSprints) {
    const taskStatuses = await client.task.findMany({
      where: { sprintId: sprint.id },
      select: { status: { select: { category: true } } },
    });
    const { remaining, completed } = sprintTaskCounts(taskStatuses.map((task) => task.status));
    await upsertSprintSnapshot(client, {
      sprintId: sprint.id,
      date: now,
      remainingCount: remaining,
      completedCount: completed,
    });
    recorded += 1;
  }

  return recorded;
}