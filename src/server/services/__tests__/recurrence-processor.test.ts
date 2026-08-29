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
      // Standalone advances (endDate retirement only, since finding 5):
      // claim+create runs inside the task-creation transaction instead.
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
  let tx: {
    task: { create: ReturnType<typeof vi.fn> };
    recurrenceRule: { updateMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T10:00:00.000Z"));

    tx = {
      task: {
        create: vi.fn().mockResolvedValue({ id: CREATED_TASK_ID }),
      },
      // Finding 5: the occurrence claim runs on the SAME transaction client
      // the task is created on (the interactive transaction opened by
      // createTaskWithNextNumber), so a failure rolls both back together.
      recurrenceRule: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    createTaskWithNextNumber.mockImplementation(async (_client: unknown, _projectId: string, factory: (tx: unknown, taskNumber: number) => Promise<unknown>) => {
      const created = await factory(tx, 42);
      return created;
    });
    createTaskActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims the occurrence with a compare-and-swap inside the task-creation transaction (finding 5)", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", interval: 3, nextDueDate: current }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    expect(result.processed).toBe(1);
    // The CAS where-clause pins the value that was read, so only one of two
    // concurrent callers can win the occurrence — and it now runs on the tx
    // client, i.e. in the same transaction that creates the task.
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-22T09:00:00.000Z") },
    });
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
    // No standalone advance outside the transaction was committed.
    expect(prisma.recurrenceRule.updateMany).not.toHaveBeenCalled();
  });

  it("advances yearly rules by the interval in years", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "yearly", interval: 2, nextDueDate: current }),
    ]);

    await processDueRecurrences(prisma as never);

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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

    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2024-02-29T08:00:00.000Z") },
    });
  });

  it("retires a rule whose CURRENT occurrence is already past the end date with a standalone advance and no task (finding 9)", async () => {
    const prisma = createPrismaMock();
    // Defensive branch: only reachable with pre-existing data drift or direct
    // invocation — nextDueDate itself sits beyond endDate, so there is no
    // valid occurrence left to create.
    const current = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: current,
        endDate: new Date("2026-05-18T00:00:00.000Z"),
      }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    expect(result.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).not.toHaveBeenCalled();
    // Retirement advances the rule on the global client (no task creation
    // follows, so there is no claim/create gap to protect).
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-26T09:00:00.000Z") },
    });
  });

  // CITADEL-e10 (finding 9): the FINAL valid occurrence used to be dropped —
  // when only the following occurrence would land past the end date, the old
  // code retired the rule without ever creating the current occurrence's
  // task. The current occurrence is valid (nextDueDate <= endDate, guaranteed
  // by the batch query) and MUST get its task; retirement then happens inside
  // the same claim+create transaction (the claimed advance moves nextDueDate
  // past endDate, so the rule never becomes due again).
  it("creates the final occurrence's task and retires the rule in the same claim+create transaction (finding 9)", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");
    // Current occurrence May 19 is on/before the end date; the FOLLOWING
    // weekly occurrence (May 26) is past it.
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: current,
        endDate: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    // The final task IS created, due on the rule's current nextDueDate.
    expect(result.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(createTaskWithNextNumber).toHaveBeenCalledTimes(1);
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    expect(tx.task.create.mock.calls[0][0].data).toMatchObject({
      projectId: PROJECT_ID,
      title: "Water the plants",
      dueDate: current,
    });
    // Retirement is the claim itself: the claimed advance past the end date
    // commits atomically with the task creation — no standalone advance on
    // the global client.
    expect(prisma.recurrenceRule.updateMany).not.toHaveBeenCalled();
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-26T09:00:00.000Z") },
    });
  });

  it("rolls back the final occurrence's retirement when the task creation fails (finding 9)", async () => {
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
    tx.task.create.mockRejectedValueOnce(new Error("db write failed mid-transaction"));
    createTaskWithNextNumber.mockImplementationOnce(async (_client: unknown, _projectId: string, factory: (tx: unknown, taskNumber: number) => Promise<unknown>) => {
      return await factory(tx, 42);
    });

    const result = await processDueRecurrences(prisma as never);

    // The failure aborted the transaction: no task, and the retirement (the
    // claimed advance past endDate) rolled back with it — the occurrence
    // stays due and is retried on the next tick, and no standalone retirement
    // write ever committed.
    expect(result.createdTaskIds).toEqual([]);
    expect(prisma.recurrenceRule.updateMany).not.toHaveBeenCalled();
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
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
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
    // The compare-and-swap inside the creation transaction: the first
    // caller's claim matches (count 1); the loser's CAS already ran against
    // the advanced value and matches nothing (count 0), so it returns null
    // before ever writing a task row.
    tx.recurrenceRule.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.all([
      processDueRecurrences(prisma as never),
      processDueRecurrences(prisma as never),
    ]);

    expect(first.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(second.createdTaskIds).toEqual([]);
    expect(tx.task.create).toHaveBeenCalledTimes(1);
  });

  it("does not create a task when the compare-and-swap claim is lost", async () => {
    const prisma = createPrismaMock();
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "daily", interval: 1 }),
    ]);
    tx.recurrenceRule.updateMany.mockResolvedValue({ count: 0 });

    const result = await processDueRecurrences(prisma as never);

    expect(result.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).toHaveBeenCalledTimes(1);
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it("recovers an occurrence when task creation fails between claim and create (finding 5)", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-19T09:00:00.000Z");

    // First run: the claim (CAS) runs inside the transaction, then the task
    // creation itself blows up — the model for a crash between claim and
    // create (same transaction, so both roll back together).
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 1, nextDueDate: current }),
    ]);
    tx.task.create.mockRejectedValueOnce(new Error("db write failed mid-transaction"));
    const committedCreates: number[] = [];
    tx.task.create.mockImplementation(async () => {
      committedCreates.push(1);
      return { id: CREATED_TASK_ID };
    });
    createTaskWithNextNumber.mockImplementationOnce(async (_client: unknown, _projectId: string, factory: (tx: unknown, taskNumber: number) => Promise<unknown>) => {
      return await factory(tx, 42);
    });

    const first = await processDueRecurrences(prisma as never, { now: new Date("2026-05-19T10:00:00.000Z") });
    expect(first.createdTaskIds).toEqual([]);

    // Nothing about the occurrence was consumed: the claim shared the
    // transaction with the failed task creation, so it rolled back with it —
    // no committed advance and no compensating restore write on the global
    // client (the old code had to attempt one after the fact).
    expect(prisma.recurrenceRule.updateMany).not.toHaveBeenCalled();
    expect(prisma.recurrenceRule.updateMany).not.toHaveBeenCalled();

    // Simulate recovery: the next tick re-reads the same rule (still due —
    // nextDueDate was never advanced) and tries again.
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({ frequency: "weekly", interval: 1, nextDueDate: current }),
    ]);
    createTaskWithNextNumber.mockImplementationOnce(async (_client: unknown, _projectId: string, factory: (tx: unknown, taskNumber: number) => Promise<unknown>) => {
      const created = await factory(tx, 43);
      return created;
    });

    const second = await processDueRecurrences(prisma as never, { now: new Date("2026-05-19T11:00:00.000Z") });

    // No lost occurrence AND no duplicate: exactly one task row survives —
    // the failed attempt's create rolled back with the claim, and only the
    // recovery run's claim + create committed.
    expect(second.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(committedCreates).toHaveLength(1);
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.recurrenceRule.updateMany).toHaveBeenLastCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-26T09:00:00.000Z") },
    });
  });

  it("does not abort the batch when one rule throws, and recovers the failed occurrence on the next run (finding 5)", async () => {
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
        return created;
      });

    const result = await processDueRecurrences(prisma as never);

    expect(createTaskWithNextNumber).toHaveBeenCalledTimes(2);
    expect(result.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(result.processed).toBe(2);
    // Rule one: claim + failed create rolled back together inside the same
    // transaction — no standalone restore write needed.
    expect(prisma.recurrenceRule.updateMany).not.toHaveBeenCalled();
    // Rule two: claimed and created exactly once, on the tx client.
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: "cmab8yxxp000ai7p4k8n2v3qc", nextDueDate: ruleTwoNext },
      data: { nextDueDate: new Date("2026-05-26T08:00:00.000Z") },
    });
  });
});