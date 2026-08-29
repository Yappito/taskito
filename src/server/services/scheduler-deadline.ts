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