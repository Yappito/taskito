import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  processDueRecurrences,
  processDueDateAutomationRules,
  runDailyDigestJob,
  recordSprintSnapshots,
  processDueWebhookDeliveries,
  prismaMock,
} = vi.hoisted(() => ({
  processDueRecurrences: vi.fn(),
  processDueDateAutomationRules: vi.fn(),
  runDailyDigestJob: vi.fn(),
  recordSprintSnapshots: vi.fn(),
  processDueWebhookDeliveries: vi.fn(),
  prismaMock: {
    $transaction: vi.fn(),
  },
}));

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
const DEFAULT_TICK_TIMEOUT_MS = 600_000;

// Stand-in for the interactive-transaction client Prisma hands to the callback.
// The advisory lock query runs on the tx connection; the jobs keep using the
// global prisma mock (prismaMock).
let txMock: { $queryRaw: ReturnType<typeof vi.fn> };

function sqlText(call: unknown[]) {
  const sql = call[0] as { sql?: string; text?: string; values?: unknown[] };
  const values = Array.from(sql.values ?? []).map((value) => String(value));
  return `${sql.text ?? sql.sql ?? String(call[0])} (${values.join(", ")})`;
}

function lockCalls() {
  return txMock.$queryRaw.mock.calls.filter((call) => sqlText(call).includes("pg_try_advisory_xact_lock"));
}

function transactionOptions() {
  return prismaMock.$transaction.mock.calls.at(-1)?.[1];
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

    txMock = { $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) };
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) => callback(txMock));
    processDueRecurrences.mockResolvedValue({ processed: 0, createdTaskIds: [] });
    processDueDateAutomationRules.mockResolvedValue({ processed: 0, fired: 0, skippedRules: 0 });
    runDailyDigestJob.mockResolvedValue({ sent: 0, skipped: 0 });
    recordSprintSnapshots.mockResolvedValue(0);
    processDueWebhookDeliveries.mockResolvedValue({ processed: 0, succeeded: 0 });
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
    it("takes the transaction-scoped advisory lock and runs all three jobs once", async () => {
      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(lockCalls()).toHaveLength(1);
      const lockSql = sqlText(lockCalls()[0]);
      expect(lockSql).toContain("pg_try_advisory_xact_lock");
      expect(lockSql).toContain(String(SCHEDULER_ADVISORY_LOCK_KEY));
      expect(lockSql).not.toContain("pg_advisory_unlock");
      expect(lockSql).not.toContain("pg_try_advisory_lock(");
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      // M9: every job receives the tick's cancellable deadline signal.
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
    });


    it("runs the sprint snapshot and webhook delivery jobs on each tick", async () => {
      await runScheduledJobs();

      expect(recordSprintSnapshots).toHaveBeenCalledTimes(1);
      expect(processDueWebhookDeliveries).toHaveBeenCalledTimes(1);
    });

    it("passes the transaction options with the tick timeout", async () => {
      await runScheduledJobs();

      expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 5000,
        timeout: DEFAULT_TICK_TIMEOUT_MS,
      });
    });

    it("honours SCHEDULER_TICK_TIMEOUT_MS for the transaction timeout", async () => {
      process.env.SCHEDULER_TICK_TIMEOUT_MS = "30000";

      await runScheduledJobs();

      expect(transactionOptions()).toEqual({ maxWait: 5000, timeout: 30000 });
    });

    it("skips the tick when another instance holds the lock", async () => {
      txMock.$queryRaw.mockResolvedValue([{ locked: false }]);

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(lockCalls()).toHaveLength(1);
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
    });

    it("skips the tick when the lock query fails", async () => {
      txMock.$queryRaw.mockRejectedValue(new Error("database unavailable"));

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
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
      // The first tick is still the only one running jobs.
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);

      releaseFirstTick?.();
      expect(await firstTick).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);

      // Once the first tick finished, the next tick runs again.
      processDueRecurrences.mockResolvedValue({ processed: 0, createdTaskIds: [] });
      const thirdTick = await runScheduledJobs();
      expect(thirdTick).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(2);
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

    it("still runs due-date automation and the digest when the recurrence processor throws", async () => {
      processDueRecurrences.mockRejectedValue(new Error("recurrence exploded"));

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: true });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
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

      vi.clearAllMocks();
      txMock.$queryRaw.mockResolvedValue([{ locked: true }]);
      runDailyDigestJob.mockResolvedValue({ sent: 0, skipped: 0 });
      process.env.SCHEDULER_DIGEST_HOUR_UTC = "23";
      await runScheduledJobs();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
    });
  });

  describe("withSchedulerLock (external entry points)", () => {
    it("runs the callback and returns its result while holding the lock", async () => {
      const result = await withSchedulerLock(async () => "ran");

      expect(result).toBe("ran");
      expect(lockCalls()).toHaveLength(1);
      expect(sqlText(lockCalls()[0])).toContain(String(SCHEDULER_ADVISORY_LOCK_KEY));
    });

    it("returns null (skip) when the lock is already held", async () => {
      txMock.$queryRaw.mockResolvedValue([{ locked: false }]);

      const result = await withSchedulerLock(async () => {
        throw new Error("must not run while another tick holds the lock");
      });

      expect(result).toBeNull();
    });

    it("returns null (skip) when the lock transaction fails", async () => {
      prismaMock.$transaction.mockRejectedValue(new Error("database unavailable"));

      const result = await withSchedulerLock(async () => "never");

      expect(result).toBeNull();
    });

    it("treats a callback failure as a skip (fail safe)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await withSchedulerLock(async () => {
        throw new Error("job exploded");
      });

      // The lock helper never throws — callers treat null as "skip" so the
      // interval loop and the cron endpoint stay alive.
      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler] lock acquisition aborted"));
      errorSpy.mockRestore();
    });
  });

  describe("configuration", () => {
    it("is started by startScheduler and ticks on the configured interval", async () => {
      process.env.SCHEDULER_INTERVAL_MS = "1000";
      startScheduler();

      await vi.advanceTimersByTimeAsync(0);
      expect(lockCalls()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(lockCalls()).toHaveLength(1);
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(lockCalls()).toHaveLength(2);
      expect(processDueRecurrences).toHaveBeenCalledTimes(2);
    });

    it("is idempotent under repeated startScheduler calls (hot reload)", async () => {
      startScheduler();
      startScheduler();
      startScheduler();

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);

      expect(lockCalls()).toHaveLength(1);
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
    });

    it("does not schedule anything when SCHEDULER_ENABLED is false", async () => {
      process.env.SCHEDULER_ENABLED = "false";
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      startScheduler();

      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
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

      expect(lockCalls()).toHaveLength(0);
    });
  });
});
