import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireProjectAccess,
  requireTagAccess,
  requireTaskAccess,
  requireTaskLinkAccess,
  requireWorkflowStatusAccess,
  canAccessProject,
  getCurrentActor,
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
  canAccessProject: vi.fn(),
  getCurrentActor: vi.fn(),
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
  canAccessProject,
  getCurrentActor,
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
const TASK_ID = "cmab8yxxp0004i7p4k8n2v3q7";

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
    taskParticipant: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
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

function createCallerWith(prisma: ReturnType<typeof createPrismaMock>) {
  return createCaller({
    prisma,
    session: { user: { id: USER_ID, name: "Tester", email: "tester@taskito.local", image: null } },
  } as never);
}

const tipTapDescription = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };

describe("task router description validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T09:00:00.000Z"));
    vi.clearAllMocks();

    requireProjectAccess.mockResolvedValue({ actor: { id: USER_ID, role: "owner" }, membershipRole: "owner" });
    getCurrentActor.mockResolvedValue({ id: USER_ID, role: "admin" });
    requireTaskAccess.mockResolvedValue({ id: TASK_ID, projectId: PROJECT_ID, statusId: STATUS_ID });
    requireWorkflowStatusAccess.mockResolvedValue({
      id: STATUS_ID,
      projectId: PROJECT_ID,
      isFinal: false,
      autoArchive: false,
      autoArchiveDays: 0,
    });
    canAccessProject.mockResolvedValue(true);
    autoTagTask.mockResolvedValue(undefined);
    createTaskActivity.mockResolvedValue(undefined);
    evaluateAutomationRules.mockResolvedValue(undefined);
    isAutomationExecutionActive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("create", () => {
    function setupCreatePrisma() {
      const prisma = createPrismaMock();
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID });
      prisma.project.findUniqueOrThrow.mockResolvedValue({ settings: {} });
      prisma.workflowStatus.findFirst.mockResolvedValue({ id: STATUS_ID });
      prisma.task.findFirst.mockResolvedValue(null);
      prisma.taskWatcher.create.mockResolvedValue({ taskId: "task-new", userId: USER_ID });
      prisma.task.create.mockImplementation(({ data }: { data: { description?: unknown } }) =>
        Promise.resolve({ id: "task-new", ...data, statusId: STATUS_ID, creatorId: USER_ID, assigneeId: USER_ID })
      );
      return prisma;
    }

    it("accepts a TipTap-style object description", async () => {
      const prisma = setupCreatePrisma();
      const caller = createCallerWith(prisma);

      await expect(
        caller.create({ projectId: PROJECT_ID, title: "Task", dueDate: new Date(), description: tipTapDescription })
      ).resolves.toBeDefined();

      expect(prisma.task.create).toHaveBeenCalledTimes(1);
      expect(prisma.task.create.mock.calls[0][0].data.description).toEqual(tipTapDescription);
    });

    it("accepts a null description", async () => {
      const prisma = setupCreatePrisma();
      const caller = createCallerWith(prisma);

      await expect(
        caller.create({ projectId: PROJECT_ID, title: "Task", dueDate: new Date(), description: null })
      ).resolves.toBeDefined();
    });

    it("accepts a string description (legacy / body fallback)", async () => {
      const prisma = setupCreatePrisma();
      const caller = createCallerWith(prisma);

      await expect(
        caller.create({ projectId: PROJECT_ID, title: "Task", dueDate: new Date(), description: "plain text" })
      ).resolves.toBeDefined();
    });

    it("rejects an array description", async () => {
      const prisma = setupCreatePrisma();
      const caller = createCallerWith(prisma);

      await expect(
        caller.create({ projectId: PROJECT_ID, title: "Task", dueDate: new Date(), description: [{ type: "paragraph" }] as never })
      ).rejects.toThrow();
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it("rejects a numeric description", async () => {
      const prisma = setupCreatePrisma();
      const caller = createCallerWith(prisma);

      await expect(
        caller.create({ projectId: PROJECT_ID, title: "Task", dueDate: new Date(), description: 42 as never })
      ).rejects.toThrow();
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it("rejects a boolean description", async () => {
      const prisma = setupCreatePrisma();
      const caller = createCallerWith(prisma);

      await expect(
        caller.create({ projectId: PROJECT_ID, title: "Task", dueDate: new Date(), description: true as never })
      ).rejects.toThrow();
      expect(prisma.task.create).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    function setupUpdatePrisma() {
      const prisma = createPrismaMock();
      prisma.task.findUniqueOrThrow.mockResolvedValue({
        id: TASK_ID,
        assigneeId: null,
        closedAt: null,
        statusId: STATUS_ID,
        priority: "none",
        sprintId: null,
        participants: [],
      });
      prisma.task.update.mockImplementation(({ data }: { data: { description?: unknown } }) =>
        Promise.resolve({ id: TASK_ID, title: "Task", statusId: STATUS_ID, assigneeId: null, priority: "none", ...data })
      );
      return prisma;
    }

    it("accepts a TipTap-style object description", async () => {
      const prisma = setupUpdatePrisma();
      const caller = createCallerWith(prisma);

      await expect(caller.update({ id: TASK_ID, description: tipTapDescription })).resolves.toBeDefined();

      expect(prisma.task.update).toHaveBeenCalledTimes(1);
      expect(prisma.task.update.mock.calls[0][0].data.description).toEqual(tipTapDescription);
    });

    it("accepts a null description", async () => {
      const prisma = setupUpdatePrisma();
      const caller = createCallerWith(prisma);

      await expect(caller.update({ id: TASK_ID, description: null })).resolves.toBeDefined();
    });

    it("rejects an array description", async () => {
      const prisma = setupUpdatePrisma();
      const caller = createCallerWith(prisma);

      await expect(caller.update({ id: TASK_ID, description: ["not", "an", "object"] as never })).rejects.toThrow();
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it("rejects a numeric description", async () => {
      const prisma = setupUpdatePrisma();
      const caller = createCallerWith(prisma);

      await expect(caller.update({ id: TASK_ID, description: 3.14 as never })).rejects.toThrow();
      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });
});
