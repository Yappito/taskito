import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { processDueDateAutomationRules } from "@/server/services/automation-evaluator";
import { runDailyDigestJob } from "@/server/services/email/digest";
import { processDueRecurrences } from "@/server/services/recurrence-processor";
import { assertTickAlive, TickDeadlineExceededError } from "@/server/services/scheduler-deadline";
import { recordSprintSnapshots } from "@/server/services/sprint-snapshot";
import { processDueWebhookDeliveries } from "@/server/services/webhooks/dispatcher";

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
 * SCHEDULER_TICK_TIMEOUT_MS)`). The deadline is INDEPENDENT of the lock
 * transaction's lifetime: jobs run on the GLOBAL prisma client + fetch (DB
 * operations, SMTP, webhook HTTP calls), so the interactive transaction that
 * holds the advisory lock can neither cancel them nor be cancelled by them —
 * the signal is only checked BETWEEN units of work. The lock transaction
 * therefore performs nothing but the lock query and its timeout is configured
 * separately (SCHEDULER_LOCK_TX_TIMEOUT_MS, default 24h): expiring it at the
 * tick deadline would release the advisory lock and clear the in-process guard
 * while jobs are still live, letting the next tick run concurrently (M9).
 * Instead the advisory lock is held for the whole run and released exactly
 * when the run settles (commit in the happy path; if Prisma ever expires the
 * lock tx anyway, {@link withSchedulerLock} awaits the outstanding work before
 * reporting, so callers never release their in-flight guard while jobs run).
 * Durable idempotency (recurrence CAS, digest claims, automation firings,
 * webhook delivery leases) remains the second safety boundary.
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
/**
 * The lock transaction holds exactly one query (pg_try_advisory_xact_lock);
 * its timeout must never be derived from the tick deadline — expiring it at
 * the deadline would release the advisory lock while jobs (which run on the
 * global client and cannot be cancelled by the tx) are still live (M9). The
 * default keeps the lock connection open for the whole run even when a job
 * ignores the deadline for a long time.
 */
const DEFAULT_LOCK_TX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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

/** Independent transaction timeout for the lock transaction (see above). */
function getLockTxTimeoutMs() {
  const parsed = Number(process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed >= 1_000) {
    return Math.floor(parsed);
  }
  if (process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS) {
    console.warn(
      `${SCHEDULER_LOG_PREFIX} invalid SCHEDULER_LOCK_TX_TIMEOUT_MS "${process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS}", using ${DEFAULT_LOCK_TX_TIMEOUT_MS}ms`,
    );
  }
  return DEFAULT_LOCK_TX_TIMEOUT_MS;
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
 * plus durable per-user/day EmailDigestClaim rows (unique on userId + dayUtc,
 * with explicit pending/succeeded/failed states so failed recipients are
 * retried on a later tick) — so repeated ticks and other replicas cannot
 * resend for the same UTC day.
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
 * Daily sprint snapshot series: one remaining-work row per active sprint for
 * the current UTC day (idempotent upsert on the unique sprintId + day pair).
 */
async function runSprintSnapshotJob(signal: AbortSignal) {
  assertTickAlive(signal);
  const recorded = await recordSprintSnapshots(prisma);
  if (recorded > 0) {
    console.info(`${SCHEDULER_LOG_PREFIX} sprint snapshot job recorded ${recorded} sprint snapshot(s)`);
  }
}

/** Pending webhook deliveries whose nextAttemptAt came due (retries + restarts). */
async function runWebhookDeliveryJob(signal: AbortSignal) {
  assertTickAlive(signal);
  const result = await processDueWebhookDeliveries(prisma, new Date(), { signal });
  if (result.processed > 0) {
    console.info(`${SCHEDULER_LOG_PREFIX} webhook delivery job processed ${result.processed} delivery(ies) (${result.succeeded} succeeded)`);
  }
}

/**
 * Runs `fn` while holding the same transaction-scoped scheduler advisory lock
 * the built-in tick uses. Returns the callback's result, or `null` when the
 * lock could not be acquired (another instance/tick is mid-flight) or the
 * lock transaction failed — callers are expected to treat `null` as "skip".
 *
 * The tick deadline is created here (after the lock is won) and handed to
 * `fn`, so every caller — built-in tick, cron endpoint, manual run — drives
 * its jobs against the same cancellable deadline.
 *
 * M9 lock lifetime: the transaction holds ONLY the advisory-lock query; its
 * timeout is independent of the tick deadline (see getLockTxTimeoutMs).
 * `fn`'s work runs on the global prisma client / fetch and cannot be cancelled
 * by the lock transaction, so when Prisma ever expires the lock tx while the
 * work is still live, we await that work BEFORE returning — a caller that
 * clears its in-flight guard on our return can never do so while jobs are
 * still running. The durable idempotency keys inside each job remain the
 * second boundary against double execution.
 */
export async function withSchedulerLock<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  let work: Promise<T> | undefined;
  try {
    return await prisma.$transaction(
      async (tx) => {
        const rows = ((await tx.$queryRaw(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(${SCHEDULER_ADVISORY_LOCK_KEY}) AS locked`,
        )) ?? []) as AdvisoryLockRow[];
        if (rows[0]?.locked !== true) {
          return null;
        }
        // The deadline starts once the lock is ours; the work itself runs on
        // the global client (outside this transaction's connection).
        const deadline = AbortSignal.timeout(getTickTimeoutMs());
        work = fn(deadline);
        return await work;
      },
      // The lock must live for the whole run — it is NOT the tick deadline
      // (that is the signal handed to fn); expiring the tx would free the
      // advisory lock while un-cancellable work is still in flight (M9).
      { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: getLockTxTimeoutMs() },
    );
  } catch (error) {
    // Fail safe: if the transaction (e.g. the lock query) blows up, skip
    // instead of crashing the timer loop or the caller.
    console.error(`${SCHEDULER_LOG_PREFIX} lock acquisition aborted, skipping: ${describeError(error)}`);
    if (work) {
      // The lock transaction ended while the work is still running on pooled
      // connections (e.g. Prisma expired the tx, or the fn itself threw and
      // the rollback raced it). Await the real end of the work before
      // reporting: runScheduledJobs clears its in-flight guard only after
      // this returns, so no second tick can start while jobs are live (M9).
      await work.catch(() => {});
    }
    return null;
  }
}

/**
 * One scheduler tick: guard against in-process overlap, take the scheduler
 * advisory lock via {@link withSchedulerLock}, and run all jobs under a
 * cancellable deadline while the lock is held. Each job is isolated so a
 * failure cannot abort the others; the lock is released (commit) only when
 * every job has settled — a job that outlives SCHEDULER_TICK_TIMEOUT_MS keeps
 * the lock (and the in-process guard) until it actually finishes, so a later
 * tick cannot run concurrently with live work (M9). The in-flight guard is
 * cleared in `finally`, i.e. strictly after the lock run completed.
 */
export async function runScheduledJobs() {
  if (globalForScheduler.__taskitoSchedulerTickInFlight) {
    console.info(`${SCHEDULER_LOG_PREFIX} previous tick still in flight; skipping tick`);
    return { ran: false };
  }
  globalForScheduler.__taskitoSchedulerTickInFlight = true;
  try {
    const result = await withSchedulerLock(async (deadline) => {
      let deadlineHit = false;

      for (const job of [
        () => runRecurrenceJob(deadline),
        () => runDueDateAutomationJob(deadline),
        () => runDigestJob(new Date(), deadline),
        () => runSprintSnapshotJob(deadline),
        () => runWebhookDeliveryJob(deadline),
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