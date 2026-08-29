import { prisma } from "@/lib/prisma";
import { processDueDateAutomationRules } from "@/server/services/automation-evaluator";
import { runDailyDigestJob } from "@/server/services/email/digest";
import { processDueRecurrences } from "@/server/services/recurrence-processor";
import { assertTickAlive, TickDeadlineExceededError } from "@/server/services/scheduler-deadline";
import { createSchedulerLockConnection, SchedulerLockConnection } from "@/server/services/scheduler-lock-connection";
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
 * Multi-replica safety: every run takes a TRANSACTION-scoped Postgres advisory
 * lock (`pg_try_advisory_xact_lock`) inside ONE interactive transaction held
 * open for the whole run on a DEDICATED connection created just for the lock
 * ({@link createSchedulerLockConnection}, its own single-connection
 * PrismaClient). The scheduler callback is awaited INSIDE that transaction
 * callback, so the lock and the live work share one backend with no gap: the
 * lock cannot be dropped by pool idle-retirement (the connection is never
 * idle while the run is live) and the design is valid under a
 * transaction-pooler DATABASE_URL (the backend stays assigned for the whole
 * transaction). Only the transaction ending — commit after the run settles,
 * rollback on failure, session death on crash — releases it, which makes the
 * lock exclusive across replicas for as long as the work runs (the previous
 * session-lock variant returned its connection to the pool between lock and
 * unlock, where idle-retirement could reap the session and silently drop the
 * lock mid-run, and transaction-poolers made the acquire/unlock pair
 * meaningless). The dedicated connection never comes from the shared query
 * pool the jobs use, so no job ever waits on a connection the lock is
 * occupying (a long interactive transaction on the shared pool would tie it
 * up for the whole tick, and a 1-connection pool would self-deadlock).
 *
 * The same exclusion is available to the external entry points
 * (`POST /api/cron/process-recurring` and `recurrence.processDue`) via
 * {@link withSchedulerLock}: they only run when no tick holds the lock, so a
 * cron call never races the tick. In-process overlap is guarded
 * independently — a tick while the previous tick's promise is still pending
 * is skipped.
 *
 * Each tick also carries a deadline (`AbortSignal.timeout(
 * SCHEDULER_TICK_TIMEOUT_MS)`). The deadline is INDEPENDENT of the lock:
 * jobs run on the GLOBAL prisma client + fetch (DB operations, SMTP, webhook
 * HTTP calls) and are only cancelled BETWEEN units of work by the signal.
 * The dedicated lock connection performs nothing but the pinned lock
 * transaction (`pg_try_advisory_xact_lock` inside it, plus the awaited run),
 * and the transaction's timeout (`SCHEDULER_LOCK_TX_TIMEOUT_MS`, default
 * 24h) is far above the tick budget so Prisma never aborts it mid-run. If
 * the process dies mid-run the backend session drops, Postgres aborts the
 * open transaction and releases the lock — durable idempotency (recurrence
 * CAS, digest claims, automation firings, webhook delivery leases) remains
 * the second safety boundary.
 *
 * Failures are logged with a `[scheduler]` prefix (never secrets) and never
 * abort the remaining jobs.
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
 * Runs `fn` while holding the scheduler advisory lock. Returns the callback's
 * result, or `null` when the lock could not be acquired (another
 * replica/tick/session is mid-run) or the lock machinery failed — callers are
 * expected to treat `null` as "skip".
 *
 * The tick deadline is created lazily — after the lock is won, inside the
 * lazy callback — and handed to `fn`, so every caller — built-in tick, cron
 * endpoint, manual run — drives its jobs against the same cancellable
 * deadline.
 *
 * Lock lifetime (codex_sol wave-6 findings 7 & 8, wave-8 finding 2): the
 * lock is TRANSACTION-scoped and lives inside ONE interactive transaction on
 * the DEDICATED lock client from {@link createSchedulerLockConnection} —
 * never on the shared query pool the jobs use. `runExclusive` takes
 * `pg_try_advisory_xact_lock` inside that transaction and awaits `fn` while
 * it is open, so the acquiring backend is pinned (open transaction, actively
 * not idle) until `fn` settles: pool idle-retirement cannot reap the session
 * mid-run, and under a transaction-pooler DATABASE_URL the advisory lock and
 * the work share one backend for the whole transaction. The lock is released
 * exactly when the transaction ends — commit after the run settles, rollback
 * if `fn` throws, session death if the process dies — and the connection
 * close (`end`/`$disconnect`) happens in a `finally` on ALL paths
 * (acquired / not acquired / throw / return), strictly after the run
 * settles. If the process dies mid-run Postgres aborts the transaction and
 * releases the lock; durable idempotency keys inside each job remain the
 * second boundary.
 */
export async function withSchedulerLock<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  // Dedicated connection whose lifetime THIS function controls: it never
  // comes from the shared query pool the global prisma client uses, so the
  // jobs can never wait on the connection that holds the lock.
  let lock: SchedulerLockConnection | undefined;
  try {
    lock = createSchedulerLockConnection();
    // One pinned transaction: the xact try-lock runs inside it, and the lazy
    // callback (which creates the tick deadline only AFTER the lock is won)
    // is awaited before the transaction — and the lock — may end. `null`
    // means another live session already holds the lock -> skip this run.
    return await lock.runExclusive(SCHEDULER_ADVISORY_LOCK_KEY, () => fn(AbortSignal.timeout(getTickTimeoutMs())));
  } catch (error) {
    // Fail safe: if the lock connection or the lock transaction blows up
    // (including its COMMIT), skip instead of crashing the timer loop or the
    // caller. `fn`'s failure lands here too — the transaction rollback and
    // the connection close below still release/close everything.
    console.error(`${SCHEDULER_LOG_PREFIX} lock acquisition aborted, skipping: ${describeError(error)}`);
    return null;
  } finally {
    // Close the dedicated session on every path (acquired, not acquired,
    // thrown, returned) — the xact lock is already gone with the transaction
    // that carried it; `$disconnect` guarantees no idle lock connection
    // lingers between ticks.
    if (lock) {
      try {
        await lock.end();
      } catch (error) {
        console.error(`${SCHEDULER_LOG_PREFIX} lock connection close failed: ${describeError(error)}`);
      }
    }
  }
}

/**
 * One scheduler tick: guard against in-process overlap, take the scheduler
 * advisory lock via {@link withSchedulerLock}, and run all jobs under a
 * cancellable deadline while the lock is held. Each job is isolated so a
 * failure cannot abort the others; the pinned lock transaction (and with it
 * the advisory lock) is released only when every job has settled — a job
 * that outlives SCHEDULER_TICK_TIMEOUT_MS keeps the lock (and the in-process
 * guard) until it actually finishes, so neither a later tick nor another
 * replica can run concurrently with live work (M9, finding 7). The in-flight
 * guard is cleared in `finally`, i.e. strictly after the lock run completed
 * and the lock was released.
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