import { describe, expect, it, vi } from "vitest";

// NOTE: authz is intentionally NOT mocked — this suite pins the real
// authorization behavior of the sprint router via the actor fixtures.
import { createCallerFactory } from "@/server/trpc";
import { sprintRouter } from "@/server/routers/sprint";
import { memberOf } from "@/test/actors";
import { createPrismaMock } from "@/test/prisma-mock";

const createCaller = createCallerFactory(sprintRouter);

const PROJECT_ID = "cmab8yxxp0001a0p0r0j0e0c0t0a0a0";
const SPRINT_ID = "cmab8yxxp0002s0p0r0i0n0t0a0a0";
const ACTIVE_SPRINT_ID = "cmab8yxxp0003s0p0r0i0n0t0a0a0";
const TARGET_SPRINT_ID = "cmab8yxxp0004s0p0r0i0n0t0a0a0";
const NEXT_SPRINT_ID = "cmab8yxxp0005s0p0r0i0n0t0a0a0";

const OPEN_TASK_IDS = [
  "cmab8yxxp0006t0a0s0k00000000m1",
  "cmab8yxxp0006t0a0s0k00000000m2",
  "cmab8yxxp0006t0a0s0k00000000m3",
];
const DONE_TASK_IDS = [
  "cmab8yxxp0006t0a0s0k00000000d1",
  "cmab8yxxp0006t0a0s0k00000000d2",
];

function callerFor(actor: ReturnType<typeof memberOf>) {
  return createCaller({
    prisma: actor.prisma as never,
    session: { user: actor.sessionUser } as never,
  });
}

function taskStatusRow(category: string) {
  return { status: { category } };
}

/**
 * Wires the transaction-internal call chain for sprint.complete: the sprint is
 * active, the (optional) carry-over target resolves, and the sprint holds
 * 3 open + 2 done tasks.
 */
function wireCompleteChain(actor: ReturnType<typeof memberOf>) {
  const prisma = actor.prisma;
  prisma.sprint.findUniqueOrThrow
    .mockResolvedValueOnce({ id: SPRINT_ID, projectId: PROJECT_ID, status: "active" }) // outer lookup
    .mockResolvedValueOnce({ id: SPRINT_ID, status: "active" }) // in-transaction re-read
    .mockResolvedValueOnce({ id: SPRINT_ID, status: "completed" }); // final include read
  prisma.task.findMany
    .mockResolvedValue([
      { id: OPEN_TASK_IDS[0], ...taskStatusRow("todo") },
      { id: OPEN_TASK_IDS[1], ...taskStatusRow("active") },
      { id: OPEN_TASK_IDS[2], ...taskStatusRow("backlog") },
      { id: DONE_TASK_IDS[0], ...taskStatusRow("done") },
      { id: DONE_TASK_IDS[1], ...taskStatusRow("cancelled") },
    ]);
  prisma.sprint.update.mockResolvedValue({ id: SPRINT_ID, status: "completed" });
}

describe("sprint router lifecycle", () => {
  it("rejects sprint.start when the project already has an active sprint", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_ID]: "owner" } });
    callerFor(actor);
    const caller = callerFor(actor);

    actor.prisma.sprint.findUniqueOrThrow
      .mockResolvedValueOnce({ id: SPRINT_ID, projectId: PROJECT_ID, status: "planning" })
      .mockResolvedValueOnce({ id: SPRINT_ID, status: "planning" });
    actor.prisma.sprint.findFirst.mockResolvedValue({ id: ACTIVE_SPRINT_ID, name: "Active Sprint" });

    await expect(caller.start({ id: SPRINT_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("already has an active sprint"),
    });
    // The sprint itself was never flipped to active.
    expect(actor.prisma.sprint.update).not.toHaveBeenCalled();
  });

  it("starts a sprint, sets status/startedAt and writes the first snapshot", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_ID]: "owner" } });
    const caller = callerFor(actor);

    actor.prisma.sprint.findUniqueOrThrow
      .mockResolvedValueOnce({ id: SPRINT_ID, projectId: PROJECT_ID, status: "planning" })
      .mockResolvedValueOnce({ id: SPRINT_ID, status: "planning" })
      .mockResolvedValueOnce({ id: SPRINT_ID, status: "active" });
    actor.prisma.sprint.findFirst.mockResolvedValue(null);
    actor.prisma.task.findMany
      .mockResolvedValue([taskStatusRow("todo"), taskStatusRow("active"), taskStatusRow("done")]);
    actor.prisma.sprint.update.mockResolvedValue({ id: SPRINT_ID });

    const result = await caller.start({ id: SPRINT_ID });

    expect(result).toMatchObject({ id: SPRINT_ID, status: "active" });
    expect(actor.prisma.sprint.update).toHaveBeenCalledWith({
      where: { id: SPRINT_ID },
      data: { status: "active", startedAt: expect.any(Date) },
    });
    expect(actor.prisma.sprintSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sprintId_date: { sprintId: SPRINT_ID, date: expect.any(Date) } },
        create: expect.objectContaining({ remainingCount: 2, completedCount: 1 }),
        update: expect.objectContaining({ remainingCount: 2, completedCount: 1 }),
      })
    );
  });

  it("completes and carries the 3 unfinished tasks to the chosen sprint, leaving done tasks untouched", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_ID]: "owner" } });
    const caller = callerFor(actor);
    wireCompleteChain(actor);
    actor.prisma.sprint.findUnique.mockResolvedValue({
      id: TARGET_SPRINT_ID,
      projectId: PROJECT_ID,
      status: "planning",
    });

    const result = await caller.complete({ id: SPRINT_ID, carryOverTo: TARGET_SPRINT_ID });

    // Only the 3 unfinished tasks move; the done/cancelled ones keep their sprint.
    expect(actor.prisma.task.updateMany).toHaveBeenCalledTimes(1);
    expect(actor.prisma.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: OPEN_TASK_IDS } },
      data: { sprintId: TARGET_SPRINT_ID },
    });
    const movedWhere = actor.prisma.task.updateMany.mock.calls[0][0].where;
    const movedIds = movedWhere.id.in as string[];
    expect(movedIds).toHaveLength(3);
    expect(movedIds).not.toEqual(expect.arrayContaining(DONE_TASK_IDS));

    // Summary snapshot counts.
    const updateArgs = actor.prisma.sprint.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe("completed");
    expect(updateArgs.data.completedAt).toBeInstanceOf(Date);
    expect(updateArgs.data.summary).toEqual({
      committedCount: 5,
      completedCount: 2,
      carriedOverCount: 3,
      completedTaskIds: DONE_TASK_IDS,
    });

    // Completion-day burndown row: no remaining work left in the sprint.
    expect(actor.prisma.sprintSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sprintId_date: { sprintId: SPRINT_ID, date: expect.any(Date) } },
        create: expect.objectContaining({ remainingCount: 0, completedCount: 2 }),
      })
    );
    expect(result).toMatchObject({ id: SPRINT_ID, status: "completed" });
  });

  it("completing with carryOverTo 'next' picks the earliest planned sprint", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_ID]: "owner" } });
    const caller = callerFor(actor);
    wireCompleteChain(actor);
    actor.prisma.sprint.findFirst.mockResolvedValue({ id: NEXT_SPRINT_ID, name: "Next Sprint" });

    await caller.complete({ id: SPRINT_ID, carryOverTo: "next" });

    expect(actor.prisma.sprint.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: PROJECT_ID,
        status: "planning",
        id: { not: SPRINT_ID },
      },
      orderBy: [{ startDate: "asc" }, { order: "asc" }],
      select: { id: true, name: true },
    });
    expect(actor.prisma.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: OPEN_TASK_IDS } },
      data: { sprintId: NEXT_SPRINT_ID },
    });
  });

  it("rejects completions without a planned sprint to carry over to", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_ID]: "owner" } });
    const caller = callerFor(actor);
    wireCompleteChain(actor);
    actor.prisma.sprint.findFirst.mockResolvedValue(null);

    await expect(caller.complete({ id: SPRINT_ID, carryOverTo: "next" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("No planned sprint"),
    });
    expect(actor.prisma.task.updateMany).not.toHaveBeenCalled();
    expect(actor.prisma.sprint.update).not.toHaveBeenCalled();
  });

  it("denies start/complete for project viewers (sprint_manage required)", async () => {
    const viewer = memberOf({ userId: "viewer-1", projects: { [PROJECT_ID]: "viewer" } });
    const caller = callerFor(viewer);

    viewer.prisma.sprint.findUniqueOrThrow.mockResolvedValue({
      id: SPRINT_ID,
      projectId: PROJECT_ID,
      status: "planning",
    });

    await expect(caller.start({ id: SPRINT_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.complete({ id: SPRINT_ID, carryOverTo: "backlog" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Nothing mutated.
    expect(viewer.prisma.sprint.update).not.toHaveBeenCalled();
    expect(viewer.prisma.task.updateMany).not.toHaveBeenCalled();
  });

  it("does not complete a sprint that is already completed", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_ID]: "owner" } });
    const caller = callerFor(actor);

    actor.prisma.sprint.findUniqueOrThrow
      .mockResolvedValueOnce({ id: SPRINT_ID, projectId: PROJECT_ID, status: "completed" })
      .mockResolvedValueOnce({ id: SPRINT_ID, status: "completed" });

    await expect(caller.complete({ id: SPRINT_ID, carryOverTo: "backlog" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Sprint is already completed",
    });
  });
});