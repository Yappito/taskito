import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireProjectAccess,
  requireTagAccess,
  requireTaskAccess,
  requireTaskLinkAccess,
  requireWorkflowStatusAccess,
  autoTagTask,
  createTaskActivity,
  evaluateAutomationRules,
  isAutomationExecutionActive,
} = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireTagAccess: vi.fn(),
  requireTaskAccess: vi.fn(),
  requireTaskLinkAccess: vi.fn(),
  requireWorkflowStatusAccess: vi.fn(),
  autoTagTask: vi.fn(),
  createTaskActivity: vi.fn(),
  evaluateAutomationRules: vi.fn(),
  isAutomationExecutionActive: vi.fn(),
}));

vi.mock("@/server/authz", () => ({
  requireProjectAccess,
  requireTagAccess,
  requireTaskAccess,
  requireTaskLinkAccess,
  requireWorkflowStatusAccess,
}));

vi.mock("@/server/services/auto-tagger", () => ({
  autoTagTask,
}));

vi.mock("@/server/services/task-activity", () => ({
  createTaskActivity,
}));

vi.mock("@/server/services/automation-evaluator", () => ({
  evaluateAutomationRules,
  isAutomationExecutionActive,
}));

import { createCallerFactory } from "@/server/trpc";
import { taskRouter } from "@/server/routers/task";

const createCaller = createCallerFactory(taskRouter);

const PROJECT_ID = "cmab8yxxp0001i7p4k8n2v3q4";
const USER_ID = "cmab8yxxp0002i7p4k8n2v3q5";
const STATUS_ID = "cmab8yxxp0003i7p4k8n2v3q6";
const SOURCE_TASK_ID = "cmab8yxxp0004i7p4k8n2v3q7";
const TAG_ID = "cmab8yxxp0005i7p4k8n2v3q8";
const NOW = new Date("2026-05-19T09:00:00.000Z");

function createPrismaMock() {
  const prisma = {
    user: {
      findUnique: vi.fn(),
    },
    project: {
      findUniqueOrThrow: vi.fn(),
    },
    workflowStatus: {
      findFirst: vi.fn(),
    },
    tag: {
      findMany: vi.fn(),
    },
    task: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workflowTransition: {
      findFirst: vi.fn(),
    },
    taskTag: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    taskWatcher: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) => await callback(prisma)),
  };

  return prisma;
}

describe("task router auto-archive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();

    requireProjectAccess.mockResolvedValue({ actor: { id: USER_ID, role: "owner" }, membershipRole: "owner" });
    requireTaskAccess.mockResolvedValue({ id: SOURCE_TASK_ID, projectId: PROJECT_ID, statusId: STATUS_ID });
    requireWorkflowStatusAccess.mockResolvedValue({
      id: STATUS_ID,
      projectId: PROJECT_ID,
      isFinal: false,
      autoArchive: true,
      autoArchiveDays: 3,
    });
    autoTagTask.mockResolvedValue(undefined);
    createTaskActivity.mockResolvedValue(undefined);
    evaluateAutomationRules.mockResolvedValue(undefined);
    isAutomationExecutionActive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies auto-archive when create resolves the initial status from project defaults", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, role: "admin", projectMemberships: [] });
    prisma.project.findUniqueOrThrow.mockResolvedValue({
      id: PROJECT_ID,
      settings: { defaultStatusId: STATUS_ID },
    });
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 41 });
    prisma.task.create.mockResolvedValue({
      id: "cmab8yxxp0006i7p4k8n2v3q9",
      projectId: PROJECT_ID,
      title: "Ship auto-archive",
      statusId: STATUS_ID,
      assigneeId: USER_ID,
      priority: "none",
    });
    prisma.taskWatcher.create.mockResolvedValue({ taskId: "cmab8yxxp0006i7p4k8n2v3q9", userId: USER_ID });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await caller.create({
      projectId: PROJECT_ID,
      title: "Ship auto-archive",
      dueDate: new Date("2026-06-01T12:00:00.000Z"),
      priority: "none",
    });

    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          statusId: STATUS_ID,
          taskNumber: 42,
          archivedAt: new Date("2026-05-22T09:00:00.000Z"),
          closedAt: null,
        }),
      })
    );
  });

  it("leaves archivedAt null on create when the selected status does not auto-archive", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, role: "admin", projectMemberships: [] });
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 10 });
    prisma.task.create.mockResolvedValue({
      id: "cmab8yxxp0012i7p4k8n2v3qf",
      projectId: PROJECT_ID,
      title: "Stay visible",
      statusId: STATUS_ID,
      assigneeId: USER_ID,
      priority: "none",
    });
    prisma.taskWatcher.create.mockResolvedValue({ taskId: "cmab8yxxp0012i7p4k8n2v3qf", userId: USER_ID });
    requireWorkflowStatusAccess.mockResolvedValue({
      id: STATUS_ID,
      projectId: PROJECT_ID,
      isFinal: false,
      autoArchive: false,
      autoArchiveDays: 0,
    });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await caller.create({
      projectId: PROJECT_ID,
      title: "Stay visible",
      statusId: STATUS_ID,
      dueDate: new Date("2026-06-01T12:00:00.000Z"),
      priority: "none",
    });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          statusId: STATUS_ID,
          archivedAt: null,
        }),
      })
    );
  });

  it("recomputes archivedAt from the duplicated status instead of copying the source archive state", async () => {
    const prisma = createPrismaMock();
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 7 });
    prisma.task.findUniqueOrThrow.mockResolvedValue({
      id: SOURCE_TASK_ID,
      projectId: PROJECT_ID,
      title: "Closed task",
      description: null,
      body: "Source body",
      statusId: STATUS_ID,
      status: {
        autoArchive: true,
        autoArchiveDays: 3,
      },
      closedAt: new Date("2026-05-10T09:00:00.000Z"),
      archivedAt: new Date("2026-05-11T09:00:00.000Z"),
      priority: "high",
      dueDate: new Date("2026-06-02T12:00:00.000Z"),
      startDate: new Date("2026-05-20T12:00:00.000Z"),
      assigneeId: USER_ID,
      sprintId: null,
      tags: [{ tagId: TAG_ID }],
    });
    prisma.task.create.mockResolvedValue({
      id: "cmab8yxxp0007i7p4k8n2v3qa",
      projectId: PROJECT_ID,
      title: "Copy of Closed task",
      statusId: STATUS_ID,
      assigneeId: USER_ID,
      priority: "high",
    });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await caller.duplicate({ id: SOURCE_TASK_ID });

    expect(prisma.task.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SOURCE_TASK_ID },
        include: expect.objectContaining({
          status: {
            select: {
              autoArchive: true,
              autoArchiveDays: true,
            },
          },
        }),
      })
    );
    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          closedAt: null,
          archivedAt: new Date("2026-05-22T09:00:00.000Z"),
          tags: { create: [{ tagId: TAG_ID }] },
        }),
      })
    );
  });

  it("keeps duplicated tasks unarchived when their status does not auto-archive", async () => {
    const prisma = createPrismaMock();
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 18 });
    prisma.task.findUniqueOrThrow.mockResolvedValue({
      id: SOURCE_TASK_ID,
      projectId: PROJECT_ID,
      title: "Active task",
      description: null,
      body: null,
      statusId: STATUS_ID,
      status: {
        autoArchive: false,
        autoArchiveDays: 0,
      },
      closedAt: null,
      archivedAt: new Date("2026-05-11T09:00:00.000Z"),
      priority: "medium",
      dueDate: new Date("2026-06-02T12:00:00.000Z"),
      startDate: null,
      assigneeId: USER_ID,
      sprintId: null,
      tags: [],
    });
    prisma.task.create.mockResolvedValue({
      id: "cmab8yxxp0013i7p4k8n2v3qg",
      projectId: PROJECT_ID,
      title: "Copy of Active task",
      statusId: STATUS_ID,
      assigneeId: USER_ID,
      priority: "medium",
    });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await caller.duplicate({ id: SOURCE_TASK_ID });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          closedAt: null,
          archivedAt: null,
        }),
      })
    );
  });

  it("does not reset archivedAt on update when the status stays the same", async () => {
    const prisma = createPrismaMock();
    prisma.task.findUniqueOrThrow
      .mockResolvedValueOnce({
        assigneeId: USER_ID,
        closedAt: null,
        statusId: STATUS_ID,
        priority: "medium",
        sprintId: null,
      })
      .mockResolvedValueOnce({
        id: SOURCE_TASK_ID,
        sourceLinks: [],
        targetLinks: [],
      });
    prisma.task.update.mockResolvedValue({
      id: SOURCE_TASK_ID,
      statusId: STATUS_ID,
      assigneeId: USER_ID,
      priority: "medium",
      title: "Re-saved task",
      project: { key: "TASK", slug: "taskito" },
      status: { id: STATUS_ID },
      tags: [],
      creator: null,
      assignee: null,
    });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await caller.update({
      id: SOURCE_TASK_ID,
      statusId: STATUS_ID,
    });

    expect(prisma.workflowTransition.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          archivedAt: expect.anything(),
          closedAt: expect.anything(),
        }),
      })
    );
  });

  it("only applies status-derived auto-archive to bulk-updated tasks whose status actually changes", async () => {
    const prisma = createPrismaMock();
    const unchangedTaskId = "cmab8yxxp0008i7p4k8n2v3qb";
    const changedTaskId = "cmab8yxxp0009i7p4k8n2v3qc";

    prisma.task.findMany
      .mockResolvedValueOnce([
        {
          id: unchangedTaskId,
          projectId: PROJECT_ID,
          statusId: STATUS_ID,
          closedAt: null,
          sourceLinks: [],
          targetLinks: [],
        },
        {
          id: changedTaskId,
          projectId: PROJECT_ID,
          statusId: "cmab8yxxp0010i7p4k8n2v3qd",
          closedAt: null,
          sourceLinks: [],
          targetLinks: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: unchangedTaskId,
          projectId: PROJECT_ID,
          statusId: STATUS_ID,
          assigneeId: USER_ID,
          sprint: null,
          priority: "medium",
          status: { id: STATUS_ID },
          tags: [],
          creator: null,
          project: { key: "TASK", slug: "taskito" },
        },
        {
          id: changedTaskId,
          projectId: PROJECT_ID,
          statusId: STATUS_ID,
          assigneeId: USER_ID,
          sprint: null,
          priority: "medium",
          status: { id: STATUS_ID },
          tags: [],
          creator: null,
          project: { key: "TASK", slug: "taskito" },
        },
      ]);
    prisma.workflowTransition.findFirst.mockResolvedValue({ id: "cmab8yxxp0011i7p4k8n2v3qe" });
    prisma.task.update.mockResolvedValue({});

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await caller.bulkUpdate({
      projectId: PROJECT_ID,
      taskIds: [unchangedTaskId, changedTaskId],
      statusId: STATUS_ID,
    });

    expect(prisma.task.update).toHaveBeenCalledTimes(2);
    expect(prisma.task.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: unchangedTaskId },
        data: { statusId: STATUS_ID },
      })
    );
    expect(prisma.task.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: changedTaskId },
        data: expect.objectContaining({
          statusId: STATUS_ID,
          archivedAt: new Date("2026-05-22T09:00:00.000Z"),
        }),
      })
    );
  });
});
