import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentActor, requireProjectAccess } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock("@/server/authz", () => ({
  getCurrentActor,
  requireProjectAccess,
}));

import { createCallerFactory } from "@/server/trpc";
import { analyticsRouter } from "@/server/routers/analytics";

const createCaller = createCallerFactory(analyticsRouter);

const PROJECT_ID = "cmab8yxxp0001i7p4k8n2v3q4";
const USER_ID = "cmab8yxxp0002i7p4k8n2v3q5";
const STATUS_A_ID = "cmab8yxxp0003i7p4k8n2v3q6";
const STATUS_B_ID = "cmab8yxxp0004i7p4k8n2v3q7";

function createPrismaMock() {
  return {
    task: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    workflowStatus: {
      findMany: vi.fn(),
    },
    timeLog: {
      aggregate: vi.fn(),
    },
  } as const;
}

function buildAtRiskTask(index: number) {
  return {
    id: `cmab8yxxp001${index}i7p4k8n2v3qa`,
    taskNumber: index,
    title: `Overdue task ${index}`,
    dueDate: new Date("2026-05-01T00:00:00.000Z"),
    status: { id: STATUS_A_ID, name: "To Do", color: "#6b7280", category: "todo", isFinal: false },
    assignee: null,
  };
}

describe("analytics router projectSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentActor.mockResolvedValue({ id: USER_ID, role: "admin" });
    requireProjectAccess.mockResolvedValue({ membershipRole: "owner" });
  });

  it("reports DB-side counts and groupBy distributions beyond any take-500 truncation", async () => {
    const prisma = createPrismaMock();
    // Headline counts first, then the 7x2 velocity bucket counts.
    prisma.task.count
      .mockResolvedValueOnce(600)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(200)
      .mockResolvedValueOnce(50)
      .mockResolvedValue(0);
    prisma.task.groupBy
      .mockResolvedValueOnce([
        { statusId: STATUS_A_ID, _count: { _all: 350 } },
        { statusId: STATUS_B_ID, _count: { _all: 250 } },
      ])
      .mockResolvedValueOnce([
        { priority: "high", _count: { _all: 400 } },
        { priority: "none", _count: { _all: 200 } },
      ]);
    prisma.workflowStatus.findMany.mockResolvedValue([
      { id: STATUS_A_ID, name: "To Do", color: "#6b7280", order: 1 },
      { id: STATUS_B_ID, name: "Done", color: "#22c55e", order: 2 },
    ]);
    prisma.task.findMany
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          closedAt: new Date("2026-05-02T12:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => buildAtRiskTask(index)));
    prisma.timeLog.aggregate.mockResolvedValue({ _sum: { duration: 7200 } });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    const summary = await caller.projectSummary({ projectId: PROJECT_ID });

    expect(summary.totalTasks).toBe(600);
    expect(summary.activeTasks).toBe(500);
    expect(summary.completedTasks).toBe(200);
    expect(summary.overdueTasks).toBe(50);
    expect(summary.completionRate).toBe(33);
    expect(summary.avgCycleTimeHours).toBe(36);
    expect(summary.loggedSeconds).toBe(7200);
    expect(summary.atRiskTasks).toHaveLength(10);
    expect(summary.statusDistribution).toEqual([
      { id: STATUS_A_ID, name: "To Do", color: "#6b7280", count: 350 },
      { id: STATUS_B_ID, name: "Done", color: "#22c55e", count: 250 },
    ]);
    expect(summary.priorityDistribution).toEqual([
      { priority: "none", count: 200 },
      { priority: "high", count: 400 },
    ]);
    expect(summary.velocity).toHaveLength(7);

    // Totals must come from count()/groupBy(), never from a truncated task fetch.
    const atRiskFind = prisma.task.findMany.mock.calls.find((call) => call[0].select?.status !== undefined);
    expect(atRiskFind?.[0].take).toBeLessThanOrEqual(10);
  });

  it("returns the full projectSummary response shape from the invariants", async () => {
    const prisma = createPrismaMock();
    prisma.task.count.mockResolvedValue(0);
    prisma.task.groupBy.mockResolvedValue([]);
    prisma.workflowStatus.findMany.mockResolvedValue([]);
    prisma.task.findMany.mockResolvedValue([]);
    prisma.timeLog.aggregate.mockResolvedValue({ _sum: { duration: null } });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    const summary = await caller.projectSummary({ projectId: PROJECT_ID });

    expect(Object.keys(summary).sort()).toEqual([
      "activeTasks",
      "atRiskTasks",
      "avgCycleTimeHours",
      "completedTasks",
      "completionRate",
      "loggedSeconds",
      "overdueTasks",
      "priorityDistribution",
      "statusDistribution",
      "totalTasks",
      "velocity",
    ]);
    expect(summary.avgCycleTimeHours).toBeNull();
    expect(summary.atRiskTasks).toEqual([]);
    expect(summary.velocity.every((entry) => typeof entry.date === "string" && entry.created === 0 && entry.completed === 0)).toBe(true);
  });

  it("scopes every aggregate to the sprint when sprintId is provided", async () => {
    const prisma = createPrismaMock();
    const sprintId = "cmab8yxxp0005i7p4k8n2v3q8";
    prisma.task.count.mockResolvedValue(0);
    prisma.task.groupBy.mockResolvedValue([]);
    prisma.workflowStatus.findMany.mockResolvedValue([]);
    prisma.task.findMany.mockResolvedValue([]);
    prisma.timeLog.aggregate.mockResolvedValue({ _sum: { duration: null } });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await caller.projectSummary({ projectId: PROJECT_ID, sprintId });

    for (const call of prisma.task.count.mock.calls) {
      expect(call[0].where).toMatchObject({ projectId: PROJECT_ID, sprintId });
    }
    for (const call of prisma.task.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({ projectId: PROJECT_ID, sprintId });
    }
    expect(prisma.timeLog.aggregate).toHaveBeenCalledWith({
      where: { task: { projectId: PROJECT_ID, sprintId } },
      _sum: { duration: true },
    });
  });
});
