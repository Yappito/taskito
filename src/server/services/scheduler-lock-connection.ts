import { Prisma, PrismaClient } from "@prisma/client";

import {
  getSchedulerTickTimeoutMs,
  SCHEDULER_LOCK_TX_SAFETY_MARGIN_MS,
} from "./scheduler-deadline";

/**
 * Dedicated Postgres connection + session pin for the scheduler's advisory
 * lock (codex_sol wave-6 findings 7 & 8, wave-8 finding 2).
 *
 * The scheduler must hold its cross-replica exclusion for the whole duration
 * of a run, and that exclusion must survive the Prisma connection pool's
 * idle-retirement (an idle pooled connection's backend session can be reaped
 * — Prisma pools retire idle connections after their `idle_timeout`, 300s by
 * default, which is far below a 600s tick) and a transaction-pooler
 * DATABASE_URL (pgbouncer's transaction mode only guarantees a backend
 * BETWEEN `BEGIN` and `COMMIT`/`ROLLBACK` of one transaction).
 *
 * Why the two earlier designs fall short:
 *
 *  - A transaction-scoped lock (`pg_try_advisory_xact_lock`) taken and the
 *    transaction closed, with the work running afterwards, is worthless: the
 *    lock dies with its transaction. Prisma/Postgres release the advisory
 *    lock immediately, and because every replica has its own process-global
 *    in-flight flag, ANOTHER replica can then acquire the freed DB lock and
 *    run the same jobs while the original work is still live (finding 7).
 *
 *  - An independent `pg_try_advisory_lock` / `pg_advisory_unlock` pair (two
 *    separate pooled queries on a `connection_limit=1` client) pins the lock
 *    to a SESSION — but between the two calls the connection sits IDLE in the
 *    Prisma pool. Context: the pool may retire that idle physical
 *    connection (ending the session, silently dropping the advisory lock
 *    while jobs are live), and under pgbouncer the two queries can land on
 *    DIFFERENT backends, so the unlock runs on a session that never held the
 *    lock and the acquiring session's lock only dies with its reaped
 *    connection (wave-8 finding 2).
 *
 *  - Holding any interactive transaction for the entire run on the SHARED
 *    pool parks one pooled connection while all jobs issue their queries
 *    through that same pool — a 1-connection pool self-deadlocks (the tx
 *    waits for the jobs, the jobs wait for the connection the tx holds) and
 *    under load it removes one scarce connection for the whole tick
 *    (finding 8).
 *
 * The fix pins ONE physical session for the WHOLE run by making the lock and
 * the work-await live inside a SINGLE transaction on a single backend:
 *
 *  - The lock client is a private {@link PrismaClient} with a single-connection
 *    pool (`connection_limit=1`). It is NOT the global client, so no job can
 *    ever wait on the connection that holds the lock, and the lock can never
 *    be pinned onto a connection the jobs need (finding 8).
 *
 *  - `{@linkcode SchedulerLockConnection.runExclusive}` opens ONE interactive
 *    `$transaction` on that client and takes the TRANSACTION-scoped advisory
 *    lock (`pg_try_advisory_xact_lock`) inside it. The scheduler callback is
 *    awaited INSIDE that same transaction callback — i.e. between
 *    `pg_try_advisory_xact_lock` and the lock's release there is no gap, no
 *    second query round-trip, and no moment where the connection returns to
 *    the pool. The backend is continuously pinned (open transaction) while
 *    jobs run, so pool idle-retirement cannot reap it, and pgbouncer keeps
 *    the SAME backend for the whole transaction. The lock releases exactly
 *    when the transaction ends (commit after the callback settles, rollback
 *    if the callback throws, or connection/session death mid-run — Postgres
 *    aborts the transaction and drops xact locks in every case).
 *
 *  - The dedicated client's transaction timeout is configured far above a
 *    normal run (`SCHEDULER_LOCK_TX_TIMEOUT_MS`, default 24h) so the
 *    transaction cannot expire mid-run — and it is CLAMPED (wave-9 finding 2)
 *    to never fall below the tick budget + a safety margin: an operator who
 *    sets `SCHEDULER_LOCK_TX_TIMEOUT_MS` below
 *    `SCHEDULER_TICK_TIMEOUT_MS` would otherwise arm Prisma to release the
 *    advisory lock (and the cross-replica exclusion) while a digest, webhook
 *    sweep, or recurrence batch is still running. The configured value is
 *    raised to `getSchedulerTickTimeoutMs() +
 *    SCHEDULER_LOCK_TX_SAFETY_MARGIN_MS` with a logged warning. The tick
 *    deadline handed to jobs stays separate and unchanged. Jobs run on the
 *    GLOBAL prisma client — never on the lock transaction — which keeps the
 *    wave-6 finding 8 guarantee (the dedicated pool's single connection
 *    serves nothing but the lock transaction itself).
 *
 * `pg` (node-postgres) is not part of this app's dependency tree, so the
 * dedicated connection is a per-acquisition PrismaClient instance whose
 * lifetime is owned here (a fresh instance per lock run, `$disconnect`ed in
 * the release path — no idle connections linger between ticks).
 */

/** Default lifetime for the pinned lock transaction (24h). */
export const DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Timeout for the pinned lock transaction (`SCHEDULER_LOCK_TX_TIMEOUT_MS`,
 * default 86400000 = 24h, minimum 60s). It must comfortably exceed the
 * longest possible scheduler run (the tick budget `SCHEDULER_TICK_TIMEOUT_MS`
 * + job overrun) because the scheduler callback is awaited inside the
 * transaction; Prisma would otherwise abort the transaction — and the lock
 * with it — mid-run. Wave-9 finding 2: the value is CLAMPED so it can NEVER
 * be configured below the tick budget plus
 * {@linkcode SCHEDULER_LOCK_TX_SAFETY_MARGIN_MS} — a too-low setting is
 * raised with a logged warning instead of silently arming the lock to be
 * released while the tick's jobs are still live (a digest job locking up a
 * few hours would otherwise free the lock for another replica mid-run).
 * The advisory lock itself is a best-effort cross-replica optimization:
 * durable per-job idempotency (recurrence CAS/txn, digest claims, automation
 * firings, webhook delivery leases + claim tokens) remains the
 * authoritative exactly-once boundary.
 */
export function schedulerLockTransactionTimeoutMs(): number {
  // The lock must never expire before the tick deadline could stop the jobs:
  // floor = tick budget + safety margin.
  const floorMs = getSchedulerTickTimeoutMs() + SCHEDULER_LOCK_TX_SAFETY_MARGIN_MS;
  const parsed = Number(process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed >= 60_000) {
    const configured = Math.floor(parsed);
    if (configured < floorMs) {
      console.warn(
        `[scheduler-lock] SCHEDULER_LOCK_TX_TIMEOUT_MS (${configured}ms) is below the tick deadline + safety margin (${floorMs}ms); raising it to ${floorMs}ms so the advisory lock can never be released before the tick deadline can stop the jobs`,
      );
      return floorMs;
    }
    return configured;
  }
  if (process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS) {
    console.warn(
      `[scheduler-lock] invalid SCHEDULER_LOCK_TX_TIMEOUT_MS "${process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS}", using the default or the tick-based floor, whichever is higher`,
    );
  }
  return Math.max(DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS, floorMs);
}

/**
 * Builds the datasource URL for the dedicated lock client: the app's
 * DATABASE_URL pinned to a single pooled connection. The client's pool serves
 * nothing but the ONE lock transaction, so pinning a single connection both
 * prevents the lock from ever occupying a shared-pool connection the jobs
 * need, and keeps other client activity from landing on the pinned backend.
 */
export function buildSingleSessionDatabaseUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      "DATABASE_URL is not a parsable URL; cannot configure the single-connection scheduler lock client",
    );
  }
  url.searchParams.set("connection_limit", "1");
  return url.toString();
}

/**
 * Contract the lock connection must fulfil: {@linkcode runExclusive} holds
 * the advisory lock inside ONE interactive transaction on this dedicated
 * client for the WHOLE callback — the try-lock query runs inside the
 * transaction, the callback is awaited while the transaction (and backend)
 * stay open, and the lock is released only when that transaction ends.
 */
export interface SchedulerLockConnection {
  /**
   * Attempts to take the transaction-scoped advisory lock (`key`) inside one
   * long-lived interactive transaction and, when acquired, awaits `fn` while
   * that transaction is open — the lock is therefore pinned to this one
   * physical session until `fn` settles and the transaction commits.
   *
   * Resolves `fn`'s result, or `null` when another live session (another
   * replica, another tick) already holds the lock — in that case `fn` never
   * runs and the (empty) transaction ends immediately. The lock is released
   * in EVERY case: callback settled → commit, callback threw → rollback,
   * connection/process death → server-side transaction abort. A commit
   * failure AFTER `fn` settled is logged and the result is still returned
   * (the work ran, and the transaction abort released the lock server-side).
   */
  runExclusive<T>(key: number, fn: () => Promise<T>): Promise<T | null>;

  /**
   * Closes the dedicated client. Closing kills the physical session; Postgres
   * releases any transaction still open on it (process death is a safe
   * fallback for the same reason).
   */
  end(): Promise<void>;
}

/**
 * Creates one dedicated lock connection. The returned object owns exactly ONE
 * Postgres session (its own PrismaClient pool with connection_limit=1) which
 * is used for nothing except the pinned lock transaction — jobs keep running
 * on the global prisma client and can never wait on this connection.
 */
export function createSchedulerLockConnection(): SchedulerLockConnection {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured; cannot open the scheduler lock connection");
  }
  const client = new PrismaClient({ datasourceUrl: buildSingleSessionDatabaseUrl(databaseUrl) });

  return {
    async runExclusive<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
      const txTimeoutMs = schedulerLockTransactionTimeoutMs();
      // The callback's settled state and result, tracked so a failure raised
      // while ENDING the transaction (Prisma rejects the $transaction promise
      // when the COMMIT itself fails) still returns the work's result instead
      // of discarding it.
      let callbackResult: T | undefined;
      let callbackSucceeded = false;

      try {
        return await client.$transaction(
          async (tx) => {
            // Transaction-scoped advisory lock: it is bound to THIS
            // transaction/backend and releases exactly when the transaction
            // ends — commit (after `fn` settles), rollback, or connection
            // death. Because `fn` is awaited inside the SAME transaction
            // callback, the acquiring backend is pinned (open transaction)
            // for the whole run: the pool cannot retire it as idle, and a
            // transaction-pooler keeps the same backend until COMMIT.
            const rows = ((await tx.$queryRaw(
              Prisma.sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`,
            )) ?? []) as Array<{ locked?: unknown }>;
            if (rows[0]?.locked !== true) {
              // Another live session holds the lock. Return immediately: the
              // (empty) transaction ends — and the shared lock was never
              // touched by us.
              return null;
            }

            // The scheduler callback runs ON THE GLOBAL CLIENT, not on `tx` —
            // its queries never touch (or wait on) this transaction's
            // connection. Awaiting it here is exactly what keeps the
            // transaction (and the xact lock) open until the run settles.
            const result = await fn();
            callbackSucceeded = true;
            callbackResult = result;
            return result;
          },
          {
            // Far above any sane run length so Prisma never expires the
            // pinned transaction (and the lock) mid-run.
            timeout: txTimeoutMs,
          },
        );
      } catch (error) {
        if (callbackSucceeded) {
          // `fn` settled fine; the failure came from ENDING the transaction
          // (e.g. the connection was dropped between the last statement and
          // COMMIT). The run's work is unaffected (it ran on the global
          // client), the transaction abort released the lock server-side, and
          // the caller should still see its result — mirror the old
          // "unlock failure is logged" contract.
          console.error(
            `[scheduler-lock] ending the lock transaction after a settled run failed (lock released by the transaction abort): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return callbackResult as T;
        }
        throw error;
      }
    },

    async end(): Promise<void> {
      await client.$disconnect();
    },
  };
}