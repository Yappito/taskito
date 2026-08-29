import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { processDueDateAutomationRules } from "@/server/services/automation-evaluator";import { runDailyDigestJob } from "@/server/services/email/digest";
import { processDueRecurrences } from "@/server/services/recurrence-processor";
import { assertTickAlive, TickDeadlineExceededError } from "@/server/services/scheduler-deadline";

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
 * The same exclusion is available to the external entry points
 * (`POST /api/cron/process-recurring` and `recurrence.processDue`) via
 * {@link withSchedulerLock}: they only run when a tick is not already holding
 * the lock, so a cron call never races the tick. In-process overlap is guarded
 * independently — a tick while the previous tick's promise is still pending is
 * skipped.
 *
 * Each tick also carries a deadline (`AbortSignal.timeout(
 * SCHEDULER_TICK_TIMEOUT_MS)`). The advisory lock may outlive an individual job
 * that keeps running on pooled connections, so every job checks the signal
 * between units of work (per rule / per project / per page) and stops promptly
 * at the deadline; the next tick resumes whatever remains.
 *
 * Opt out with SCHEDULER_ENABLED=false; tune cadence with SCHEDULER_INTERVAL_MS
 * and the per-tick deadline with SCHEDULER_TICK_TIMEOUT_MS.
 */

export const SCHEDULER_ADVISORY_LOCK_KEY = 684_513_207;

const SCHEDULER_LOG_PREFIX = "[scheduler]";
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const DEFAULT_TICK_TIMEOUT_MS = 600_000;
const DEFAULT_DIGEST_HOUR_UTC = 7;
const TRANSACTION_MAX_WAIT_MS = 5_000;

type AdvisoryLockRow = { locked?: unknown };

type SchedulerGlobal = typeof globalThis & {
  __taskitoSchedulerTimer?: ReturnType<typeof setInterval> | null;
  __taskitoSchedulerTickInFlight?: boolean;
};

// The interval handle and the in-flight marker live on globalThis so hot
// reloads (which re-evaluate this module) cannot schedule a second concurrent
// timer or lose track of a pending tick.
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

async function runRecurrenceJob(signal: AbortSignal) {
  assertTickAlive(signal);
  const result = await processDueRecurrences(prisma, { limit: 100, signal });
  if (result.createdTaskIds.length > 0) {
    console.info(`${SCHEDULER_LOG_PREFIX} recurrence job created ${result.createdTaskIds.length} task(s)`);
  }
}

async function runDueDateAutomationJob(signal: AbortSignal) {
  // Per-rule creator attribution and per-rule permission re-checks live in
  // processDueDateAutomationRules (automation-evaluator.ts); the scheduler
  // never runs scheduled rules as the project owner.
  const result = await processDueDateAutomationRules(prisma, { signal });
  if (result.fired > 0) {
    console.info(`${SCHEDULER_LOG_PREFIX} due-date automation fired ${result.fired} rule occurrence(s)`);
  }
}

/**
 * Daily due-soon digest: only runs from SCHEDULER_DIGEST_HOUR_UTC onwards.
 * runDailyDigestJob itself is double-send guarded — a per-process fast path
 * plus a DB-backed per-user lastDigestSentAt check in User.settings — so
 * repeated ticks and other replicas cannot resend for the same UTC day.
 */
async function runDigestJob(now: Date, signal: AbortSignal) {
  assertTickAlive(signal);
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
 * Runs `fn` while holding the same transaction-scoped scheduler advisory lock
 * the built-in tick uses. Returns the callback's result, or `null` when the
 * lock could not be acquired (another instance/tick is mid-flight) or the
 * lock transaction failed — callers are expected to treat `null` as "skip".
 *
 * Used by the external cron endpoint and the `recurrence.processDue`
 * procedure so they can never race the built-in tick (or each other).
 */
export async function withSchedulerLock<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const rows = ((await tx.$queryRaw(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(${SCHEDULER_ADVISORY_LOCK_KEY}) AS locked`,
        )) ?? []) as AdvisoryLockRow[];
        if (rows[0]?.locked !== true) {
          return null;
        }
        return await fn();
      },
      { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: getTickTimeoutMs() },
    );
  } catch (error) {
    // Fail safe: if the transaction (e.g. the lock query) blows up, skip
    // instead of crashing the timer loop or the caller.
    console.error(`${SCHEDULER_LOG_PREFIX} lock acquisition aborted, skipping: ${describeError(error)}`);
    return null;
  }
}

/**
 * One scheduler tick: guard against in-process overlap, take the scheduler
 * advisory lock via {@link withSchedulerLock}, and run all three jobs under a
 * cancellable deadline while the lock is held. Each job is isolated so a
 * failure cannot abort the others; the lock itself is released automatically
 * when the transaction commits.
 */
export async function runScheduledJobs() {
  if (globalForScheduler.__taskitoSchedulerTickInFlight) {
    console.info(`${SCHEDULER_LOG_PREFIX} previous tick still in flight; skipping tick`);
    return { ran: false };
  }
  globalForScheduler.__taskitoSchedulerTickInFlight = true;
  try {
    const result = await withSchedulerLock(async () => {
      const deadline = AbortSignal.timeout(getTickTimeoutMs());
      let deadlineHit = false;

      for (const job of [
        () => runRecurrenceJob(deadline),
        () => runDueDateAutomationJob(deadline),
        () => runDigestJob(new Date(), deadline),
      ]) {
        try {
          await job();
        } catch (error) {
          if (error instanceof TickDeadlineExceededError) {
            deadlineHit = true;
            break;
          }
          console.error(`${SCHEDULER_LOG_PREFIX} scheduled job failed: ${describeError(error)}`);
        }
      }

      if (deadlineHit || deadline.aborted) {
        console.warn(
          `${SCHEDULER_LOG_PREFIX} tick exceeded SCHEDULER_TICK_TIMEOUT_MS (${Math.round(getTickTimeoutMs() / 1000)}s); remaining work is deferred to the next tick`,
        );
      }

      return { ran: true };
    });

    if (result === null) {
      return { ran: false };
    }
    return { ran: true };
  } finally {
    globalForScheduler.__taskitoSchedulerTickInFlight = false;
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
  globalForScheduler.__taskitoSchedulerTickInFlight = false;
}