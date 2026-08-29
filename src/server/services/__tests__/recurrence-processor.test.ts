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
      update: vi.fn().mockResolvedValue({}),
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

  it("advances nextDueDate by frequency x interval", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", interval: 3, nextDueDate: new Date("2026-05-19T09:00:00.000Z") }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    expect(result.processed).toBe(1);
    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-05-22T09:00:00.000Z") },
    });
  });

  it("advances yearly rules by the interval in years", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "yearly", interval: 2, nextDueDate: new Date("2026-05-19T09:00:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2028-05-19T09:00:00.000Z") },
    });
  });

  it("keeps weekly rules without dayOfWeek on the plain interval*7 step", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 2, dayOfWeek: null, nextDueDate: new Date("2026-05-18T09:00:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-06-01T09:00:00.000Z") },
    });
  });

  it("honours dayOfWeek for weekly rules by landing on the next matching weekday", async () => {
    const prisma = createPrismaMock();
    // 2026-05-15 is a Friday; dayOfWeek=1 means Monday. Step lands Fri 05-22,
    // then snaps forward to Mon 2026-05-25.
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 1, dayOfWeek: 1, nextDueDate: new Date("2026-05-15T09:00:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-05-25T09:00:00.000Z") },
    });
  });

  it("keeps already-aligned weekly dayOfWeek rules exactly on the interval cadence", async () => {
    const prisma = createPrismaMock();
    // 2026-05-18 is a Monday, dayOfWeek=1 -> next occurrence stays weekly on Monday.
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 1, dayOfWeek: 1, nextDueDate: new Date("2026-05-18T09:00:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-05-25T09:00:00.000Z") },
    });
  });

  it("keeps monthly rules without dayOfMonth on the legacy month step", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: null, nextDueDate: new Date("2026-01-15T09:00:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-02-15T09:00:00.000Z") },
    });
  });

  it("honours dayOfMonth for monthly rules with time of day preserved", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: 15, nextDueDate: new Date("2026-01-20T09:30:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-02-15T09:30:00.000Z") },
    });
  });

  it("clamps dayOfMonth to the target month length (month-end)", async () => {
    const prisma = createPrismaMock();
    // Jan 31 + 1 month -> Feb 2026 only has 28 days (2026 is not a leap year).
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: 31, nextDueDate: new Date("2026-01-31T09:30:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-02-28T09:30:00.000Z") },
    });
  });

  it("clamps dayOfMonth to the target month length (leap-year February keeps 29)", async () => {
    const prisma = createPrismaMock();
    // Jan 30, skipping to March (interval 2) would overflow without clamping;
    // test the clamp both via dayOfMonth > daysInMonth on a leap February.
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "monthly", interval: 1, dayOfMonth: 30, nextDueDate: new Date("2024-01-30T08:00:00.000Z") }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2024-02-29T08:00:00.000Z") },
    });
  });

  it("updates the rule but creates no task when the next occurrence exceeds endDate", async () => {
    const prisma = createPrismaMock();
    const nextWouldBe = new Date("2026-05-26T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: new Date("2026-05-19T09:00:00.000Z"),
        endDate: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    expect(result.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).not.toHaveBeenCalled();
    expect(prisma.recurrenceRule.update).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: nextWouldBe },
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
    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { nextDueDate: new Date("2026-05-20T09:00:00.000Z") },
    });
  });

  it("does not abort the batch when one rule throws", async () => {
    const prisma = createPrismaMock();
    const ruleOne = createRule({ id: "cmab8yxxp0009i7p4k8n2v3qc", nextDueDate: new Date("2026-05-19T09:00:00.000Z") });
    const ruleTwo = createRule({
      id: "cmab8yxxp000ai7p4k8n2v3qc",
      nextDueDate: new Date("2026-05-19T08:00:00.000Z"),
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
    expect(prisma.recurrenceRule.update).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.update).toHaveBeenCalledWith({
      where: { id: "cmab8yxxp000ai7p4k8n2v3qc" },
      data: expect.objectContaining({ nextDueDate: expect.any(Date) }),
    });
  });
});