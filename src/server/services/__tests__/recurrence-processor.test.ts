import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { createTaskActivity } = vi.hoisted(() => ({
  createTaskActivity: vi.fn(),
}));

vi.mock("@/server/services/task-activity", () => ({
  createTaskActivity,
}));

import { processDueRecurrences } from "@/server/services/recurrence-processor";

const NOW = new Date("2026-05-19T09:00:00.000Z");

function createPrismaMock() {
  const prisma = {
    recurrenceRule: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    task: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) => await callback(prisma)),
  };
  return prisma;
}

function createRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-1",
    taskId: "task-1",
    frequency: "weekly",
    interval: 1,
    dayOfWeek: null,
    dayOfMonth: null,
    endDate: null,
    nextDueDate: new Date("2026-05-18T09:00:00.000Z"),
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    task: {
      id: "task-1",
      projectId: "project-1",
      taskNumber: 41,
      creatorId: "user-1",
      assigneeId: "user-2",
      title: "Weekly standup prep",
      description: null,
      body: null,
      statusId: "status-1",
      priority: "medium",
      dueDate: null,
      startDate: new Date("2026-05-18T08:00:00.000Z"),
      sprintId: null,
      tags: [{ tagId: "tag-1" }],
      customFieldValues: [],
    },
    ...overrides,
  };
}

describe("recurrence processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    createTaskActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the task and advances nextDueDate atomically, then fires the activity event", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([createRule()]);
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 41 });
    prisma.task.create.mockResolvedValue({ id: "task-2", taskNumber: 42, projectId: "project-1" });
    prisma.recurrenceRule.update.mockResolvedValue({});

    const result = await processDueRecurrences(prisma as never, { now: NOW });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "project-1",
          taskNumber: 42,
          creatorId: "user-1",
          assigneeId: "user-2",
          title: "Weekly standup prep",
          description: Prisma.JsonNull,
          dueDate: new Date("2026-05-18T09:00:00.000Z"),
          startDate: new Date("2026-05-18T08:00:00.000Z"),
          sprintId: null,
          tags: { create: [{ tagId: "tag-1" }] },
        }),
      })
    );
    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: { nextDueDate: new Date("2026-05-25T09:00:00.000Z") },
    });
    expect(createTaskActivity).toHaveBeenCalledWith({
      taskId: "task-2",
      actorId: "user-1",
      action: "created",
      details: { recurringFromTaskId: "task-1", recurrenceRuleId: "rule-1" },
    });
    expect(result).toEqual({ processed: 1, createdTaskIds: ["task-2"], failedRuleIds: [] });
  });

  it("does not advance a rule whose task creation fails, logs it, and continues with the next rule", async () => {
    const prisma = createPrismaMock();
    const failingRule = createRule();
    const healthyRule = createRule({
      id: "rule-2",
      taskId: "task-2",
      task: { ...createRule().task, id: "task-2" },
    });
    prisma.recurrenceRule.findMany.mockResolvedValue([failingRule, healthyRule]);
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 3 });
    prisma.task.create
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "task-2", taskNumber: 4 });
    prisma.recurrenceRule.update.mockResolvedValue({});

    const result = await processDueRecurrences(prisma as never, { now: NOW });

    expect(prisma.task.create).toHaveBeenCalledTimes(2);
    expect(prisma.recurrenceRule.update).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: "rule-2" },
      data: { nextDueDate: new Date("2026-05-25T09:00:00.000Z") },
    });
    expect(console.error).toHaveBeenCalledWith(
      "Recurrence rule processing failed",
      expect.objectContaining({ ruleId: "rule-1", error: expect.any(Error) })
    );
    expect(result).toEqual({ processed: 2, createdTaskIds: ["task-2"], failedRuleIds: ["rule-1"] });
  });

  it("snaps weekly rules to the configured dayOfWeek", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ dayOfWeek: 3 }), // 2026-05-18 is a Monday → next Wednesday
    ]);
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 0 });
    prisma.task.create.mockResolvedValue({ id: "task-2", taskNumber: 1 });
    prisma.recurrenceRule.update.mockResolvedValue({});

    await processDueRecurrences(prisma as never, { now: NOW });

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: { nextDueDate: new Date("2026-05-27T09:00:00.000Z") },
    });
  });

  it("clamps monthly rules to the last day of short months", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "monthly",
        dayOfMonth: 31,
        nextDueDate: new Date("2026-05-15T09:00:00.000Z"), // → 2026-06-30 (30-day month)
      }),
      createRule({
        id: "rule-2",
        taskId: "task-2",
        task: { ...createRule().task, id: "task-2" },
        frequency: "monthly",
        dayOfMonth: 31,
        nextDueDate: new Date("2028-01-15T09:00:00.000Z"), // → 2028-02-29 (leap February)
      }),
    ]);
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 0 });
    prisma.task.create.mockResolvedValue({ id: "task-2", taskNumber: 1 });
    prisma.recurrenceRule.update.mockResolvedValue({});

    await processDueRecurrences(prisma as never, { now: NOW });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dueDate: new Date("2026-05-15T09:00:00.000Z") }),
      })
    );
    expect(prisma.recurrenceRule.update).toHaveBeenNthCalledWith(1, {
      where: { id: "rule-1" },
      data: { nextDueDate: new Date("2026-06-30T09:00:00.000Z") },
    });
    expect(prisma.recurrenceRule.update).toHaveBeenNthCalledWith(2, {
      where: { id: "rule-2" },
      data: { nextDueDate: new Date("2028-02-29T09:00:00.000Z") },
    });
  });

  it("ignores dayOfWeek for daily frequency", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", dayOfWeek: 3 }),
    ]);
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 0 });
    prisma.task.create.mockResolvedValue({ id: "task-2", taskNumber: 1 });
    prisma.recurrenceRule.update.mockResolvedValue({});

    await processDueRecurrences(prisma as never, { now: NOW });

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: { nextDueDate: new Date("2026-05-19T09:00:00.000Z") },
    });
  });

  it("advances past the endDate boundary without creating a task", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ endDate: new Date("2026-05-24T09:00:00.000Z") }), // next due 2026-05-25 > endDate
    ]);
    prisma.recurrenceRule.update.mockResolvedValue({});

    const result = await processDueRecurrences(prisma as never, { now: NOW });

    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: { nextDueDate: new Date("2026-05-25T09:00:00.000Z") },
    });
    expect(result).toEqual({ processed: 1, createdTaskIds: [], failedRuleIds: [] });
  });

  it("retries the whole per-rule transaction on a task number conflict", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([createRule()]);
    prisma.task.findFirst
      .mockResolvedValueOnce({ taskNumber: 7 })
      .mockResolvedValueOnce({ taskNumber: 8 });
    prisma.task.create
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("duplicate task number", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["projectId", "taskNumber"] },
        })
      )
      .mockResolvedValueOnce({ id: "task-2", taskNumber: 9 });
    prisma.recurrenceRule.update.mockResolvedValue({});

    const result = await processDueRecurrences(prisma as never, { now: NOW });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.task.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ taskNumber: 8 }) })
    );
    expect(prisma.task.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ taskNumber: 9 }) })
    );
    expect(prisma.recurrenceRule.update).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 1, createdTaskIds: ["task-2"], failedRuleIds: [] });
  });
});
