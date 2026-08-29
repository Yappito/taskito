import { describe, expect, it } from "vitest";

import { computeBurndownDays } from "@/server/services/burndown";
import { recordSprintSnapshots, upsertSprintSnapshot, utcDay, utcDayKey } from "@/server/services/sprint-snapshot";
import { TickDeadlineExceededError } from "@/server/services/scheduler-deadline";
import { createPrismaMock } from "@/test/prisma-mock";

describe("sprint snapshot service", () => {
  it("truncates dates to the UTC day", () => {
    expect(utcDayKey(new Date("2026-05-19T23:41:12.000Z"))).toBe("2026-05-19");
    expect(utcDayKey(new Date("2026-05-20T00:00:00.000Z"))).toBe("2026-05-20");
    expect(utcDay(new Date("2026-05-19T23:59:59.999Z"))).toEqual(new Date("2026-05-19T00:00:00.000Z"));
  });

  it("upserts the same (sprintId, day) row no matter the time of day — idempotent per day", async () => {
    const prisma = createPrismaMock();

    await upsertSprintSnapshot(prisma as never, {
      sprintId: "sprint-1",
      date: new Date("2026-05-19T09:15:00.000Z"),
      remainingCount: 5,
      completedCount: 2,
    });
    // A later run on the same UTC day (e.g. another scheduler tick or the
    // completion mutation) rewrites the same row instead of creating a new one.
    await upsertSprintSnapshot(prisma as never, {
      sprintId: "sprint-1",
      date: new Date("2026-05-19T22:40:00.000Z"),
      remainingCount: 0,
      completedCount: 7,
    });
    // A different day is a different row.
    await upsertSprintSnapshot(prisma as never, {
      sprintId: "sprint-1",
      date: new Date("2026-05-20T10:00:00.000Z"),
      remainingCount: 1,
      completedCount: 6,
    });

    expect(prisma.sprintSnapshot.upsert).toHaveBeenCalledTimes(3);
    const [first, second, third] = prisma.sprintSnapshot.upsert.mock.calls.map((call) => call[0]);

    const firstDay = first.where.sprintId_date.date as Date;
    const secondDay = second.where.sprintId_date.date as Date;
    expect(firstDay.toISOString()).toBe("2026-05-19T00:00:00.000Z");
    expect(secondDay.toISOString()).toBe("2026-05-19T00:00:00.000Z");
    expect(second.update).toEqual({ remainingCount: 0, completedCount: 7 });
    expect(third.where.sprintId_date.date.toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("records one snapshot row per active sprint per day", async () => {
    const prisma = createPrismaMock();
    prisma.sprint.findMany.mockResolvedValue([{ id: "sprint-1" }, { id: "sprint-2" }]);
    prisma.task.findMany
      .mockResolvedValueOnce([
        { status: { category: "todo" } },
        { status: { category: "active" } },
        { status: { category: "done" } },
      ])
      .mockResolvedValueOnce([{ status: { category: "done" } }]);

    const now = new Date("2026-05-19T09:00:00.000Z");
    const recorded = await recordSprintSnapshots(prisma as never, now);

    expect(recorded).toBe(2);
    expect(prisma.task.findMany).toHaveBeenCalledWith({
      where: { sprintId: "sprint-1" },
      select: { status: { select: { category: true } } },
    });
    expect(prisma.sprintSnapshot.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { sprintId_date: { sprintId: "sprint-1", date: utcDay(now) } },
        create: expect.objectContaining({ remainingCount: 2, completedCount: 1 }),
      })
    );
    expect(prisma.sprintSnapshot.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { sprintId_date: { sprintId: "sprint-2", date: utcDay(now) } },
        create: expect.objectContaining({ remainingCount: 0, completedCount: 1 }),
      })
    );
  });

  // Wave-10 finding 2b: the per-sprint loop must check the caller's abort
  // signal BETWEEN sprints (before each sprint's task query/upsert), so a
  // large active-sprint population stops at the tick deadline instead of
  // running unbounded past it.
  it("stops between sprints when the signal aborts (tick deadline)", async () => {
    const prisma = createPrismaMock();
    prisma.sprint.findMany.mockResolvedValue([{ id: "sprint-1" }, { id: "sprint-2" }, { id: "sprint-3" }]);
    prisma.task.findMany.mockResolvedValue([{ status: { category: "todo" } }]);
    const controller = new AbortController();
    // The abort fires while sprint-1's work is in flight: sprint-1 completes
    // (recorded), then the loop throws BEFORE touching sprint-2 or sprint-3.
    prisma.task.findMany.mockImplementationOnce(async () => {
      controller.abort();
      return [{ status: { category: "todo" } }];
    });

    const now = new Date("2026-05-19T09:00:00.000Z");
    await expect(recordSprintSnapshots(prisma as never, now, { signal: controller.signal })).rejects.toBeInstanceOf(
      TickDeadlineExceededError,
    );

    // Only the sprint processed BEFORE the abort was touched; the remaining
    // ones are deferred to the next tick (the upsert is idempotent, so a
    // partially recorded day is completed later).
    expect(prisma.task.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({ sprintId: "sprint-1" });
    expect(prisma.sprintSnapshot.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("computeBurndownDays", () => {
  it("returns one day per day of the sprint, inclusive, with ideal endpoints", () => {
    const days = computeBurndownDays({
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-05-08T00:00:00.000Z"),
      snapshots: [
        { date: new Date("2026-05-01T00:00:00.000Z"), remainingCount: 5, completedCount: 0 },
        { date: new Date("2026-05-04T00:00:00.000Z"), remainingCount: 2, completedCount: 3 },
      ],
    });

    expect(days).toHaveLength(8); // May 1 .. May 8 inclusive
    expect(days.map((day) => day.date)).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
      "2026-05-07",
      "2026-05-08",
    ]);
    // Ideal line endpoints: initial work on day one, zero on the end date.
    expect(days[0].ideal).toBe(5);
    expect(days[days.length - 1].ideal).toBe(0);
    // Actual remaining carries forward from the latest snapshot row.
    expect(days[0].remaining).toBe(5);
    expect(days[3].remaining).toBe(2);
    expect(days[7].remaining).toBe(2);
  });

  it("produces an empty single day with zeroed values when there is no snapshot data", () => {
    const days = computeBurndownDays({
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-05-01T00:00:00.000Z"),
      snapshots: [],
    });
    expect(days).toHaveLength(1);
    expect(days[0]).toEqual({ date: "2026-05-01", remaining: 0, ideal: 0 });
  });
});