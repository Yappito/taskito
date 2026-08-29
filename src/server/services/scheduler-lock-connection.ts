import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Dedicated Postgres connection for the scheduler's session-scoped advisory
 * lock (codex_sol wave-6 findings 7 & 8).
 *
 * The scheduler must hold its cross-replica exclusion for the whole duration
 * of a run, but it must not do so through the machinery the previous design
 * used:
 *
 *  - a transaction-scoped lock (`pg_try_advisory_xact_lock` inside an
 *    interactive `$transaction`) dies with its transaction. Whenever Prisma
 *    expires/aborts that transaction, Postgres releases the advisory lock
 *    immediately, and because every replica has its own process-global
 *    in-flight flag, ANOTHER replica can then acquire the freed DB lock and
 *    run the same jobs while the original work is still live (finding 7).
 *
 *  - holding any interactive transaction for the entire run parks one pooled
 *    connection on the SHARED pool while all jobs issue their queries through
 *    that same global pool — a 1-connection pool self-deadlocks (the tx waits
 *    for the jobs, the jobs wait for the connection the tx holds) and under
 *    load it removes one scarce connection for the whole tick (finding 8).
 *
 * The fix is a SESSION-scoped advisory lock (`pg_try_advisory_lock`, no
 * `_xact_` suffix) taken on a connection this module creates explicitly and
 * whose lifetime the scheduler controls:
 *
 *  - The lock client is a private {@link PrismaClient} with a single-connection
 *    pool (`connection_limit=1`). It is NOT the global client, so no job can
 *    ever wait on the connection that holds the lock, and the lock can never
 *    be pinned onto a connection the jobs need (finding 8).
 *  - The session lock survives any transaction churn: only
 *    {@link SchedulerLockConnection.releaseAdvisoryLock} on the SAME
 *    connection, or the death of the connection/process, ends it (finding 7).
 *
 * `pg` (node-postgres) is not part of this app's dependency tree, so the
 * dedicated connection is a per-acquisition PrismaClient instance configured
 * with `connection_limit=1` whose lifetime is owned here (a fresh instance
 * per lock run, `$disconnect`ed in the release path — no idle connections
 * linger between ticks).
 */

/**
 * Contract the lock connection must fulfil. `tryAdvisoryLock` MUST run
 * `pg_try_advisory_lock` (session-scoped) on a connection that is
 * exclusively ours, and `releaseAdvisoryLock` MUST go to that SAME
 * connection — Postgres session locks are unlocked per session.
 */
export interface SchedulerLockConnection {
  /**
   * Attempts to take the session-scoped advisory lock. Resolves `true` when
   * this session now holds it, `false` when another live session (another
   * replica, another tick) already holds it.
   */
  tryAdvisoryLock(key: number): Promise<boolean>;

  /** Releases the session lock. Must run on the acquiring connection. */
  releaseAdvisoryLock(key: number): Promise<void>;

  /**
   * Closes the dedicated connection. Closing the session also drops the lock
   * server-side (process death is a safe fallback for the same reason).
   */
  end(): Promise<void>;
}

/**
 * Builds the datasource URL for the dedicated lock client: the app's
 * DATABASE_URL pinned to a single pooled connection so the lock query and the
 * unlock always run on the same physical Postgres session, and so the lock
 * never competes for (or occupies) a connection from the shared global pool.
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
 * Creates one dedicated lock connection. The returned object owns exactly ONE
 * Postgres session (its own PrismaClient pool with connection_limit=1) which
 * is used for nothing except the advisory lock/unlock pair — jobs keep
 * running on the global prisma client and can never wait on this connection.
 */
export function createSchedulerLockConnection(): SchedulerLockConnection {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured; cannot open the scheduler lock connection");
  }
  const client = new PrismaClient({ datasourceUrl: buildSingleSessionDatabaseUrl(databaseUrl) });

  return {
    async tryAdvisoryLock(key: number): Promise<boolean> {
      // SESSION-scoped on purpose: survives any transactional churn inside
      // the run and is only dropped by pg_advisory_unlock on this connection
      // or by the session closing.
      const rows = ((await client.$queryRaw(
        Prisma.sql`SELECT pg_try_advisory_lock(${key}) AS locked`,
      )) ?? []) as Array<{ locked?: unknown }>;
      return rows[0]?.locked === true;
    },

    async releaseAdvisoryLock(key: number): Promise<void> {
      // Same dedicated client => same single-pool session that acquired the
      // lock; pg_advisory_unlock is a no-op if the session no longer holds it.
      await client.$queryRaw(Prisma.sql`SELECT pg_advisory_unlock(${key})`);
    },

    async end(): Promise<void> {
      await client.$disconnect();
    },
  };
}