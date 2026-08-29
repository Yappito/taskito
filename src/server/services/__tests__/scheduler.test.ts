import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  processDueRecurrences,
  processDueDateAutomationRules,
  runDailyDigestJob,
  prismaMock,
} = vi.hoisted(() => ({
  processDueRecurrences: vi.fn(),
  processDueDateAutomationRules: vi.fn(),
  runDailyDigestJob: vi.fn(),
  prismaMock: {
    $transaction: vi.fn(),
    automationRule: {
      findMany: vi.fn(),
    },
    projectMember: {
      findFirst: vi.fn(),
    },
    sprint: {
      findMany: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
    },
    sprintSnapshot: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/server/services/recurrence-processor", () => ({
  processDueRecurrences,
}));

vi.mock("@/server/services/automation-evaluator", () => ({
  processDueDateAutomationRules,
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
  resolveProjectActorId,
  runScheduledJobs,
  startScheduler,
  stopScheduler,
} from "@/server/services/scheduler";

const NOW = new Date("2026-05-19T09:00:00.000Z");
const INTERVAL_MS = 60_000;
const DEFAULT_TICK_TIMEOUT_MS = 600_000;

const PROJECT_A = "cmab8yxxp0001i7p4k8n2v3q4";
const PROJECT_B = "cmab8yxxp0002i7p4k8n2v3q5";
const OWNER_ID = "cmab8yxxp0003i7p4k8n2v3q6";
const MEMBER_ID = "cmab8yxxp0004i7p4k8n2v3q7";
const SPRINT_A = "cmab8yxxp0005s0p0r0i0n0t0a0a0";
const SPRINT_B = "cmab8yxxp0006s0p0r0i0n0t0a0a0";

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
    prismaMock.automationRule.findMany.mockResolvedValue([{ projectId: PROJECT_A }]);
    prismaMock.projectMember.findFirst.mockResolvedValue({ userId: OWNER_ID });
    prismaMock.sprint.findMany.mockResolvedValue([]);
    prismaMock.task.findMany.mockResolvedValue([]);
    processDueRecurrences.mockResolvedValue({ processed: 0, createdTaskIds: [] });
    processDueDateAutomationRules.mockResolvedValue({ processed: 0 });
    runDailyDigestJob.mockResolvedValue({ sent: 0, skipped: 0 });
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
    it("takes the transaction-scoped advisory lock and runs every scheduled job once", async () => {
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
      expect(processDueRecurrences).toHaveBeenCalledWith(prismaMock, { limit: 100 });
      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);
      expect(processDueDateAutomationRules).toHaveBeenCalledWith(prismaMock, { projectId: PROJECT_A, actorId: OWNER_ID });
      // Digest ticks at 09:00 UTC are past the default SCHEDULER_DIGEST_HOUR_UTC of 7.
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob).toHaveBeenCalledWith(NOW);
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
      expect(prismaMock.automationRule.findMany).not.toHaveBeenCalled();
    });

    it("skips the tick when the lock query fails", async () => {
      txMock.$queryRaw.mockRejectedValue(new Error("database unavailable"));

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
    });

    it("skips the tick when another instance holds the lock", async () => {
      txMock.$queryRaw.mockResolvedValue([{ locked: false }]);

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(lockCalls()).toHaveLength(1);
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
      expect(prismaMock.automationRule.findMany).not.toHaveBeenCalled();
    });

    it("skips the tick when the lock query fails", async () => {
      txMock.$queryRaw.mockRejectedValue(new Error("database unavailable"));

      const result = await runScheduledJobs();

      expect(result).toEqual({ ran: false });
      expect(processDueRecurrences).not.toHaveBeenCalled();
      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(runDailyDigestJob).not.toHaveBeenCalled();
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

    it("runs the sprint snapshot job for each active sprint (idempotent upsert per day)", async () => {
      prismaMock.sprint.findMany.mockResolvedValue([{ id: SPRINT_A }, { id: SPRINT_B }]);
      prismaMock.task.findMany
        .mockResolvedValueOnce([
          { status: { category: "todo" } },
          { status: { category: "active" } },
          { status: { category: "done" } },
        ])
        .mockResolvedValueOnce([{ status: { category: "cancelled" } }]);

      // Two identical ticks in the same UTC day must not duplicate rows.
      await runScheduledJobs();
      await runScheduledJobs();

      expect(prismaMock.sprint.findMany).toHaveBeenCalledWith({
        where: { status: "active" },
        select: { id: true },
      });
      expect(prismaMock.sprintSnapshot.upsert).toHaveBeenCalledTimes(4);
      expect(prismaMock.sprintSnapshot.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { sprintId_date: { sprintId: SPRINT_A, date: expect.any(Date) } },
          create: expect.objectContaining({ remainingCount: 2, completedCount: 1 }),
        })
      );
      expect(prismaMock.sprintSnapshot.upsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { sprintId_date: { sprintId: SPRINT_B, date: expect.any(Date) } },
          create: expect.objectContaining({ remainingCount: 0, completedCount: 1 }),
        })
      );
      expect(processDueRecurrences).toHaveBeenCalledTimes(2);
      expect(runDailyDigestJob).toHaveBeenCalledTimes(2);
    });

    it("runs due-date automation per project and isolates per-project failures", async () => {
      prismaMock.automationRule.findMany.mockResolvedValue([{ projectId: PROJECT_A }, { projectId: PROJECT_B }]);
      processDueDateAutomationRules
        .mockRejectedValueOnce(new Error("project A is broken"))
        .mockResolvedValueOnce({ processed: 3 });

      await runScheduledJobs();

      expect(processDueDateAutomationRules).toHaveBeenCalledTimes(2);
      expect(processDueDateAutomationRules).toHaveBeenNthCalledWith(
        2,
        prismaMock,
        { projectId: PROJECT_B, actorId: OWNER_ID },
      );
      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
    });

    it("runs the digest once the current UTC hour reaches SCHEDULER_DIGEST_HOUR_UTC", async () => {
      // NOW is 09:00 UTC; the default digest hour is 7, so earlier tests run it.
      process.env.SCHEDULER_DIGEST_HOUR_UTC = "9";

      await runScheduledJobs();

      expect(runDailyDigestJob).toHaveBeenCalledTimes(1);
      expect(runDailyDigestJob).toHaveBeenCalledWith(NOW);
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

  describe("actor resolution", () => {
    it("uses the project owner member (role owner) as the automation actor", async () => {
      prismaMock.projectMember.findFirst.mockResolvedValue({ userId: OWNER_ID });

      const actorId = await resolveProjectActorId(prismaMock as never, PROJECT_A);

      expect(prismaMock.projectMember.findFirst).toHaveBeenCalledWith({
        where: { projectId: PROJECT_A, role: "owner" },
        orderBy: { createdAt: "asc" },
        select: { userId: true },
      });
      expect(actorId).toBe(OWNER_ID);

      prismaMock.automationRule.findMany.mockResolvedValue([{ projectId: PROJECT_A }]);
      await runScheduledJobs();
      expect(processDueDateAutomationRules).toHaveBeenCalledWith(prismaMock, { projectId: PROJECT_A, actorId: OWNER_ID });
    });

    it("falls back to the earliest project member when no owner role exists", async () => {
      prismaMock.projectMember.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ userId: MEMBER_ID });

      const actorId = await resolveProjectActorId(prismaMock as never, PROJECT_A);

      expect(actorId).toBe(MEMBER_ID);
    });

    it("skips projects that have no members to act with", async () => {
      prismaMock.projectMember.findFirst.mockResolvedValue(null);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      prismaMock.automationRule.findMany.mockResolvedValue([{ projectId: PROJECT_A }]);

      await runScheduledJobs();

      expect(processDueDateAutomationRules).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler]"));
      warnSpy.mockRestore();
    });
  });

  it("is started by startScheduler and ticks on the configured interval", async () => {
    process.env.SCHEDULER_INTERVAL_MS = "1000";
    startScheduler();

    await vi.advanceTimersByTimeAsync(0);
    expect(lockCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(lockCalls()).toHaveLength(1);
    expect(processDueRecurrences).toHaveBeenCalledTimes(1);
    expect(processDueDateAutomationRules).toHaveBeenCalledTimes(1);

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