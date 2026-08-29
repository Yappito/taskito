import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { processDueDateAutomationRules } from "@/server/services/automation-evaluator";
import { runDailyDigestJob } from "@/server/services/email/digest";
import { processDueRecurrences } from "@/server/services/recurrence-processor";

/**
 * In-process background scheduler ("cron inside the app").
 *
 * Drives the three time-based features that used to require an external trigger:
 *  - recurrence processing (creating the next occurrence of recurring tasks)
 *  - due-date automation rules (`dueDatePassed` trigger)
 *  - the daily due-soon digest email (from SCHEDULER_DIGEST_HOUR_UTC onwards)
 *
 * Multi-replica safety: every tick opens one interactive transaction and takes
 * a transaction-scoped Postgres advisory lock (`pg_try_advisory_xact_lock`)
 * inside it, so only one app instance runs jobs at a time — the others skip the
 * tick. The lock is bound to the transaction's pooled connection and released
 * automatically at commit/rollback, so it can never leak onto an idle pool
 * connection the way a session-scoped lock would. Jobs themselves keep using
 * the global client; only the lock needs the transaction's connection to stay
 * open. Failures are logged with a `[scheduler]` prefix (never secrets) and
 * never abort the remaining jobs.
 *
 * Opt out with SCHEDULER_ENABLED=false; tune cadence with SCHEDULER_INTERVAL_MS
 * and the per-tick transaction budget with SCHEDULER_TICK_TIMEOUT_MS.
 */

export const SCHEDULER_ADVISORY_LOCK_KEY = 684_513_207;

const SCHEDULER_LOG_PREFIX = "[scheduler]";
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const DEFAULT_TICK_TIMEOUT_MS = 600_000;
const DEFAULT_DIGEST_HOUR_UTC = 7;
const TRANSACTION_MAX_WAIT_MS = 5_000;

type PrismaClient = typeof import("@/lib/prisma").prisma;

type AdvisoryLockRow = { locked?: unknown };

type SchedulerGlobal = typeof globalThis & {
  __taskitoSchedulerTimer?: ReturnType<typeof setInterval> | null;
};

// The interval handle lives on globalThis so hot reloads (which re-evaluate this
// module) cannot schedule a second concurrent timer.
const globalForScheduler = globalThis as SchedulerGlobal;

export function isSchedulerEnabled() {
  const raw = (process.env.SCHEDULER_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "no" && raw !== "off";
}

export function getSchedulerIntervalMs() {
  const parsed = Number(process.env.SCHEDULER_INTERVAL_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    // Clamp to the minimum instead of allowing pathologically hot loops.
    return Math.max(MIN_INTERVAL_MS, Math.floor(parsed));
  }
  if (process.env.SCHEDULER_INTERVAL_MS) {
    console.warn(
      `${SCHEDULER_LOG_PREFIX} invalid SCHEDULER_INTERVAL_MS "${process.env.SCHEDULER_INTERVAL_MS}", using ${DEFAULT_INTERVAL_MS}ms`,
    );
  }
  return DEFAULT_INTERVAL_MS;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getTickTimeoutMs() {
  const parsed = Number(process.env.SCHEDULER_TICK_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  if (process.env.SCHEDULER_TICK_TIMEOUT_MS) {
    console.warn(
      `${SCHEDULER_LOG_PREFIX} invalid SCHEDULER_TICK_TIMEOUT_MS "${process.env.SCHEDULER_TICK_TIMEOUT_MS}", using ${DEFAULT_TICK_TIMEOUT_MS}ms`,
    );
  }
  return DEFAULT_TICK_TIMEOUT_MS;
}

/**
 * Earliest UTC hour at which the daily digest job may run
 * (SCHEDULER_DIGEST_HOUR_UTC, default 7). Values outside 0-23 fall back to the
 * default so a typo cannot disable or over-fire the digest.
 */
export function getSchedulerDigestHourUtc() {
  const raw = process.env.SCHEDULER_DIGEST_HOUR_UTC;
  const parsed = Number(raw);
  if (raw && Number.isInteger(parsed) && parsed >= 0 && parsed <= 23) {
    return parsed;
  }
  if (raw) {
    console.warn(
      `${SCHEDULER_LOG_PREFIX} invalid SCHEDULER_DIGEST_HOUR_UTC "${raw}", using ${DEFAULT_DIGEST_HOUR_UTC}`,
    );
  }
  return DEFAULT_DIGEST_HOUR_UTC;
}

async function runRecurrenceJob() {
  const result = await processDueRecurrences(prisma, { limit: 100 });
  if (result.createdTaskIds.length > 0) {
    console.info(`${SCHEDULER_LOG_PREFIX} recurrence job created ${result.createdTaskIds.length} task(s)`);
  }
}

/**
 * The AutomationRule model does not store a creator, so actions are attributed
 * to the project owner (ProjectMember with role "owner", the RBAC convention
 * used across the app). Falls back to the earliest remaining project member,
 * and skips projects that have no members at all.
 */
export async function resolveProjectActorId(client: PrismaClient, projectId: string) {
  const ownerMember = await client.projectMember.findFirst({
    where: { projectId, role: "owner" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (ownerMember) return ownerMember.userId;

  const fallbackMember = await client.projectMember.findFirst({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  return fallbackMember?.userId ?? null;
}

async function runDueDateAutomationJob() {
  const projects = await prisma.automationRule.findMany({
    where: { isEnabled: true, trigger: "dueDatePassed" },
    select: { projectId: true },
    distinct: ["projectId"],
    orderBy: { projectId: "asc" },
  });

  for (const { projectId } of projects) {
    try {
      const actorId = await resolveProjectActorId(prisma, projectId);
      if (!actorId) {
        console.warn(`${SCHEDULER_LOG_PREFIX} project ${projectId} has due-date rules but no members to act as; skipping`);
        continue;
      }
      await processDueDateAutomationRules(prisma, { projectId, actorId });
    } catch (error) {
      console.error(`${SCHEDULER_LOG_PREFIX} due-date automation failed for project ${projectId}: ${describeError(error)}`);
    }
  }
}

/**
 * Daily due-soon digest: only runs from SCHEDULER_DIGEST_HOUR_UTC onwards.
 * runDailyDigestJob itself is double-send guarded — a per-process fast path
 * plus a DB-backed per-user lastDigestSentAt check in User.settings — so
 * repeated ticks and other replicas cannot resend for the same UTC day.
 */
async function runDigestJob() {
  const now = new Date();
  const digestHour = getSchedulerDigestHourUtc();
  if (now.getUTCHours() < digestHour) {
    return;
  }
  const result = await runDailyDigestJob(now);
  if ("sent" in result && result.sent > 0) {
    console.info(`${SCHEDULER_LOG_PREFIX} daily digest sent to ${result.sent} user(s)`);
  }
}

/**
 * One scheduler tick: open a transaction, take the transaction-scoped advisory
 * lock inside it, and run all three jobs while the transaction (and therefore
 * the lock) is held. Each job is isolated so a failure cannot abort the others;
 * the lock itself is released automatically when the transaction commits.
 */
export async function runScheduledJobs() {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const rows = (await tx.$queryRaw<AdvisoryLockRow[]>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(${SCHEDULER_ADVISORY_LOCK_KEY}) AS locked`,
        )) as Array<{ locked?: unknown }>;
        if (rows[0]?.locked !== true) {
          console.info(`${SCHEDULER_LOG_PREFIX} lock held by another instance; skipping tick`);
          return { ran: false };
        }

        for (const job of [runRecurrenceJob, runDueDateAutomationJob, runDigestJob]) {
          try {
            await job();
          } catch (error) {
            console.error(`${SCHEDULER_LOG_PREFIX} scheduled job failed: ${describeError(error)}`);
          }
        }

        return { ran: true };
      },
      { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: getTickTimeoutMs() },
    );
  } catch (error) {
    // Fail safe: if the transaction (e.g. the lock query) blows up, skip the
    // tick instead of crashing the timer loop.
    console.error(`${SCHEDULER_LOG_PREFIX} tick aborted, skipping: ${describeError(error)}`);
    return { ran: false };
  }
}

/** Starts the interval-driven scheduler. Safe to call repeatedly (idempotent). */
export function startScheduler() {
  if (globalForScheduler.__taskitoSchedulerTimer) {
    return;
  }
  if (!isSchedulerEnabled()) {
    console.info(`${SCHEDULER_LOG_PREFIX} disabled via SCHEDULER_ENABLED; not starting`);
    return;
  }

  const intervalMs = getSchedulerIntervalMs();
  const timer = setInterval(() => {
    runScheduledJobs().catch((error) => {
      console.error(`${SCHEDULER_LOG_PREFIX} tick failed: ${describeError(error)}`);
    });
  }, intervalMs);
  globalForScheduler.__taskitoSchedulerTimer = timer;
  console.info(`${SCHEDULER_LOG_PREFIX} started (interval ${intervalMs}ms)`);
}

/** Stops the scheduler and clears the idempotency marker (used by tests/shutdown). */
export function stopScheduler() {
  const timer = globalForScheduler.__taskitoSchedulerTimer;
  if (timer) {
    clearInterval(timer);
  }
  globalForScheduler.__taskitoSchedulerTimer = null;
}