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
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    retiredAt: null,
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

  it("retires a rule whose CURRENT occurrence is already past the end date in ONE step (terminal retiredAt, no task, wave-9 finding 3)", async () => {
    // CITADEL-ae2 (finding 4): reachable in normal operation now — the batch
    // query selects every rule with a due occurrence (nextDueDate <= now),
    // including rules whose end DAY has already passed (e.g. after scheduler
    // downtime). Wave-9 finding 3: the retirement is a SINGLE CAS setting the
    // terminal `retiredAt` flag — the old interval-walk (one nextDueDate
    // advance per tick) made a far-behind dead rule monopolize the due pool
    // for thousands of ticks and starve healthy due rules.
    const prisma = createPrismaMock();
    const current = new Date("2020-01-06T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        // Years behind the end date: the old branch would need thousands of
        // weekly advances to drain this rule.
        nextDueDate: current,
        endDate: new Date("2020-01-01T00:00:00.000Z"),
      }),
    ]);

    const now = new Date("2026-05-19T10:00:00.000Z");
    const result = await processDueRecurrences(prisma as never, { now });

    expect(result.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).not.toHaveBeenCalled();
    // Retirement: exactly ONE write, a CAS setting the terminal flag. No
    // nextDueDate walk happens in this tick (or any later tick — the flag
    // excludes the rule from selection forever).
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      // Wave-10 finding 3: the CAS reasserts the exact observed state
      // (retiredAt:null + the read nextDueDate + the read updatedAt).
      where: {
        id: RULE_ID,
        nextDueDate: current,
        retiredAt: null,
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      data: { retiredAt: now },
    });
  });

  it("does not starve a healthy due rule behind a batch of dead rules (wave-9 finding 3)", async () => {
    // The selection is oldest-nextDueDate-first: a pile of dead rules used to
    // fill every capped batch. A dead rule must retire in one CAS and the
    // healthy rule in the SAME batch must still get its occurrence created.
    const prisma = createPrismaMock();
    const deadRuleId = "cmab8yxxp000di7p4k8n2v3qe";
    const healthyRuleId = "cmab8yxxp000ei7p4k8n2v3qf";
    const deadCurrent = new Date("2019-02-01T09:00:00.000Z");
    const healthyCurrent = new Date("2026-05-19T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      // Dead rule: oldest nextDueDate, so it sorts first, and its occurrence
      // day (2019-02-01) is far past its end day (2019-01-01).
      createRule({
        id: deadRuleId,
        frequency: "daily",
        interval: 1,
        nextDueDate: deadCurrent,
        endDate: new Date("2019-01-01T00:00:00.000Z"),
      }),
      // Healthy rule: due now, no end date.
      createRule({
        id: healthyRuleId,
        frequency: "daily",
        interval: 1,
        nextDueDate: healthyCurrent,
      }),
    ]);

    const result = await processDueRecurrences(prisma as never);

    // The healthy rule produced its task in the same tick.
    expect(result.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    // The dead rule was retired in ONE step and no spurious task was created
    // for it (2 total rules processed, 1 task).
    expect(result.processed).toBe(2);
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: {
        id: deadRuleId,
        nextDueDate: deadCurrent,
        retiredAt: null,
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      data: { retiredAt: new Date("2026-05-19T10:00:00.000Z") },
    });
    // The healthy rule's claim ran on the transaction client as usual.
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: healthyRuleId, nextDueDate: healthyCurrent },
      data: { nextDueDate: new Date("2026-05-20T09:00:00.000Z") },
    });
  });

  // CITADEL-ae2 (finding 4): the batch query must NOT gate on endDate >= now.
  // That gate permanently excluded a rule whose final valid occurrence fell
  // due before the endDate but could only be processed after it (scheduler
  // downtime spanning the end date) — its final occurrence was never created.
  // Selection now keys on a due occurrence existing (nextDueDate <= now);
  // end-date validity is decided per rule in the loop, on the router's
  // dateKey day granularity.
  it("selects rules by due occurrence, excluding already-retired rules (finding 4 + wave-9 finding 3)", async () => {
    const prisma = createPrismaMock();
    const now = new Date("2026-05-21T10:00:00.000Z");

    await processDueRecurrences(prisma as never, { now });

    expect(prisma.recurrenceRule.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.recurrenceRule.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    // `retiredAt: null` keeps terminally-retired dead rules out of the due
    // pool forever — they leave it in one step and never return.
    expect(call.where).toEqual({ nextDueDate: { lte: now }, retiredAt: null });
  });

  // The bead's headline scenario: nextDueDate=2026-05-19, endDate=2026-05-20,
  // processed 2026-05-21 (scheduler was down past the end date). The May 19
  // occurrence is still valid (its day is on/before the endDate's day) and
  // MUST be created; the rule then retires via the claimed advance past the
  // end date, in the same transaction as the creation.
  it("creates the final valid occurrence of a rule processed after its endDate (downtime spanning the end date, finding 4)", async () => {
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

    const result = await processDueRecurrences(prisma as never, { now: new Date("2026-05-21T10:00:00.000Z") });

    // The May 19 task IS created (the old endDate >= now gate dropped this
    // rule from the batch entirely, so the occurrence never happened).
    expect(result.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    expect(tx.task.create.mock.calls[0][0].data).toMatchObject({ dueDate: current });
    // Retirement rides the claim: nextDueDate advances past the end date
    // inside the creation transaction, so the rule never becomes due again.
    expect(tx.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: { id: RULE_ID, nextDueDate: current },
      data: { nextDueDate: new Date("2026-05-26T09:00:00.000Z") },
    });
  });

  // The router (dateKey validation) accepts nextDueDate on the SAME calendar
  // day as endDate — e.g. a 09:00 occurrence with a midnight-normalized
  // endDate. Comparing exact timestamps here used to treat that valid
  // same-day occurrence as expired and retire the rule without creating it.
  it("creates a same-day occurrence when nextDueDate falls on the endDate's calendar day (finding 4)", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-20T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: current,
        endDate: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ]);

    const result = await processDueRecurrences(prisma as never, { now: new Date("2026-05-20T10:00:00.000Z") });

    expect(result.createdTaskIds).toEqual([CREATED_TASK_ID]);
    expect(tx.task.create.mock.calls[0][0].data).toMatchObject({ dueDate: current });
  });

  it("retires without creating when the current occurrence's DAY is past the endDate's day (finding 4, one-step, wave-9 finding 3)", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-21T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: current,
        endDate: new Date("2026-05-20T23:59:59.999Z"),
      }),
    ]);

    const now = new Date("2026-05-21T10:00:00.000Z");
    const result = await processDueRecurrences(prisma as never, { now });

    expect(result.createdTaskIds).toEqual([]);
    expect(createTaskWithNextNumber).not.toHaveBeenCalled();
    // One-step terminal retirement — nextDueDate is NOT advanced (the flag
    // alone removes the rule from every future selection).
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: {
        id: RULE_ID,
        nextDueDate: current,
        retiredAt: null,
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      data: { retiredAt: now },
    });
  });

  // Wave-10 finding 3: a router `set` reactivation (clears retiredAt,
  // rewrites the schedule, Prisma auto-touches updatedAt) racing the
  // scheduler between the processor's read and its retirement update must
  // WIN: the retirement CAS reasserts the observed state, matches 0 rows,
  // and does NOT retire the reactivated rule. The old predicate (id +
  // nextDueDate) still matched a same-due-date reactivation and clobbered it
  // with a stale retirement.
  it("does not retire a rule reactivated between the processor's read and the retirement CAS (wave-10 finding 3)", async () => {
    const prisma = createPrismaMock();
    const observedUpdatedAt = new Date("2026-05-01T00:00:00.000Z");
    const current = new Date("2026-05-21T09:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: current,
        endDate: new Date("2026-05-20T23:59:59.999Z"),
        updatedAt: observedUpdatedAt,
      }),
    ]);

    // A tiny in-memory row models the durable rule so the CAS predicate can
    // be evaluated the way Postgres would. The "router set" below mutates it
    // BETWEEN the read and the retirement write, exactly like a racing
    // reactivation.
    const row = {
      id: RULE_ID,
      nextDueDate: current,
      retiredAt: null as Date | null,
      updatedAt: observedUpdatedAt,
    };
    prisma.recurrenceRule.updateMany.mockImplementation(async (args: {
      where: { id: string; nextDueDate: Date; retiredAt: Date | null; updatedAt: Date };
      data: { retiredAt: Date };
    }) => {
      // The concurrent reactivation lands FIRST (racing the scheduler): the
      // router clears retiredAt, moves nextDueDate (still validating), and
      // Prisma's @updatedAt touch rewrites updatedAt.
      row.retiredAt = null;
      row.nextDueDate = new Date("2026-06-01T09:00:00.000Z");
      row.updatedAt = new Date("2026-05-19T09:59:59.000Z");
      // Now the CAS is evaluated against the mutated row:
      const matches =
        args.where.id === row.id &&
        (args.where.nextDueDate?.getTime() ?? -1) === (row.nextDueDate?.getTime() ?? -1) &&
        args.where.retiredAt === null && row.retiredAt === null &&
        (args.where.updatedAt?.getTime() ?? -1) === (row.updatedAt?.getTime() ?? -1);
      if (matches) {
        row.retiredAt = args.data.retiredAt;
        return { count: 1 };
      }
      return { count: 0 };
    });

    const now = new Date("2026-05-21T10:00:00.000Z");
    const result = await processDueRecurrences(prisma as never, { now });

    expect(result.createdTaskIds).toEqual([]);
    // The retirement CAS was attempted with reasserted state...
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: {
        id: RULE_ID,
        nextDueDate: current,
        retiredAt: null,
        updatedAt: observedUpdatedAt,
      },
      data: { retiredAt: now },
    });
    // ...but matched 0 rows (the reactivation touched the row), and the
    // reactivated rule STAYS ACTIVE: not retired, nextDueDate preserved.
    expect(row.retiredAt).toBeNull();
    expect(row.nextDueDate).toEqual(new Date("2026-06-01T09:00:00.000Z"));
    expect(row.updatedAt).toEqual(new Date("2026-05-19T09:59:59.000Z"));
  });

  it("still retires a genuinely dead rule when nothing races it (exact observed state matches)", async () => {
    const prisma = createPrismaMock();
    const current = new Date("2026-05-21T09:00:00.000Z");
    const observedUpdatedAt = new Date("2026-05-01T00:00:00.000Z");
    prisma.recurrenceRule.findMany.mockResolvedValue([
      createRule({
        frequency: "weekly",
        interval: 1,
        nextDueDate: current,
        endDate: new Date("2026-05-20T23:59:59.999Z"),
        updatedAt: observedUpdatedAt,
      }),
    ]);

    const now = new Date("2026-05-21T10:00:00.000Z");
    await processDueRecurrences(prisma as never, { now });

    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recurrenceRule.updateMany).toHaveBeenCalledWith({
      where: {
        id: RULE_ID,
        nextDueDate: current,
        retiredAt: null,
        updatedAt: observedUpdatedAt,
      },
      data: { retiredAt: now },
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