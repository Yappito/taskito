import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  processDueRecurrences,
  processDueDateAutomationRules,
  runDailyDigestJob,
  recordSprintSnapshots,
  processDueWebhookDeliveries,
  prismaMock,
  fakePg,
  createSchedulerLockConnection,
} = vi.hoisted(() => {
  type FakeLockConnection = {
    id: number;
    live: boolean;
    /** How many interactive `$transaction` calls this session opened. */
    txCalls: number;
    /** Advisory keys whose xact lock were attempted, in order. */
    tryKeys: number[];
    runExclusive: <T>(key: number, fn: () => Promise<T>) => Promise<T | null>;
    end: () => Promise<void>;
  };

  // A tiny fake of Postgres advisory locks bound to OPEN TRANSACTIONS. Every
  // dedicated lock connection handed out below is an independent SESSION
  // (exactly like a second replica would open its own), yet all sessions
  // share one advisory lock space. A transaction-scoped lock is held exactly
  // as long as the transaction that took it: the fake models that with
  // `openTx` (sessions with a transaction still running) — the lock exists
  // only while it is held WITH an open transaction, and both vanish together
  // when the transaction ends (commit/rollback) or the session dies.
  const server = {
    held: new Map<number, number>(), // advisory key -> owning session id (only while its tx is open)
    openTx: new Map<number, number>(), // session id -> advisory key of its open transaction
    connections: [] as FakeLockConnection[],
    events: [] as string[],
    nextSessionId: 0,
    tryLockError: undefined as Error | undefined,
    commitError: undefined as Error | undefined,
    factoryError: undefined as Error | undefined,
  };

  function open(): FakeLockConnection {
    const connection: FakeLockConnection = {
      id: server.nextSessionId++,
      live: true,
      txCalls: 0,
      tryKeys: [],
      async runExclusive<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
        if (!connection.live) throw new Error("lock connection is closed");
        connection.txCalls += 1;
        // ONE interactive transaction opens; the xact try-lock, the awaited
        // callback, and the implicit commit/rollback all live inside it.
        server.events.push(`tx:${connection.id}`);
        server.openTx.set(connection.id, key);
        const endTx = () => {
          // The xact lock dies with the transaction — and the transaction is
          // no longer open — in EVERY outcome (commit, rollback, crash).
          if (server.held.get(key) === connection.id) {
            server.held.delete(key);
          }
          server.openTx.delete(connection.id);
        };
        try {
          if (server.tryLockError) {
            server.events.push(`rollback:${connection.id}`);
            throw server.tryLockError;
          }
          server.events.push(`try:${connection.id}`);
          connection.tryKeys.push(key);
          if (server.held.has(key)) {
            // Another live session's open transaction owns the lock: nothing
            // happens, the (empty) transaction ends immediately.
            endTx();
            return null;
          }
          server.held.set(key, connection.id);
          let result: T;
          try {
            result = await fn();
          } catch (caught) {
            // Rollback: the callback failed, the transaction aborts, the xact
            // lock releases with it — and the failure surfaces to the caller.
            server.events.push(`rollback:${connection.id}`);
            endTx();
            throw caught;
          }
          if (server.commitError) {
            // COMMIT failed after the run settled: the transaction aborts,
            // releasing the xact lock; the work already ran on the global
            // client. The real lock module logs this and still returns the
            // settled result — mirror that here.
            server.events.push(`commit-failed:${connection.id}`);
            endTx();
            return result;
          }
          server.events.push(`commit:${connection.id}`);
          endTx();
          return result;
        } finally {
          endTx();
        }
      },
      async end() {
        server.events.push(`end:${connection.id}`);
        connection.live = false;
        // A dropped session aborts its open transaction, releasing the lock.
        for (const [key, owner] of [...server.held]) {
          if (owner === connection.id) {
            server.held.delete(key);
          }
        }
        server.openTx.delete(connection.id);
      },
    };
    server.connections.push(connection);
    server.events.push(`open:${connection.id}`);
    return connection;
  }

  const fakePg = {
    server,
    open,
    reset() {
      server.held.clear();
      server.openTx.clear();
      server.connections = [];
      server.events = [];
      server.nextSessionId = 0;
      server.tryLockError = undefined;
      server.commitError = undefined;
      server.factoryError = undefined;
    },
    isHeld(key: number) {
      return server.held.has(key);
    },
    /** True while the session's transaction (and therefore its xact lock) is open. */
    txOpenOn(sessionId: number) {
      return server.openTx.has(sessionId);
    },
  };

  return {
    processDueRecurrences: vi.fn(),
    processDueDateAutomationRules: vi.fn(),
    runDailyDigestJob: vi.fn(),
    recordSprintSnapshots: vi.fn(),
    processDueWebhookDeliveries: vi.fn(),
    prismaMock: {
      // The global (shared-pool) client. The scheduler lock must NEVER touch
      // it: the dedicated lock connection is a separate client, so jobs never
      // wait on the connection that holds the lock (finding 8).
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
    },
    fakePg,
    createSchedulerLockConnection: vi.fn(() => {
      if (server.factoryError) {
        throw server.factoryError;
      }
      return fakePg.open();
    }),
  };
});

vi.mock("@/server/services/recurrence-processor", () => ({
  processDueRecurrences,
}));

vi.mock("@/server/services/automation-evaluator", () => ({
  processDueDateAutomationRules,
}));

vi.mock("@/server/services/sprint-snapshot", () => ({
  recordSprintSnapshots,
}));

vi.mock("@/server/services/webhooks/dispatcher", () => ({
  processDueWebhookDeliveries,
}));

vi.mock("@/server/services/email/digest", () => ({
  runDailyDigestJob,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/server/services/scheduler-lock-connection", () => ({
  createSchedulerLockConnection,
}));

import {
  SCHEDULER_ADVISORY_LOCK_KEY,
  getSchedulerDigestHourUtc,
  getSchedulerIntervalMs,
  isSchedulerEnabled,
  runScheduledJobs,
  startScheduler,
  stopScheduler,
  withSchedulerLock,
} from "@/server/services/scheduler";
import { TickDeadlineExceededError } from "@/server/services/scheduler-deadline";

const NOW = new Date("2026-05-19T09:00:00.000Z");
const INTERVAL_MS = 60_000;

function connections() {
  return fakePg.server.connections;
}

function eventIndex(event: string) {
  return fakePg.server.events.indexOf(event);
}

describe("scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    process.env.SCHEDULER_ENABLED = "true";
    delete process.env.SCHEDULER_INTERVAL_MS;
    delete process.env.SCHEDULER_TICK_TIMEOUT_MS;
    delete process.env.SCHEDULER_DIGEST_HOUR_UTC;
    fakePg.reset();

    processDueRecurrences.mockImplementation(async () => {
      fakePg.server.events.push("job:recurrence");
      return { processed: 0, createdTaskIds: [] };
    });
    processDueDateAutomationRules.mockImplementation(async () => {
      fakePg.server.events.push("job:automation");
      return { processed: 0, fired: 0, skippedRules: 0 };
    });
    runDailyDigestJob.mockImplementation(async () => {
      fakePg.server.events.push("job:digest");
      return { sent: 0, skipped: 0 };
    });
    recordSprintSnapshots.mockImplementation(async () => {
      fakePg.server.events.push("job:snapshot");
      return 0;
    });
    processDueWebhookDeliveries.mockImplementation(async () => {
      fakePg.server.events.push("job:webhooks");
      return { processed: 0, succeeded: 0 };
    });
    stopScheduler();
  });

  afterEach(() => {
    stopScheduler();
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.SCHEDULER_INTERVAL_MS;
    delete process.env.SCHEDULER_TICK_TIMEOUT_MS;
    delete process.env.SCHEDULER_DIGEST_HOUR_UTC;
    vi.useRealTimers();
  });

  describe("runScheduledJobs", () => {
    it("takes the advisory lock in a pinned transaction on a dedicated connection and runs all jobs once", async () => {
      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      // Exactly one dedicated lock connection; the lock never touches the
      // shared global client/pool the jobs use (finding 8).
      expect(connections()).toHaveLength(1);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
      expect(prismaMock.$executeRaw).not.toHaveBeenCalled();

      const connection = connections()[0];
      expect(connection.tryKeys).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
      // The lock lived inside exactly ONE pinned transaction on that
      // dedicated session, and it was released (commit) only after the run
      // settled — then the connection was closed.
      expect(connection.txCalls).toBe(1);
      expect(eventIndex("commit:0")).toBeGreaterThan(eventIndex("job:webhooks"));
      expect(fakePg.server.openTx.size).toBe(0);
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(false);
      expect(connection.live).toBe(false);

      // M9/M8 unchanged: every job receives the tick's cancellable deadline
      // signal and runs on the global prisma client.
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      const recurrenceArgs = processDueRecurrences.mock.calls[0];
      expect(recurrenceArgs[0]).toBe(prismaMock);
      expect(recurrenceArgs[1].limit).toBe(100);
      expect(recurrenceArgs[1].signal).toBeInstanceOf(AbortSignal);
      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules.mock.calls[0][0]).toBe(prismaMock);
      expect(processDueDateAutomationRules.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      // Digest ticks at 09:00 UTC are past the default SCHEDULER_DIGEST_HOUR_UTC of 7.
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob.mock.calls[0][0]).toEqual(NOW);
      expect(recordSprintSnapshots).toHaveBeenCalledTimes(1);
      expect(processDueWebhookDeliveries).toHaveBeenCalledTimes(1);
      expect(processDueWebhookDeliveries.mock.calls[0][0]).toBe(prismaMock);
      expect(processDueWebhookDeliveries.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
    });

    it("refuses a second concurrent acquisition (simulating another replica) and only grants it after the first run settles", async () => {
      let releaseFirstWork: () => void = () => {};
      const firstRun = withSchedulerLock(async () => {
        fakePg.server.events.push("first-work");
        await new Promise<void>((resolve) => {
          releaseFirstWork = resolve;
        });
        fakePg.server.events.push("first-work-done");
        return "first";
      });
      await vi.advanceTimersByTimeAsync(0); // let the first run acquire the lock

      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(true);

      // A second run on its OWN dedicated session — the cross-replica case:
      // a different process has a different connection, so only the shared
      // DB lock can arbitrate.
      const secondRun = withSchedulerLock(async () => {
        fakePg.server.events.push("second-work");
        return "second";
      });
      await expect(secondRun).resolves.toBeNull();
      expect(fakePg.server.connections).toHaveLength(2);
      expect(fakePg.server.connections[1].tryKeys).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
      expect(fakePg.server.connections[1].txCalls).toBe(1);
      expect(fakePg.server.connections[1].live).toBe(false);
      // The refused run must NOT have executed its work, and the lock must
      // still be held by the first session (inside its pinned transaction).
      expect(fakePg.server.events).not.toContain("second-work");
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(true);
      expect(fakePg.txOpenOn(0)).toBe(true);

      // Only when the first run's work settles is the transaction committed —
      // strictly after the work finished (commit:0 follows first-work-done),
      // and the commit is what releases the lock.
      releaseFirstWork();
      await expect(firstRun).resolves.toBe("first");
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(false);
      expect(eventIndex("commit:0")).toBeGreaterThan(eventIndex("first-work-done"));
      expect(fakePg.server.events).toContain("end:0");

      // With the lock free again, a later acquisition succeeds.
      await expect(withSchedulerLock(async () => "third")).resolves.toBe("third");
      expect(fakePg.server.connections).toHaveLength(3);
    });

    it("keeps the pinned lock transaction open while a job outlives the tick deadline; the next tick runs only after the run settles", async () => {
      const tickTimeoutMs = 1_000;
      process.env.SCHEDULER_TICK_TIMEOUT_MS = String(tickTimeoutMs);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      let pendingJobs = 0;
      let releaseFirstJob: () => void = () => {};
      processDueRecurrences.mockImplementation(() => {
        pendingJobs += 1;
        if (pendingJobs === 1) {
          // The first run's recurrence job outlives the tick deadline; only
          // the test can finish it.
          return new Promise<void>((resolve) => {
            releaseFirstJob = resolve;
          });
        }
        fakePg.server.events.push("job:recurrence");
        return Promise.resolve({ processed: 0, createdTaskIds: [] });
      });

      const firstTick = runScheduledJobs();
      // Advance well past SCHEDULER_TICK_TIMEOUT_MS: the deadline signal is
      // aborted while the job keeps running (deadline and lock are independent).
      await vi.advanceTimersByTimeAsync(tickTimeoutMs + 500);

      let firstSettled = false;
      void firstTick.then(() => {
        firstSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(firstSettled).toBe(false);
      expect(pendingJobs).toBe(1);
      // The dedicated session's pinned transaction still holds the advisory
      // lock while the job is live, so another replica could not run jobs
      // either.
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(true);
      expect(fakePg.txOpenOn(0)).toBe(true);

      // A second tick cannot start while the first run is live.
      expect(await runScheduledJobs()).toEqual({ ran: false });
      expect(pendingJobs).toBe(1);
      // FINDING 8 + WAVE-8 PIN: while the long job runs, the dedicated lock
      // connection has opened exactly ONE transaction (the one carrying the
      // xact lock; its COMMIT strictly waits for the run to settle), no other
      // lock connection was opened, and the global shared pool was never
      // touched by the lock machinery — jobs keep every shared-pool
      // connection for themselves.
      expect(connections()).toHaveLength(1);
      expect(connections()[0].tryKeys).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
      expect(connections()[0].txCalls).toBe(1);
      expect(eventIndex("commit:0")).toBe(-1);
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();

      // Once the long-running job finishes, the first tick settles, the
      // transaction commits (releasing the lock), and the connection closes.
      // Note: fake timers do not fire AbortSignal.timeout, so the first
      // tick's remaining jobs simply complete normally after the release
      // (they are never observed by another replica because the pinned
      // transaction held the lock throughout).
      releaseFirstJob();
      await firstTick;
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(false);
      const firstConnection = connections()[0];
      expect(eventIndex("commit:0")).toBeGreaterThan(eventIndex("job:recurrence"));
      expect(firstConnection.live).toBe(false);
      expect(fakePg.txOpenOn(0)).toBe(false);

      const thirdResult = await runScheduledJobs();
      expect(thirdResult).toEqual({ ran: true });
      expect(pendingJobs).toBe(2);
      warnSpy.mockRestore();
    });

    it("skips the tick when another session/replica holds the lock", async () => {
      // Simulate a lock taken by a DIFFERENT process (session id 999) inside
      // its own open transaction.
      fakePg.server.held.set(SCHEDULER_ADVISORY_LOCK_KEY, 999);

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(connections()).toHaveLength(1);
      const connection = connections()[0];
      expect(connection.tryKeys).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
      // Not acquired: the empty transaction ended without a commit of ours,
      // and the dedicated connection is still closed (no leaked sessions
      // between ticks).
      expect(connection.txCalls).toBe(1);
      expect(fakePg.server.events).not.toContain("commit:0");
      expect(connection.live).toBe(false);
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
      expect(recordSprintSnapshots).not.toHaveBeenCalled();
      expect(processDueWebhookDeliveries).not.toHaveBeenCalled();
    });

    it("skips the tick when the lock connection cannot be created", async () => {
      fakePg.server.factoryError = new Error("no database url");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] lock acquisition aborted"));
      errorSpy.mockRestore();
    });

    it("skips the tick when the lock transaction fails and still closes the dedicated connection", async () => {
      fakePg.server.tryLockError = new Error("database unavailable");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
      expect(connections()).toHaveLength(1);
      expect(fakePg.server.events).not.toContain("commit:0");
      expect(connections()[0].live).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] lock acquisition aborted"));
      errorSpy.mockRestore();
    });

    it("skips a tick while the previous tick's promise is still in flight (M9)", async () => {
      let releaseFirstTick: (() => void) | undefined;
      processDueRecurrences.mockImplementation(
        () => new Promise<void>((resolve) => {
          releaseFirstTick = resolve;
        }),
      );

      const firstTick = runScheduledJobs();
      const secondTick = runScheduledJobs();

      // Give the second tick a chance to observe the in-flight marker.
      await vi.advanceTimersByTimeAsync(0);

      const secondResult = await secondTick;
      expect(secondResult).toEqual({ ran: false });
      // The first tick is still the only one running jobs, and the in-flight
      // guard means no second lock connection was even opened.
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(connections()).toHaveLength(1);

      releaseFirstTick?.();
      expect(await firstTick).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);

      // Once the first tick finished, the next tick runs again.
      processDueRecurrences.mockResolvedValue({ processed: 0, createdTaskIds: [] });
      const thirdTick = await runScheduledJobs();
      expect(thirdTick).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(2);
      expect(recordSprintSnapshots).toHaveBeenCalledTimes(2);
    });

    it("stops the remaining jobs when a job hits the tick deadline (M9)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      processDueRecurrences.mockRejectedValue(new TickDeadlineExceededError());

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tick exceeded SCHEDULER_TICK_TIMEOUT_MS"));
      warnSpy.mockRestore();
    });

    it("logs a warning when the deadline signal aborts mid-tick", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Simulate a job that outlived the deadline: the signal is aborted by the
      // time the next job checks it.
      processDueDateAutomationRules.mockImplementation(async (_client: unknown, options: { signal: AbortSignal }) => {
        // Simulate time passing beyond the deadline for the digest job.
        Object.defineProperty(options.signal, "aborted", { value: true });
      });

      await runScheduledJobs();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tick exceeded SCHEDULER_TICK_TIMEOUT_MS"));
      warnSpy.mockRestore();
    });

    // Wave-9 finding 2: the tick deadline must be THREADed into the digest
    // job (runDigestJob previously dropped it), so the digest is actually
    // cancellable at the tick deadline instead of running unboundedly.
    it("threads the tick deadline signal into the digest job (wave-9 finding 2)", async () => {
      let receivedSignal: AbortSignal | undefined;
      runDailyDigestJob.mockImplementation(async (_now: Date, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return { sent: 0, skipped: 0, retryable: 0 };
      });

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) });
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);
    });

    it("still runs due-date automation and the digest when the recurrence processor throws", async () => {
      processDueRecurrences.mockRejectedValue(new Error("recurrence exploded"));

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
      // The lock transaction still ends normally and the connection closes
      // after a failing job — the tick isolates job failures, so the run
      // settles (commit releases the xact lock) rather than throwing.
      expect(eventIndex("commit:0")).toBeGreaterThan(-1);
      expect(connections()[0].txCalls).toBe(1);
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(false);
      expect(connections()[0].live).toBe(false);
    });

    it("still runs recurrences and the digest when due-date automation throws", async () => {
      processDueDateAutomationRules.mockRejectedValue(new Error("automation exploded"));

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
    });

    it("still runs recurrences and due-date automation when the digest job throws", async () => {
      runDailyDigestJob.mockRejectedValue(new Error("digest exploded"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] scheduled job failed: digest exploded"));
      errorSpy.mockRestore();
    });

    it("runs the digest once the current UTC hour reaches SCHEDULER_DIGEST_HOUR_UTC", async () => {
      // NOW is 09:00 UTC; the default digest hour is 7, so earlier tests run it.
      process.env.SCHEDULER_DIGEST_HOUR_UTC = "9";

      await runScheduledJobs();

      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
    });

    it("does not run the digest before SCHEDULER_DIGEST_HOUR_UTC, but still runs the other jobs", async () => {
      process.env.SCHEDULER_DIGEST_HOUR_UTC = "10";

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(runDailyDigestJob).not.toHaveBeenCalled();
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);
    });

    it("supports hour 0 (digest runs all day) and hour 23 (digest runs late)", async () => {
      process.env.SCHEDULER_DIGEST_HOUR_UTC = "0";
      await runScheduledJobs();
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);

      runDailyDigestJob.mockClear();
      runDailyDigestJob.mockImplementation(async () => {
        fakePg.server.events.push("job:digest");
        return { sent: 0, skipped: 0 };
      });
      process.env.SCHEDULER_DIGEST_HOUR_UTC = "23";
      await runScheduledJobs();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
    });
  });

  describe("withSchedulerLock (external entry points)", () => {
    it("runs the callback and returns its result while holding the pinned lock transaction", async () => {
      const result = await withSchedulerLock(async () => "ran");

      expect(result).toBe("ran");
      expect(connections()).toHaveLength(1);
      expect(connections()[0].tryKeys).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
      expect(connections()[0].txCalls).toBe(1);
      expect(connections()[0].live).toBe(false);
    });

    it("never lets the callback run — and releases nothing — when the lock is held by another session", async () => {
      fakePg.server.held.set(SCHEDULER_ADVISORY_LOCK_KEY, 999);

      const result = await withSchedulerLock(async () => {
        throw new Error("must not run while another session holds the lock");
      });

      expect(result).toBeNull();
      const connection = connections()[0];
      expect(connection.tryKeys).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
      expect(connection.txCalls).toBe(1);
      expect(connection.live).toBe(false);
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(true);
      expect(fakePg.server.events).not.toContain("commit:0");
    });

    it("returns null (skip) when the lock connection cannot be created", async () => {
      fakePg.server.factoryError = new Error("database down");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await withSchedulerLock(async () => "never");

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] lock acquisition aborted"));
      errorSpy.mockRestore();
    });

    it("returns null (skip) when the lock transaction fails", async () => {
      fakePg.server.tryLockError = new Error("database unavailable");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await withSchedulerLock(async () => "never");

      expect(result).toBeNull();
      expect(connections()[0].txCalls).toBe(1);
      expect(connections()[0].live).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] lock acquisition aborted"));
      errorSpy.mockRestore();
    });

    it("treats a callback failure as a skip, but still rolls the transaction back and closes the connection", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await withSchedulerLock(async () => {
        throw new Error("job exploded");
      });

      // The lock helper never throws — callers treat null as "skip" so the
      // interval loop and the cron endpoint stay alive.
      expect(result).toBeNull();
      const connection = connections()[0];
      // The xact lock died with the rolled-back transaction.
      expect(fakePg.server.events).toContain("rollback:0");
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(false);
      expect(connection.live).toBe(false);
      expect(eventIndex("rollback:0")).toBeGreaterThan(eventIndex("open:0"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] lock acquisition aborted"));
      errorSpy.mockRestore();
    });

    it("keeps the run's result when the transaction COMMIT fails after the callback settled and still closes the session", async () => {
      fakePg.server.commitError = new Error("commit failed: connection dropped");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await withSchedulerLock(async () => "ran");

      // The run itself succeeded, so the lock connection returns the result
      // even though ending the transaction failed: the work already ran on
      // the global client, the transaction abort released the xact lock
      // server-side, and closing the dedicated session drops it regardless.
      expect(result).toBe("ran");
      expect(fakePg.server.events).toContain("commit-failed:0");
      expect(connections()[0].live).toBe(false);
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(false);
      // No skip was logged: the run settled fine.
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("[scheduler] lock acquisition aborted"));
      errorSpy.mockRestore();
    });

    it("pins ONE transaction for the whole callback: lock acquired inside it, callback settled inside it, released only after it settles", async () => {
      let pinStateDuringWork: { txCalls: number; txOpen: boolean; lockHeld: boolean } | null = null;

      const workRan = withSchedulerLock(async () => {
        fakePg.server.events.push("work");
        // While the callback runs, the lock transaction on our dedicated
        // session is still OPEN and it is the one holding the advisory lock:
        // there is no gap between acquire and work where the connection sits
        // idle in a pool (wave-8 finding 2's pin requirement).
        pinStateDuringWork = {
          txCalls: connections()[0].txCalls,
          txOpen: fakePg.txOpenOn(0),
          lockHeld: fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY) && !fakePg.isHeld(999),
        };
        return "ok";
      });

      await expect(workRan).resolves.toBe("ok");
      expect(pinStateDuringWork).toEqual({ txCalls: 1, txOpen: true, lockHeld: true });
      // Exactly ONE transaction carried the whole run — acquire and release
      // were never two separate pooled queries (mutating back to such a
      // design fails txOpen/txCalls assertions above).
      expect(connections()[0].txCalls).toBe(1);
      // Released (commit) strictly after the work, then the session closed.
      expect(eventIndex("work")).toBeGreaterThan(eventIndex("tx:0"));
      expect(eventIndex("commit:0")).toBeGreaterThan(eventIndex("work"));
      expect(eventIndex("end:0")).toBeGreaterThan(eventIndex("commit:0"));
      expect(fakePg.isHeld(SCHEDULER_ADVISORY_LOCK_KEY)).toBe(false);
      expect(fakePg.txOpenOn(0)).toBe(false);
    });

    it("orders: connection opened -> transaction -> try-lock -> work -> commit -> close, strictly", async () => {
      const workRan = withSchedulerLock(async () => {
        fakePg.server.events.push("work");
        return "ok";
      });

      await expect(workRan).resolves.toBe("ok");
      expect(eventIndex("try:0")).toBeGreaterThan(eventIndex("tx:0"));
      expect(eventIndex("tx:0")).toBeGreaterThan(eventIndex("open:0"));
      expect(eventIndex("work")).toBeGreaterThan(eventIndex("try:0"));
      expect(eventIndex("commit:0")).toBeGreaterThan(eventIndex("work"));
      expect(eventIndex("end:0")).toBeGreaterThan(eventIndex("commit:0"));
    });
  });

  describe("configuration", () => {
    it("is started by startScheduler and ticks on the configured interval", async () => {
      process.env.SCHEDULER_INTERVAL_MS = "1000";
      startScheduler();

      await vi.advanceTimersByTimeAsync(0);
      expect(connections()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(connections()).toHaveLength(1);
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(connections()).toHaveLength(2);
      expect(processDueRecurrences).toHaveBeenCalledTimes(2);
    });

    it("is idempotent under repeated startScheduler calls (hot reload)", async () => {
      startScheduler();
      startScheduler();
      startScheduler();

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);

      expect(connections()).toHaveLength(1);
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
    });

    it("does not schedule anything when SCHEDULER_ENABLED is false", async () => {
      process.env.SCHEDULER_ENABLED = "false";
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      startScheduler();

      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);

      expect(createSchedulerLockConnection).not.toHaveBeenCalled();
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(isSchedulerEnabled()).toBe(false);
      infoSpy.mockRestore();
    });

    it("defaults to enabled and to a 60000ms interval", () => {
      delete process.env.SCHEDULER_ENABLED;
      delete process.env.SCHEDULER_INTERVAL_MS;
      expect(isSchedulerEnabled()).toBe(true);
      expect(getSchedulerIntervalMs()).toBe(INTERVAL_MS);
    });

    it("clamps implausibly small intervals to 1000ms", () => {
      process.env.SCHEDULER_INTERVAL_MS = "5";
      expect(getSchedulerIntervalMs()).toBe(1000);
    });

    it("defaults the digest hour to 7 UTC and ignores invalid values", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      delete process.env.SCHEDULER_DIGEST_HOUR_UTC;
      expect(getSchedulerDigestHourUtc()).toBe(7);

      process.env.SCHEDULER_DIGEST_HOUR_UTC = "14";
      expect(getSchedulerDigestHourUtc()).toBe(14);

      process.env.SCHEDULER_DIGEST_HOUR_UTC = "0";
      expect(getSchedulerDigestHourUtc()).toBe(0);

      process.env.SCHEDULER_DIGEST_HOUR_UTC = "24";
      expect(getSchedulerDigestHourUtc()).toBe(7);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] invalid SCHEDULER_DIGEST_HOUR_UTC"));

      process.env.SCHEDULER_DIGEST_HOUR_UTC = "banana";
      expect(getSchedulerDigestHourUtc()).toBe(7);
      warnSpy.mockRestore();
    });

    it("picks up stopScheduler to clear the running timer", async () => {
      startScheduler();
      stopScheduler();

      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

      expect(connections()).toHaveLength(0);
    });
  });
});