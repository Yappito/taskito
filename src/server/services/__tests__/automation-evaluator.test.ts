import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getEffectiveProjectAccess,
  createCallerFactory,
  taskCallerCalls,
  taskCallerSessions,
} = vi.hoisted(() => ({
  getEffectiveProjectAccess: vi.fn(),
  createCallerFactory: vi.fn(),
  taskCallerCalls: [] as Array<{ action: string; input: unknown }>,
  taskCallerSessions: [] as Array<string | undefined>,
}));

vi.mock("@/server/authz", () => ({
  getEffectiveProjectAccess,
}));

// The evaluator builds a tRPC caller for the real task router; replace the
// router module (its construction pulls the whole tRPC builder) and the
// factory so automation actions are recorded without exercising task authz.
vi.mock("@/server/routers/task", () => ({
  taskRouter: {},
}));

vi.mock("@/server/trpc", () => ({
  createCallerFactory,
}));

import {
  AUTOMATION_ACTION_PERMISSIONS,
  actorCanExecuteAutomationAction,
  processDueDateAutomationRules,
  resolveAutomationRuleActorId,
} from "@/server/services/automation-evaluator";

const PROJECT_A = "cmab8yxxp0001i7p4k8n2v3q4";
const PROJECT_B = "cmab8yxxp0002i7p4k8n2v3q5"; // referenced by cross-project payload checks
const CREATOR_ID = "cmab8yxxp0003i7p4k8n2v3q6";
const TASK_A = "cmab8yxxp0005i7p4k8n2v3q8";

const NOW = new Date("2026-05-19T10:00:00.000Z");
const DUE_YESTERDAY = new Date("2026-05-18T09:00:00.000Z");
const DUE_LAST_WEEK = new Date("2026-05-12T09:00:00.000Z");

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed on the fields: (`ruleId`,`taskId`,`dueDate`)"), {
    code: "P2002",
  });
}

function createRuleFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmab8yxxp0006i7p4k8n2v3q9",
    projectId: PROJECT_A,
    name: "Overdue comment",
    isEnabled: true,
    trigger: "dueDatePassed",
    triggerCondition: null,
    action: "addComment",
    actionPayload: { content: "This task is overdue" },
    createdByUserId: CREATOR_ID,
    ...overrides,
  };
}

function createTaskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_A,
    projectId: PROJECT_A,
    dueDate: DUE_YESTERDAY,
    statusId: "cmab8yxxp000ai7p4k8n2v3qd",
    assigneeId: null,
    priority: "medium",
    ...overrides,
  };
}

function createPrismaMock() {
  const claimedKeys = new Set<string>();
  const prisma = {
    automationRule: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    automationRuleFiring: {
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    automationRun: {
      create: vi.fn().mockResolvedValue({}),
    },
    task: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ id: TASK_A, projectId: PROJECT_A }),
      findFirst: vi.fn().mockResolvedValue({ id: TASK_A }),
    },
    workflowStatus: {
      findFirst: vi.fn().mockResolvedValue({ id: "cmab8yxxp000ai7p4k8n2v3qd" }),
    },
    tag: {
      findFirst: vi.fn().mockResolvedValue({ id: "cmab8yxxp000bi7p4k8n2v3qe" }),
    },
    projectMember: {
      findFirst: vi.fn().mockResolvedValue({ userId: CREATOR_ID }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: CREATOR_ID, disabledAt: null }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: CREATOR_ID,
        role: "member",
        email: "creator@example.com",
        name: "Creator",
        image: null,
      }),
    },
  };

  /**
   * Simulates the UNIQUE (ruleId, taskId, dueDate) claim table: the first
   * claim of an occurrence wins; any later claim of the same triple rejects
   * with P2002, exactly like Postgres.
   */
  prisma.automationRuleFiring.create.mockImplementation(async (args: { data: { ruleId: string; taskId: string; dueDate: Date } }) => {
    const key = `${args.data.ruleId}:${args.data.taskId}:${args.data.dueDate.toISOString()}`;
    if (claimedKeys.has(key)) {
      throw uniqueViolation();
    }
    claimedKeys.add(key);
    return { id: `firing:${key}` };
  });

  // Releasing an occurrence (action failed) makes it claimable again.
  prisma.automationRuleFiring.deleteMany.mockImplementation(async (args?: { where?: { ruleId?: string; taskId?: string; dueDate?: Date } }) => {
    const where = args?.where ?? {};
    let removed = 0;
    for (const key of [...claimedKeys]) {
      const [ruleId, taskId] = key.split(":") as [string, string];
      // The ISO due date contains colons, so re-join everything after the taskId.
      const keyDueIso = key.slice(ruleId.length + 1 + taskId.length + 1);
      if (
        (!where.ruleId || ruleId === where.ruleId)
        && (!where.taskId || taskId === where.taskId)
        && (!where.dueDate || keyDueIso === where.dueDate.toISOString())
      ) {
        claimedKeys.delete(key);
        removed += 1;
      }
    }
    return { count: removed };
  });

  /** Exposes the claim set so a test can "tick again" against real state. */
  (prisma as unknown as { __claimedKeys: Set<string> }).__claimedKeys = claimedKeys;

  return prisma;
}

function wireOverdueTasks(prisma: ReturnType<typeof createPrismaMock>, tasks: Array<ReturnType<typeof createTaskFixture>>) {
  prisma.task.findMany.mockImplementation(async (args?: { take?: number; cursor?: { id?: string } }) => {
    const take = args?.take ?? 100;
    let start = 0;
    const cursorId = args?.cursor?.id;
    if (cursorId) {
      start = tasks.findIndex((task) => task.id === cursorId) + 1;
      if (start === 0) {
        return [];
      }
    }
    return tasks.slice(start, start + take);
  });
}

beforeEach(() => {
  taskCallerCalls.length = 0;
  taskCallerSessions.length = 0;
  createCallerFactory.mockImplementation(() => {
    return (ctx: { session: { user: { id?: string } } }) => {
      const record = (action: string, input: unknown) => {
        taskCallerCalls.push({ action, input });
        taskCallerSessions.push(ctx?.session?.user?.id);
        return { id: typeof (input as { id?: string })?.id === "string" ? (input as { id: string }).id : TASK_A };
      };
      return {
        update: (input: unknown) => record("update", input),
        addTags: (input: unknown) => record("addTags", input),
        removeTag: (input: unknown) => record("removeTag", input),
        addComment: (input: unknown) => record("addComment", input),
        archive: (input: unknown) => record("archive", input),
        unarchive: (input: unknown) => record("unarchive", input),
      };
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("automation action permission map (H3c)", () => {
  it("maps every action to the underlying project permission", () => {
    expect(AUTOMATION_ACTION_PERMISSIONS.moveStatus).toBe("task_update");
    expect(AUTOMATION_ACTION_PERMISSIONS.assignTask).toBe("task_update");
    expect(AUTOMATION_ACTION_PERMISSIONS.addTag).toBe("task_update");
    expect(AUTOMATION_ACTION_PERMISSIONS.removeTag).toBe("task_update");
    expect(AUTOMATION_ACTION_PERMISSIONS.addComment).toBe("task_comment");
    expect(AUTOMATION_ACTION_PERMISSIONS.archiveTask).toBe("task_archive");
    expect(AUTOMATION_ACTION_PERMISSIONS.unarchiveTask).toBe("task_archive");
  });

  it("checks the action permission, not just automation_manage", async () => {
    const prisma = createPrismaMock();
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage"]),
    });

    expect(await actorCanExecuteAutomationAction(prisma as never, CREATOR_ID, PROJECT_A, "addComment")).toBe(false);
    expect(await actorCanExecuteAutomationAction(prisma as never, CREATOR_ID, PROJECT_A, "moveStatus")).toBe(false);
  });
});

describe("resolveAutomationRuleActorId (H3b: creator attribution)", () => {
  it("uses the rule creator as the scheduled actor", async () => {
    const prisma = createPrismaMock();
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });

    const actorId = await resolveAutomationRuleActorId(prisma as never, {
      id: "rule-1",
      projectId: PROJECT_A,
      action: "addComment",
      createdByUserId: CREATOR_ID,
    });

    expect(actorId).toBe(CREATOR_ID);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CREATOR_ID } }),
    );
  });

  it("skips the rule when the creator no longer exists", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const actorId = await resolveAutomationRuleActorId(prisma as never, {
      id: "rule-1",
      projectId: PROJECT_A,
      action: "addComment",
      createdByUserId: CREATOR_ID,
    });

    expect(actorId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("creator"));
    warnSpy.mockRestore();
  });

  it("skips the rule when the creator has since been disabled", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: CREATOR_ID, disabledAt: new Date() });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const actorId = await resolveAutomationRuleActorId(prisma as never, {
      id: "rule-1",
      projectId: PROJECT_A,
      action: "addComment",
      createdByUserId: CREATOR_ID,
    });

    expect(actorId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    warnSpy.mockRestore();
  });

  it("skips the rule when the creator lost automation_manage or the action permission", async () => {
    const prisma = createPrismaMock();
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set<string>(), // lost both automation_manage and task_comment
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const actorId = await resolveAutomationRuleActorId(prisma as never, {
      id: "rule-1",
      projectId: PROJECT_A,
      action: "addComment",
      createdByUserId: CREATOR_ID,
    });

    expect(actorId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("automation_manage, task_comment"));
    warnSpy.mockRestore();
  });

  it("never falls back to the owner or earliest member for rules without a creator", async () => {
    const prisma = createPrismaMock();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const actorId = await resolveAutomationRuleActorId(prisma as never, {
      id: "rule-1",
      projectId: PROJECT_A,
      action: "addComment",
      createdByUserId: null,
    });

    expect(actorId).toBeNull();
    // No member lookup that could resolve an "earliest member" fallback.
    expect(prisma.projectMember.findFirst).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no creator"));
    warnSpy.mockRestore();
  });
});

describe("processDueDateAutomationRules (scheduled execution)", () => {
  it("executes a due rule as the rule creator (H3b/H3c)", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([
      createRuleFixture({ action: "addComment", actionPayload: { content: "overdue!" } }),
    ]);
    wireOverdueTasks(prisma, [createTaskFixture({})]);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });

    const result = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(result.fired).toBe(1);
    expect(taskCallerCalls).toEqual([
      { action: "addComment", input: { taskId: TASK_A, content: "overdue!" } },
    ]);
    // The action ran with the creator's session — never the project owner's.
    expect(taskCallerSessions).toEqual([CREATOR_ID]);
  });

  it("skips a scheduled rule whose creator is disabled (H3b)", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([createRuleFixture({})]);
    wireOverdueTasks(prisma, [createTaskFixture({})]);
    prisma.user.findUnique.mockResolvedValue({ id: CREATOR_ID, disabledAt: new Date() });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(result.fired).toBe(0);
    expect(result.skippedRules).toBe(1);
    expect(taskCallerCalls).toEqual([]);
    warnSpy.mockRestore();
  });

  it("skips a scheduled rule whose creator lost the underlying action permission (H3c)", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([
      createRuleFixture({ action: "moveStatus", actionPayload: { statusId: "cmab8yxxp000ai7p4k8n2v3qd" } }),
    ]);
    wireOverdueTasks(prisma, [createTaskFixture({})]);
    // Creator keeps automation_manage but lost task_update.
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage"]),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(result.fired).toBe(0);
    expect(result.skippedRules).toBe(1);
    expect(taskCallerCalls).toEqual([]);
    warnSpy.mockRestore();
  });

  it("rejects a stored actionPayload whose taskId points into another project (H3d)", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([
      createRuleFixture({
        actionPayload: { taskId: "cmab8yxxp000ci7p4k8n2v3qf", content: "smuggled" },
      }),
    ]);
    wireOverdueTasks(prisma, [createTaskFixture({})]);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });
    // The payload task lives in project B.
    prisma.task.findFirst.mockResolvedValue(null);
    const runSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(result.fired).toBe(0);
    // The failure is recorded, not thrown past the loop.
    expect(prisma.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(taskCallerCalls).toEqual([]);
    runSpy.mockRestore();
  });

  it("rejects an addComment action whose target task is in another project (H3d, execution-time re-check)", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([createRuleFixture({})]);
    wireOverdueTasks(prisma, [createTaskFixture({})]);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });
    // Task-level lookup says the target belongs to project B.
    prisma.task.findUnique.mockResolvedValue({ id: TASK_A, projectId: PROJECT_B });

    const result = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(result.fired).toBe(0);
    expect(prisma.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", message: expect.stringContaining("not in the rule's project") }),
      }),
    );
    expect(taskCallerCalls).toEqual([]);
  });
});

describe("due-date firing claims (H4: write amplification)", () => {
  it("fires the rule once per task across two consecutive ticks", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([createRuleFixture({})]);
    wireOverdueTasks(prisma, [
      createTaskFixture({ id: TASK_A }),
      createTaskFixture({ id: "cmab8yxxp000di7p4k8n2v3qg", dueDate: DUE_LAST_WEEK }),
    ]);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });

    const firstTick = await processDueDateAutomationRules(prisma as never, { now: NOW });
    const secondTick = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(firstTick.fired).toBe(2);
    // The second tick must not re-fire: every occurrence is already claimed.
    expect(secondTick.fired).toBe(0);
    expect(taskCallerCalls).toHaveLength(2);
    // Without the claim each tick would have commented again on both tasks.
    expect(prisma.automationRuleFiring.create).toHaveBeenCalledTimes(4); // 2 claims + 2 duplicate rejections
  });

  it("fires again for a new due-date occurrence after the due date changed", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([createRuleFixture({})]);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });

    // Tick 1: task overdue at DUE_YESTERDAY.
    wireOverdueTasks(prisma, [createTaskFixture({ dueDate: DUE_YESTERDAY })]);
    const firstTick = await processDueDateAutomationRules(prisma as never, { now: NOW });
    expect(firstTick.fired).toBe(1);

    // Tick 2: the due date moved (snoozed) and is overdue again — a new
    // occurrence that must fire even though the task was claimed before.
    wireOverdueTasks(prisma, [createTaskFixture({ dueDate: new Date("2026-05-19T08:00:00.000Z") })]);
    const secondTick = await processDueDateAutomationRules(prisma as never, { now: NOW });
    expect(secondTick.fired).toBe(1);
    expect(taskCallerCalls).toHaveLength(2);
  });

  it("processes all overdue tasks across pages instead of starving past the first 100 (H4)", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([createRuleFixture({})]);
    const overdueTasks = Array.from({ length: 250 }, (_, index) =>
      createTaskFixture({
        id: `cmab8yxxp09${String(index).padStart(19, "0")}`,
        dueDate: DUE_YESTERDAY,
      }),
    );
    wireOverdueTasks(prisma, overdueTasks);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });

    const result = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(result.fired).toBe(250);
    expect(taskCallerCalls).toHaveLength(250);
    // Cursor pagination paged past the first 100 (pages of up to 100) instead
    // of starving the backlog.
    expect(prisma.task.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.task.findMany.mock.calls[0][0]).toMatchObject({ take: 100 });
    expect(prisma.task.findMany.mock.calls[1][0]).toMatchObject({ take: 100, skip: 1 });
    expect(prisma.task.findMany.mock.calls[2][0]).toMatchObject({ take: 100, skip: 1 });
  });

  it("frees the occurrence when the action fails so the next tick can retry", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([createRuleFixture({})]);
    wireOverdueTasks(prisma, [createTaskFixture({})]);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });
    const failingFactory = createCallerFactory;
    failingFactory.mockImplementationOnce(() => () => ({
      update: () => {
        throw new Error("task update exploded");
      },
      addTags: () => {
        throw new Error("task update exploded");
      },
      removeTag: () => {
        throw new Error("task update exploded");
      },
      addComment: () => {
        throw new Error("task update exploded");
      },
      archive: () => {
        throw new Error("task update exploded");
      },
      unarchive: () => {
        throw new Error("task update exploded");
      },
    }));

    const firstTick = await processDueDateAutomationRules(prisma as never, { now: NOW });
    expect(firstTick.fired).toBe(0);
    expect(prisma.automationRuleFiring.deleteMany).toHaveBeenCalledWith({
      where: { ruleId: createRuleFixture({}).id, taskId: TASK_A, dueDate: DUE_YESTERDAY },
    });

    // Second tick: the occurrence is claimable again and now succeeds.
    const secondTick = await processDueDateAutomationRules(prisma as never, { now: NOW });
    expect(secondTick.fired).toBe(1);
    expect(taskCallerCalls).toHaveLength(1);
  });

  it("respects the rule's trigger condition before claiming", async () => {
    const prisma = createPrismaMock();
    prisma.automationRule.findMany.mockResolvedValue([
      createRuleFixture({ triggerCondition: { priority: "urgent" } }),
    ]);
    wireOverdueTasks(prisma, [createTaskFixture({ priority: "low" })]);
    getEffectiveProjectAccess.mockResolvedValue({
      actor: { disabledAt: null },
      permissions: new Set(["automation_manage", "task_comment"]),
    });

    const result = await processDueDateAutomationRules(prisma as never, { now: NOW });

    expect(result.fired).toBe(0);
    // The claim was never taken for a non-matching task.
    expect(prisma.automationRuleFiring.create).not.toHaveBeenCalled();
    expect(taskCallerCalls).toEqual([]);
  });
});
