import type { Prisma } from "@prisma/client";

import { prisma as prismaClient } from "@/lib/prisma";
import { getAlertConfig } from "@/lib/alert-utils";
import { getAccessibleProjectIds } from "@/server/authz";
import { readEmailChannelPreference } from "@/server/services/notifications";
import { isEmailConfigured, logEmailError, sendEmail } from "@/server/services/email/smtp-client";
import { DIGEST_MAX_TASKS_PER_SECTION, renderDigestEmail, type DigestTask } from "@/server/services/email/templates";

type PrismaLike = typeof prismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DueSoonDigest {
  userId: string;
  email: string;
  name: string | null;
  overdue: DigestTask[];
  dueToday: DigestTask[];
  dueSoon: DigestTask[];
  blockedOn: DigestTask[];
  /** Number of collected tasks omitted from each capped section. */
  overdueMore: number;
  dueTodayMore: number;
  dueSoonMore: number;
  blockedOnMore: number;
}

export interface DigestJobResult {
  sent: number;
  skipped: number;
}

interface DigestTaskRow {
  id: string;
  title: string;
  taskNumber: number;
  dueDate: Date;
  projectId: string;
  project: { name: string; slug: string; key: string };
}

function startOfUtcDay(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS) * DAY_MS;
}

/**
 * True when the user's settings.emailChannel.lastDigestSentAt (ISO string,
 * written after a successful digest send) falls within the current UTC day.
 * Database-backed once-per-day guard so a restart, failover, or second replica
 * never double-sends a digest for the same user on the same UTC day.
 */
function wasDigestSentToday(settings: unknown, now: Date): boolean {
  const emailChannel = ((settings ?? {}) as { emailChannel?: { lastDigestSentAt?: unknown } }).emailChannel;
  const raw = emailChannel?.lastDigestSentAt;
  if (typeof raw !== "string") {
    return false;
  }
  const lastSent = Date.parse(raw);
  if (!Number.isFinite(lastSent)) {
    return false;
  }
  const dayStart = startOfUtcDay(now);
  return lastSent >= dayStart && lastSent < dayStart + DAY_MS;
}

function toDigestTask(task: DigestTaskRow): DigestTask {
  return {
    taskId: task.id,
    key: `${task.project.key}-${task.taskNumber}`,
    title: task.title,
    projectName: task.project.name,
    projectSlug: task.project.slug,
    dueDate: task.dueDate.toISOString().slice(0, 10),
  };
}

const taskSelect = {
  id: true,
  title: true,
  taskNumber: true,
  dueDate: true,
  projectId: true,
  project: { select: { name: true, slug: true, key: true } },
} as const;

/**
 * Build the due-soon digest for one user, or null when there is nothing to
 * report (skipping empty users). Buckets across the user's accessible projects:
 *  - overdue: open task due before today
 *  - due today
 *  - due within Project.settings.dueDateWarningDays (see src/lib/alert-utils.ts);
 *    projects with due-date alerts disabled only contribute overdue/today
 *  - blocked on the user: open tasks assigned to the user that have an
 *    unfinished incoming "blocks" link (another open task must finish first)
 */
export async function buildDueSoonDigest(
  prisma: PrismaLike,
  userId: string,
  now: Date
): Promise<DueSoonDigest | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, settings: true },
  });
  if (!user?.email) {
    return null;
  }

  const accessibleProjectIds = await getAccessibleProjectIds(prisma, userId);
  if (accessibleProjectIds.length === 0) {
    return null;
  }

  const projects = (await prisma.project.findMany({
    where: { id: { in: accessibleProjectIds } },
    select: { id: true, settings: true },
  })) as Array<{ id: string; settings: unknown }>;

  const statuses = (await prisma.workflowStatus.findMany({
    where: { projectId: { in: accessibleProjectIds } },
    select: { id: true, category: true },
  })) as Array<{ id: string; category: string }>;

  const openStatusIds = new Set(
    statuses
      .filter((status) => status.category !== "done" && status.category !== "cancelled")
      .map((status) => status.id)
  );
  if (openStatusIds.size === 0) {
    return null;
  }

  const dayStart = startOfUtcDay(now);
  const dayEnd = dayStart + DAY_MS;
  // Due-soon window end per project; widest window defines the task query.
  const dueSoonEndByProject = new Map<string, number>();
  let queryDueBoundary = dayEnd;
  for (const project of projects) {
    const settings = (project.settings ?? {}) as Record<string, unknown>;
    const config = getAlertConfig(settings);
    let boundary = dayEnd;
    if (config.enabled) {
      boundary = dayStart + (config.warningDays + 1) * DAY_MS;
    }
    dueSoonEndByProject.set(project.id, boundary);
    if (boundary > queryDueBoundary) {
      queryDueBoundary = boundary;
    }
  }

  // Cap collection: one query feeds up to four buckets, so allow a generous
  // multiple of the per-section render cap — bounded work and memory even
  // for a pathological mailbox (rendering applies the hard "+N more" cap).
  const collectLimit = DIGEST_MAX_TASKS_PER_SECTION * 4;

  const dueTasks = (await prisma.task.findMany({
    where: {
      projectId: { in: accessibleProjectIds },
      archivedAt: null,
      closedAt: null,
      statusId: { in: [...openStatusIds] },
      dueDate: { lt: new Date(queryDueBoundary) },
    },
    select: taskSelect,
    orderBy: { dueDate: "asc" },
    take: collectLimit,
  })) as DigestTaskRow[];

  const overdue: DigestTask[] = [];
  const dueToday: DigestTask[] = [];
  const dueSoon: DigestTask[] = [];
  let overdueMore = 0;
  let dueTodayMore = 0;
  let dueSoonMore = 0;
  const seen = new Set<string>();

  for (const task of dueTasks) {
    const due = task.dueDate.getTime();
    if (due < dayStart) {
      if (overdue.length < DIGEST_MAX_TASKS_PER_SECTION) {
        overdue.push(toDigestTask(task));
      } else {
        overdueMore += 1;
      }
    } else if (due < dayEnd) {
      if (dueToday.length < DIGEST_MAX_TASKS_PER_SECTION) {
        dueToday.push(toDigestTask(task));
      } else {
        dueTodayMore += 1;
      }
    } else if (due < (dueSoonEndByProject.get(task.projectId) ?? dayEnd)) {
      if (dueSoon.length < DIGEST_MAX_TASKS_PER_SECTION) {
        dueSoon.push(toDigestTask(task));
      } else {
        dueSoonMore += 1;
      }
    }
    seen.add(task.id);
  }

  // Tasks blocked on the user: assigned, open, blocked by an unfinished task.
  const blockedTasks = (await prisma.task.findMany({
    where: {
      assigneeId: userId,
      projectId: { in: accessibleProjectIds },
      archivedAt: null,
      closedAt: null,
      statusId: { in: [...openStatusIds] },
      targetLinks: {
        some: {
          linkType: "blocks",
          sourceTask: {
            archivedAt: null,
            closedAt: null,
            statusId: { in: [...openStatusIds] },
          },
        },
      },
    },
    select: taskSelect,
    orderBy: { dueDate: "asc" },
    take: collectLimit,
  })) as DigestTaskRow[];

  const blockedOn: DigestTask[] = [];
  let blockedOnMore = 0;
  for (const task of blockedTasks) {
    if (seen.has(task.id)) continue;
    if (blockedOn.length < DIGEST_MAX_TASKS_PER_SECTION) {
      blockedOn.push(toDigestTask(task));
    } else {
      blockedOnMore += 1;
    }
  }

  if (overdue.length === 0 && dueToday.length === 0 && dueSoon.length === 0 && blockedOn.length === 0) {
    return null;
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    overdue,
    dueToday,
    dueSoon,
    blockedOn,
    overdueMore,
    dueTodayMore,
    dueSoonMore,
    blockedOnMore,
  };
}

/**
 * Send the digest to every user with the "digest" email preference enabled.
 * Per-user double-send protection: users whose settings.emailChannel.
 * lastDigestSentAt already falls within the current UTC day are skipped, so a
 * restart or a second replica (the scheduler advisory lock only deduplicates
 * within one tick) can never resend a digest for the same day. After a
 * successful send, lastDigestSentAt is written back to User.settings.
 */
export async function sendDueSoonDigests(now: Date, client: PrismaLike = prismaClient): Promise<DigestJobResult> {
  const users = (await client.user.findMany({
    where: { disabledAt: null },
    select: { id: true, name: true, email: true, settings: true },
  })) as Array<{ id: string; name: string | null; email: string; settings: unknown }>;

  const recipients = users.filter((user) => {
    const settings = (user.settings ?? {}) as Record<string, unknown>;
    return readEmailChannelPreference(settings, "digest");
  });

  let sent = 0;
  let skipped = 0;

  for (const user of recipients) {
    // DB-backed guard: this user already received a digest today.
    if (wasDigestSentToday(user.settings, now)) {
      skipped += 1;
      continue;
    }

    const digest = await buildDueSoonDigest(client, user.id, now);
    if (!digest) {
      skipped += 1;
      continue;
    }

    const email = renderDigestEmail({
      overdue: digest.overdue,
      dueToday: digest.dueToday,
      dueSoon: digest.dueSoon,
      blockedOn: digest.blockedOn,
      overdueMore: digest.overdueMore,
      dueTodayMore: digest.dueTodayMore,
      dueSoonMore: digest.dueSoonMore,
      blockedOnMore: digest.blockedOnMore,
    });

    try {
      await sendEmail({
        to: user.email,
        toName: user.name,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      sent += 1;
      // Best-effort bookkeeping: record the send so no other replica or a
      // restarted process resends the digest for this UTC day. Merges into the
      // existing settings/emailChannel to preserve unrelated keys.
      try {
        const settings = (user.settings ?? {}) as Record<string, unknown>;
        const emailChannel = (settings.emailChannel ?? {}) as Record<string, unknown>;
        await client.user.update({
          where: { id: user.id },
          data: {
            settings: {
              ...settings,
              emailChannel: {
                ...emailChannel,
                lastDigestSentAt: now.toISOString(),
              },
            } as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        logEmailError(`due-soon digest bookkeeping for user ${user.id} failed`, error);
      }
    } catch (error) {
      logEmailError(`due-soon digest to user ${user.id} failed`, error);
    }
  }

  return { sent, skipped };
}

// Once-per-day guard (a lastDigestSentAt-style check) so a repeated cron tick
// cannot resend the digest for the same UTC day.
let lastDigestRunDay: string | null = null;

/**
 * Job entry point for the built-in scheduler (src/server/services/scheduler.ts):
 * sends the daily due-soon digest for every opted-in user. Two guards keep it
 * at most once per UTC day: this process-level fast path (cheap, per-process)
 * and the DB-backed settings.emailChannel.lastDigestSentAt skip in
 * sendDueSoonDigests (survives restarts and multi-replica deployments).
 *
 * The process-level day is ONLY marked as done after sendDueSoonDigests
 * completes without throwing: if the run crashes mid-way (e.g. a DB error),
 * the next scheduler tick retries it instead of silently losing the day.
 * Double-sends between two concurrent ticks are prevented by the DB-backed
 * per-user lastDigestSentAt guard, which stays as is.
 */
export async function runDailyDigestJob(now: Date = new Date()): Promise<DigestJobResult | { skipped: true }> {
  const day = String(startOfUtcDay(now));
  if (lastDigestRunDay !== null && lastDigestRunDay === day) {
    return { skipped: true };
  }

  if (!isEmailConfigured()) {
    return { sent: 0, skipped: 0 };
  }

  // A throw here propagates to the scheduler (which logs it) without marking
  // the day as done, so the same day can be retried on the next tick.
  const result = await sendDueSoonDigests(now);
  lastDigestRunDay = day;
  return result;
}

/** Test helper: resets the once-per-day guard. */
export function resetDailyDigestJobForTests(): void {
  lastDigestRunDay = null;
}
