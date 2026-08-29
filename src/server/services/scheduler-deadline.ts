/**
 * Shared helper for scheduler-driven work (built-in tick, cron endpoint,
 * manual "process due" procedures): a job cooperatively stops at the tick's
 * deadline by checking an `AbortSignal` between units of work (per rule, per
 * project, per page). Throwing unwinds the job cleanly, the scheduler run settles, and the
 * session-scoped advisory lock on its dedicated lock connection is released
 * promptly (an unlock+close in `finally`, and a dead process drops the lock
 * with its session regardless).
 *
 * This lives in its own module (rather than scheduler.ts) because the
 * processors import it and the scheduler imports the processors; a cycle
 * through scheduler.ts would still work, but a leaf module keeps the graph
 * obvious.
 */
export class TickDeadlineExceededError extends Error {
  constructor(message = "scheduler tick deadline exceeded") {
    super(message);
    this.name = "TickDeadlineExceededError";
  }
}

/** Throws {@link TickDeadlineExceededError} when the given signal is aborted. */
export function assertTickAlive(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new TickDeadlineExceededError();
  }
}

// ---------------------------------------------------------------------------
// Tick deadline configuration (shared by scheduler.ts and the scheduler lock
// connection, which must floor its lock-transaction timeout above the tick
// budget — see scheduler-lock-connection.ts, wave-9 finding 2).
// ---------------------------------------------------------------------------

/** Default per-tick work budget (`SCHEDULER_TICK_TIMEOUT_MS`, 10 minutes). */
export const DEFAULT_TICK_TIMEOUT_MS = 600_000;

/**
 * Safety margin added to the tick budget when flooring the scheduler lock
 * transaction timeout: the pinned lock transaction must NEVER expire before
 * the tick deadline could have stopped the jobs, or Prisma would release the
 * advisory lock (and the cross-replica exclusion) while work is still live.
 */
export const SCHEDULER_LOCK_TX_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Per-tick work budget (`SCHEDULER_TICK_TIMEOUT_MS`, default 10 minutes).
 * Jobs are cancelled BETWEEN units of work (per rule, per recipient, per
 * delivery — via {@link assertTickAlive}) when the budget is exceeded.
 */
export function getSchedulerTickTimeoutMs(): number {
  const parsed = Number(process.env.SCHEDULER_TICK_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  if (process.env.SCHEDULER_TICK_TIMEOUT_MS) {
    console.warn(
      `[scheduler] invalid SCHEDULER_TICK_TIMEOUT_MS "${process.env.SCHEDULER_TICK_TIMEOUT_MS}", using ${DEFAULT_TICK_TIMEOUT_MS}ms`,
    );
  }
  return DEFAULT_TICK_TIMEOUT_MS;
}