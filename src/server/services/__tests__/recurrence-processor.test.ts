import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createTaskWithNextNumber,
  createTaskActivity,
} = vi.hoisted(() => ({
  createTaskWithNextNumber: vi.fn(),
  createTaskActivity: vi.fn(),
}));

vi.mock("@/server/routers/task", () => ({
  createTaskWithNextNumber,
}));

vi.mock("@/server/services/task-activity", () => ({
  createTaskActivity,
}));

import { processDueRecurrences } from "@/server/services/recurrence-processor";

const PROJECT_ID = "cmab8yxxp0001i7p4k8n2v3q4";
const SOURCE_TASK_ID = "cmab8yxxp0002i7p4k8n2v3q5";
const ASSIGNEE_ID = "cmab8yxxp0003i7p4k8n2v3q6";
const TAG_ID = "cmab8yxxp0004i7p4k8n2v3q7";
const CUSTOM_FIELD_ID = "cmab8yxxp0005i7p4k8n2v3q8";
const RULE_ID = "cmab8yxxp0006i7p4k8n2v3q9";
const CREATED_TASK_ID = "cmab8yxxp0007i7p4k8n2v3qa";

function createPrismaMock() {
  return {
    recurrenceRule: {
      findMany: vi.fn().mockResolvedValue([]),
      // M8: occurrences are claimed with a compare-and-swap on nextDueDate.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function createSourceTask(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_TASK_ID,
    projectId: PROJECT_ID,
    creatorId: ASSIGNEE_ID,
    assigneeId: ASSIGNEE_ID,
    title: "Water the plants",
    description: null,
    body: null,
    statusId: "cmab8yxxp0008i7p4k8n2v3qb",
    priority: "medium",
    dueDate: new Date("2026-05-19T09:00:00.000Z"),
    startDate: null,
    sprintId: null,
    tags: [{ tagId: TAG_ID }],
    customFieldValues: [{ customFieldId: CUSTOM_FIELD_ID, value: "weekly" }],
    ...overrides,
  };
}

function createRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    taskId: SOURCE_TASK_ID,
    frequency: "weekly",
    interval: 1,
    dayOfWeek: null,
    dayOfMonth: null,
    endDate: null,
    nextDueDate: new Date("2026-05-19T09:00:00.000Z"),
    task: createSourceTask(),
    ...overrides,
  };
}

describe("recurrence processor", () => {
  let tx: { task: { create: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T10:00:00.000Z"));

    tx = {
      task: {
        create: vi.fn().mockResolvedValue({ id: CREATED_TASK_ID }),
      },
    };
    createTaskWithNextNumber.mockImplementation(async (_client: unknown, _projectId: string, factory: (tx: unknown, taskNumber: number) => Promise<unknown>) => {
      const created = await factory(tx, 42);
      return (created as { id: string }) ?? { id: CREATED_TASK_ID };
    });
    createTaskActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims the occurrence with a compare-and-swap and advances by frequency x interval", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", interval: 3, nextDueDate: current }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    expect(result.processed).toBe(1);
    // M8: the CAS where-clause pins the value that was read, so only one of
    // two concurrent callers can win the occurrence.
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-22T09:00:00.000Z") },
    });
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
  });

  it("advances yearly rules by the interval in years", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "yearly", interval: 2, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2028-05-19T09:00:00.000Z") },
    });
  });

  it("keeps weekly rules without dayOfWeek on the plain interval*7 step", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-18T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 2, dayOfWeek: null, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-06-01T09:00:00.000Z") },
    });
  });

  it("honours dayOfWeek for weekly rules by landing on the next matching weekday", async () => {
    const prisma = createPrismaMock();
    // 2026-05-15 is a Friday; dayOfWeek=1 means Monday. Step lands Fri 05-22,
    // then snaps forward to Mon 2026-05-25.
    const current = new Date("2026-05-15T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 1, dayOfWeek: 1, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-25T09:00:00.000Z") },
    });
  });

  it("keeps already-aligned weekly dayOfWeek rules exactly on the interval cadence", async () => {
    const prisma = createPrismaMock();
    // 2026-05-18 is a Monday, dayOfWeek=1 -> next occurrence stays weekly on Monday.
    const current = new Date("2026-05-18T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 1, dayOfWeek: 1, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-25T09:00:00.000Z") },
    });
  });

  it("keeps monthly rules without dayOfMonth on the legacy month step", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-01-15T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: null, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-02-15T09:00:00.000Z") },
    });
  });

  it("honours dayOfMonth for monthly rules with time of day preserved", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-01-20T09:30:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: 15, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-02-15T09:30:00.000Z") },
    });
  });

  it("clamps dayOfMonth to the target month length (month-end)", async () => {
    const prisma = createPrismaMock();
    // Jan 31 + 1 month -> Feb 2026 only has 28 days (2026 is not a leap year).
    const current = new Date("2026-01-31T09:30:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: 31, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-02-28T09:30:00.000Z") },
    });
  });

  it("clamps dayOfMonth to the target month length (leap-year February keeps 29)", async () => {
    const prisma = createPrismaMock();
    // Jan 30, skipping to March (interval 2) would overflow without clamping;
    // test the clamp both via dayOfMonth > daysInMonth on a leap February.
    const current = new Date("2024-01-30T08:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: 30, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2024-02-29T08:00:00.000Z") },
    });
  });

  it("claims the occurrence but creates no task when the next occurrence exceeds endDate", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: current,
        endDate: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    expect(result.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).not.toHaveBeenCalled();
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-26T09:00:00.000Z") },
    });
  });

  it("creates the next occurrence copying tags, custom fields, and assignee, due on rule.nextDueDate", async () => {
    const prisma = createPrismaMock();
    const ruleNextDueDate = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", interval: 1, nextDueDate: ruleNextDueDate }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    expect(result.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    const data = tx.task.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      projectId: PROJECT_ID,
      creatorId: ASSIGNEE_ID,
      assigneeId: ASSIGNEE_ID,
      title: "Water the plants",
      priority: "medium",
      dueDate: ruleNextDueDate,
      tags: { create: [{ tagId: TAG_ID }] },
      customFieldValues: { create: [{ customFieldId: CUSTOM_FIELD_ID, value: "weekly" }] },
    });
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: ruleNextDueDate },
      data: { nextDueDate: new Date("2026-05-20T09:00:00.000Z") },
    });
  });

  it("creates exactly one task when two concurrent processors race the same rule (M8)", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", interval: 1, nextDueDate: current }),
    ]);
    // The compare-and-swap: only the first caller's updateMany matches
    // nextDueDate; the loser reads count 0 because the advance already happened.
    prisma.recurrenceRule.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.all([
      processDueRecurrences(prisma as never),
      processDueRecurrences(prisma as never),
    ]);

    expect(first.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(second.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).toHaveBeenCalledTimes(1);
  });

  it("does not create a task when the compare-and-swap claim is lost", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", interval: 1 }),
    ]);
    prisma.recurrenceRule.updateMany.mockResolvedValue({ count: 0 });

    const result = await processDueRecurrences(prisma as never);

    expect(result.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).not.toHaveBeenCalled();
  });

  it("does not abort the batch when one rule throws, and rolls the claim back for retry", async () => {
    const prisma = createPrismaMock();
    const ruleOneNext = new Date("2026-05-19T09:00:00.000Z");
    const ruleTwoNext = new Date("2026-05-19T08:00:00.000Z");
    const ruleOne = createRule({ id: "cmab8yxxp0009i7p4k8n2v3qc", nextDueDate: ruleOneNext });
    const ruleTwo = createRule({
      id: "cmab8yxxp000ai7p4k8n2v3qc",
      nextDueDate: ruleTwoNext,
    });
    prisma.recurrenceRule.findMany.mockResolvedValue([ruleOne, ruleTwo]);
    createTaskWithNextNumber
      .mockRejectedValueOnce(new Error("task number allocation exploded"))
      .mockImplementationOnce(async (_client: unknown, _projectId: string, factory: (tx: unknown, taskNumber: number) => Promise<unknown>) => {
        const created = await factory(tx, 43);
        return (created as { id: string }) ?? { id: CREATED_TASK_ID };
      });

    const result = await processDueRecurrences(prisma as never);

    expect(createTaskWithNextNumber).toHaveBeenCalledTimes(2);
    expect(result.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(result.processed).toBe(2);
    // Rule one: claim succeeded, the create failed — the advance is rolled
    // back so the occurrence is retried on the next tick instead of being
    // silently skipped.
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: "cmab8yxxp0009i7p4k8n2v3qc", nextDueDate: new Date("2026-05-26T09:00:00.000Z") },
      data: { nextDueDate: ruleOneNext },
    });
    // Rule two: claimed and created exactly once.
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: "cmab8yxxp000ai7p4k8n2v3qc", nextDueDate: ruleTwoNext },
      data: { nextDueDate: new Date("2026-05-26T08:00:00.000Z") },
    });
  });
});
