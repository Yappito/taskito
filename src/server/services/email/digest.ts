import { Prisma } from "@prisma/client";

import { prisma as prismaClient } from "@/lib/prisma";
import { getAlertConfig } from "@/lib/alert-utils";
import { getAccessibleProjectIds } from "@/server/authz";
import { readEmailChannelPreference } from "@/server/services/notifications";
import { isEmailConfigured, logEmailError, sendEmail } from "@/server/services/email/smtp-client";
import { DIGEST_MAX_TASKS_PER_SECTION, renderDigestEmail, type DigestTask } from "@/server/services/email/templates";

type PrismaLike = typeof prismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a pending claim can sit untouched before it is considered
 * orphaned (its owning run crashed mid-send) and may be reclaimed. */
export const DIGEST_CLAIM_STALE_MS = 15 * 60 * 1000;

/** Maximum send attempts per user per UTC day; after this the claim stays
 * failed and is no longer retried (bounded retry loop for a dead SMTP). */
export const DIGEST_CLAIM_MAX_ATTEMPTS = 5;

/** Claims older than this many UTC days are pruned. */
const DIGEST_CLAIM_RETENTION_DAYS = 8;

const DIGEST_CLAIM_LAST_ERROR_MAX_LENGTH = 500;

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
  /** Recipients that still need a retry for this UTC day (failed sends below
   * the attempt cap, or claims still pending/sending from an interrupted or
   * in-flight run). */
  retryable: number;
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

/** "YYYY-MM-DD" form of the UTC day containing `date` (the claim key). */
function utcDayString(date: Date): string {
  return new Date(startOfUtcDay(date)).toISOString().slice(0, 10);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, DIGEST_CLAIM_LAST_ERROR_MAX_LENGTH);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

interface DigestClaimRow {
  userId: string;
  status: string;
  attempts: number;
  updatedAt: Date;
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
 *
 * Cross-replica uniqueness boundary: a durable EmailDigestClaim row, unique on
 * (userId, dayUtc), NOT the best-effort settings.emailChannel.lastDigestSentAt
 * write. Claim lifecycle (CITADEL-e10 finding 6):
 *
 *   pending   — claim acquired (created, or CAS-reclaimed from failed/
 *               stale-pending); the digest is built. Crashing here is
 *               unambiguous (nothing sent yet), so a stale pending claim is
 *               safely reclaimable by another run.
 *   sending   — flipped immediately BEFORE the SMTP call and marked succeeded
 *               (or failed) after it. SMTP is an external side effect a DB row
 *               cannot prove: if a run dies in this window, the outcome is
 *               AMBIGUOUS. Chosen semantics: AT-MOST-ONCE. A claim found stale
 *               in "sending" is NEVER resent — it is abandoned as failed at
 *               the attempt cap with a logged warning (a missed digest is
 *               preferable to a duplicate).
 *   succeeded — durable proof the user was handled for the day.
 *   failed    — last send attempt errored (or the claim was abandoned);
 *               retried up to {@link DIGEST_CLAIM_MAX_ATTEMPTS} times while
 *               under the cap.
 *
 * After a successful SMTP send the claim is marked succeeded, and a failed
 * send keeps an explicit failed state that a later tick on the same UTC day
 * retries.
 *
 * The returned `retryable` count reports how many recipients still need work
 * for this day — runDailyDigestJob only closes its process-level day guard
 * once that reaches zero, and another replica re-running the same day is kept
 * out by the succeeded claims, never by the process guard. Sending claims
 * keep the day open too: fresh ones resolve when their run finishes, stale
 * ones when a later run abandons them.
 */
export async function sendDueSoonDigests(now: Date, client: PrismaLike = prismaClient): Promise<DigestJobResult> {
  const dayUtc = utcDayString(now);
  const staleBefore = new Date(now.getTime() - DIGEST_CLAIM_STALE_MS);

  const users = (await client.user.findMany({
    where: { disabledAt: null },
    select: { id: true, name: true, email: true, settings: true },
  })) as Array<{ id: string; name: string | null; email: string; settings: unknown }>;

  const recipients = users.filter((user) => {
    const settings = (user.settings ?? {}) as Record<string, unknown>;
    return readEmailChannelPreference(settings, "digest");
  });

  // Housekeeping: drop claims older than the retention window.
  try {
    await client.emailDigestClaim.deleteMany({
      where: { dayUtc: { lt: utcDayString(new Date(now.getTime() - DIGEST_CLAIM_RETENTION_DAYS * DAY_MS)) } },
    });
  } catch (error) {
    logEmailError("due-soon digest claim pruning failed", error);
  }

  const claims = (recipients.length === 0 ? [] : (await client.emailDigestClaim.findMany({
    where: { dayUtc, userId: { in: recipients.map((user) => user.id) } },
  })) as DigestClaimRow[]);
  const claimByUser = new Map(claims.map((claim) => [claim.userId, claim]));

  let sent = 0;
  let skipped = 0;

  for (const user of recipients) {
    // Legacy settings-based guard, kept as a bootstrap for days already
    // completed before the claim table existed. It is NOT the uniqueness
    // boundary, only an additional read-only skip.
    if (wasDigestSentToday(user.settings, now)) {
      skipped += 1;
      continue;
    }

    const existing = claimByUser.get(user.id);
    if (existing?.status === "succeeded") {
      // Durable proof this user already received (or needed nothing for) the
      // digest today — another replica or tick is done with this recipient.
      skipped += 1;
      continue;
    }
    if (
      (existing?.status === "pending" || existing?.status === "sending")
      && existing.updatedAt.getTime() > staleBefore.getTime()
    ) {
      // A live run somewhere owns this recipient (pending = building the
      // digest, sending = mid-SMTP); never race it.
      skipped += 1;
      continue;
    }
    if (existing?.status === "sending") {
      // CITADEL-e10 (finding 6): a STALE "sending" claim is ambiguous — SMTP
      // may already have accepted the message before the owning run died, and
      // no DB row can prove an external send completed. At-most-once
      // semantics: abandon the claim as failed at the attempt cap (never
      // reclaimed, never resent) with a logged warning. A missed digest is
      // preferable to a duplicate.
      //
      // CITADEL-ae2 (finding 5): the abandonment must reassert the EXACT
      // staleness this run observed — `updatedAt <= staleBefore` plus the
      // attempts value it read at preload time. Matching only on
      // {userId, dayUtc, status: "sending"} is an ABA hazard: between the
      // preload above and this write, the claim can go stale-sending →
      // failed → reclaimed-pending → FRESH sending by another replica that
      // is mid-SMTP right now; the un-pinned update would then cap that
      // healthy in-flight send at failed/attempts-max. With both observed
      // fields pinned, the update can only match the same stale claim this
      // run saw — a fresh claim (recent updatedAt, different attempts) fits
      // neither condition, matches nothing (count 0), and stays with its
      // live owner.
      try {
        const abandoned = await client.emailDigestClaim.updateMany({
          where: {
            userId: user.id,
            dayUtc,
            status: "sending",
            updatedAt: { lte: staleBefore },
            attempts: existing.attempts,
          },
          data: {
            status: "failed",
            attempts: DIGEST_CLAIM_MAX_ATTEMPTS,
            lastError: "abandoned: ambiguous send outcome (stale sending claim); not resent to avoid a duplicate",
          },
        });
        logEmailError(
          abandoned.count > 0
            ? `due-soon digest claim for user ${user.id} was stale in "sending" — abandoned without resending (at-most-once)`
            : `due-soon digest claim for user ${user.id} looked stale in "sending" but changed underneath (fresh live claim) — left untouched`,
          new Error(abandoned.count > 0 ? "stale sending claim" : "sending claim ABA: fresh claim not abandoned"),
        );
      } catch (error) {
        logEmailError(`due-soon digest claim bookkeeping for user ${user.id} failed`, error);
      }
      skipped += 1;
      continue;
    }

    // Atomically acquire (first attempt) or re-acquire (retry) the claim. For
    // retries the CAS-style updateMany only matches claims that are still
    // failed below the attempt cap or stale-pending; if another replica took
    // the claim first, the update matches nothing and we skip.
    let acquired = false;
    if (!existing) {
      try {
        await client.emailDigestClaim.create({
          data: { userId: user.id, dayUtc, status: "pending", attempts: 1 },
        });
        acquired = true;
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        // Another replica created the claim between our read and write.
      }
    } else {
      const reclaimed = await client.emailDigestClaim.updateMany({
        where: {
          userId: user.id,
          dayUtc,
          OR: [
            { status: "failed", attempts: { lt: DIGEST_CLAIM_MAX_ATTEMPTS } },
            { status: "pending", updatedAt: { lt: staleBefore } },
          ],
        },
        data: { status: "pending", attempts: { increment: 1 } },
      });
      acquired = reclaimed.count === 1;
    }
    if (!acquired) {
      skipped += 1;
      continue;
    }

    const digest = await buildDueSoonDigest(client, user.id, now);
    if (!digest) {
      // Nothing to report: close the claim so later ticks skip this user
      // without rebuilding the digest.
      try {
        await client.emailDigestClaim.updateMany({
          where: { userId: user.id, dayUtc },
          data: { status: "succeeded" },
        });
      } catch (error) {
        logEmailError(`due-soon digest claim bookkeeping for user ${user.id} failed`, error);
      }
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

    // CITADEL-e10 (finding 6): flip pending → sending immediately before the
    // SMTP call. Everything up to here is retryable (nothing was sent); from
    // this flip onward the outcome is ambiguous, so a crash makes the claim
    // un-reclaimable (see the stale-sending abandonment above) instead of
    // letting a later sweep duplicate the send.
    const flipped = await client.emailDigestClaim.updateMany({
      where: { userId: user.id, dayUtc, status: "pending" },
      data: { status: "sending" },
    });
    if (!flipped || flipped.count !== 1) {
      // The claim moved underneath us (external tampering or a concurrent
      // bookkeeping write) — never race whoever owns it now.
      skipped += 1;
      continue;
    }

    try {
      await sendEmail({
        to: user.email,
        toName: user.name,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
    } catch (error) {
      logEmailError(`due-soon digest to user ${user.id} failed`, error);
      // Durable failure marker: the claim flips to failed so a later tick on
      // the same UTC day retries, while every replica sees the failure.
      try {
        await client.emailDigestClaim.updateMany({
          where: { userId: user.id, dayUtc },
          data: { status: "failed", lastError: describeError(error) },
        });
      } catch (bookkeepingError) {
        logEmailError(`due-soon digest claim bookkeeping for user ${user.id} failed`, bookkeepingError);
      }
      continue;
    }

    sent += 1;
    // Mark the durable claim succeeded FIRST: once this write lands, no other
    // replica can resend this user/day even if the legacy settings bookkeeping
    // below fails (the claim, not lastDigestSentAt, is the boundary). If this
    // write itself fails, the claim stays "sending": ambiguous, never resent
    // (CITADEL-e10 finding 6) — the initiating response still counted the send.
    try {
      await client.emailDigestClaim.updateMany({
        where: { userId: user.id, dayUtc },
        data: { status: "succeeded", sentAt: now },
      });
    } catch (error) {
      logEmailError(`due-soon digest claim bookkeeping for user ${user.id} failed`, error);
    }
    // Legacy user-visible bookkeeping (settings.emailChannel.lastDigestSentAt).
    // Best-effort and purely informational now; merges into the existing
    // settings/emailChannel to preserve unrelated keys.
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
  }

  // How many recipients still need work for this day? Failed claims under the
  // attempt cap, any pending claim (retry-safe), and any sending claim —
  // including pending/sending claims another replica is still working on, so
  // this process never closes its day guard while any recipient might still
  // be mid-flight or awaiting abandonment (CITADEL-e10 finding 6).
  let retryable = 0;
  try {
    const remaining = (await client.emailDigestClaim.findMany({
      where: {
        dayUtc,
        OR: [
          { status: "failed", attempts: { lt: DIGEST_CLAIM_MAX_ATTEMPTS } },
          { status: "pending" },
          { status: "sending" },
        ],
      },
      select: { id: true },
    })) as Array<{ id: string }>;
    retryable = remaining.length;
  } catch (error) {
    // If this sweep fails, stay conservative and keep the day open so the
    // next tick re-examines every recipient through the claim table.
    logEmailError("due-soon digest retryability sweep failed", error);
    retryable = 1;
  }

  return { sent, skipped, retryable };
}

// Once-per-day guard (a lastDigestRunDay-style check) so a repeated cron tick
// cannot resend the digest for the same UTC day. Only closed when no retryable
// recipients remain; per-user/day uniqueness lives in the durable
// EmailDigestClaim rows, not here.
let lastDigestRunDay: string | null = null;

/**
 * Job entry point for the built-in scheduler (src/server/services/scheduler.ts):
 * sends the daily due-soon digest for every opted-in user.
 *
 * Cross-replica double-send prevention lives in the durable EmailDigestClaim
 * rows (unique per user + UTC day, created before any send attempt). This
 * process-level day guard is a cheap fast path ONLY and is marked done only
 * when sendDueSoonDigests reports no retryable recipients: while a recipient
 * failure (or an unfinished claim) remains, the next tick of the same UTC day
 * re-enters sendDueSoonDigests and retries failed recipients through their
 * failed/stale-pending claims instead of silently losing the day.
 */
export async function runDailyDigestJob(now: Date = new Date()): Promise<DigestJobResult | { skipped: true }> {
  const day = String(startOfUtcDay(now));
  if (lastDigestRunDay !== null && lastDigestRunDay === day) {
    return { skipped: true };
  }

  if (!isEmailConfigured()) {
    return { sent: 0, skipped: 0, retryable: 0 };
  }

  // A throw here propagates to the scheduler (which logs it) without marking
  // the day as done, so the same day can be retried on the next tick.
  const result = await sendDueSoonDigests(now);
  if (result.retryable === 0) {
    lastDigestRunDay = day;
  }
  return result;
}

/** Test helper: resets the once-per-day guard. */
export function resetDailyDigestJobForTests(): void {
  lastDigestRunDay = null;
}
