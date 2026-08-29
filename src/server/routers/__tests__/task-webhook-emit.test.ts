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
  emitTaskWebhookEvent,
  emitWebhookEvent,
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
  // Rejects synchronously so we can prove the router never awaits this call.
  emitTaskWebhookEvent: vi.fn(() => Promise.reject(new Error("webhook dispatch exploded"))),
  emitWebhookEvent: vi.fn(() => Promise.reject(new Error("webhook dispatch exploded"))),
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

vi.mock("@/server/services/webhooks/dispatcher", () => ({
  emitTaskWebhookEvent,
  emitWebhookEvent,
}));

import { createCallerFactory } from "@/server/trpc";
import { taskRouter } from "@/server/routers/task";
import { createPrismaMock } from "@/test/prisma-mock";

const createCaller = createCallerFactory(taskRouter);

const PROJECT_ID = "cmab8yxxp0001i7p4k8n2v3q4";
const USER_ID = "cmab8yxxp0002i7p4k8n2v3q5";
const STATUS_ID = "cmab8yxxp0003i7p4k8n2v3q6";
const TASK_ID = "cmab8yxxp0006i7p4k8n2v3q9";

describe("task router webhook emission is fire-and-forget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitTaskWebhookEvent.mockImplementation(() => Promise.reject(new Error("webhook dispatch exploded")));
    emitWebhookEvent.mockImplementation(() => Promise.reject(new Error("webhook dispatch exploded")));

    requireProjectAccess.mockResolvedValue({ actor: { id: USER_ID, role: "owner" }, membershipRole: "owner" });
    getCurrentActor.mockResolvedValue({ id: USER_ID, role: "admin" });
    requireTaskAccess.mockResolvedValue({ id: TASK_ID, projectId: PROJECT_ID, statusId: STATUS_ID });
    canAccessProject.mockResolvedValue(true);
    requireWorkflowStatusAccess.mockResolvedValue({
      id: STATUS_ID,
      projectId: PROJECT_ID,
      isFinal: false,
      autoArchive: false,
      autoArchiveDays: 0,
    });
    autoTagTask.mockResolvedValue(undefined);
    createTaskActivity.mockResolvedValue(undefined);
    evaluateAutomationRules.mockResolvedValue(undefined);
    isAutomationExecutionActive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("create resolves even though emitTaskWebhookEvent rejects", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, role: "admin", projectMemberships: [] });
    prisma.project.findUniqueOrThrow.mockResolvedValue({ id: PROJECT_ID, settings: { defaultStatusId: STATUS_ID } });
    prisma.task.findFirst.mockResolvedValue({ taskNumber: 41 });
    prisma.task.create.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Ship webhooks",
      statusId: STATUS_ID,
      assigneeId: USER_ID,
      priority: "none",
    });
    prisma.taskWatcher.create.mockResolvedValue({ taskId: TASK_ID, userId: USER_ID });

    const caller = createCaller({ prisma: prisma as never, session: { user: { id: USER_ID } } as never });

    await expect(
      caller.create({
        projectId: PROJECT_ID,
        title: "Ship webhooks",
        dueDate: new Date("2026-06-01T12:00:00.000Z"),
        priority: "none",
      }),
    ).resolves.toMatchObject({ id: TASK_ID });

    expect(emitTaskWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "task.created", taskId: TASK_ID }),
    );
  });

  it("archive resolves even though emitTaskWebhookEvent rejects", async () => {
    const prisma = createPrismaMock();
    prisma.task.update.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_ID,
      statusId: STATUS_ID,
      archivedAt: new Date("2026-06-02T00:00:00.000Z"),
    });

    const caller = createCaller({ prisma: prisma as never, session: { user: { id: USER_ID } } as never });

    await expect(caller.archive({ id: TASK_ID })).resolves.toMatchObject({ id: TASK_ID });
    expect(emitTaskWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "task.archived", taskId: TASK_ID }),
    );
  });

  it("delete resolves even though emitWebhookEvent rejects", async () => {
    const prisma = createPrismaMock();
    prisma.task.delete.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_ID,
      taskNumber: 7,
      title: "Doomed",
      statusId: STATUS_ID,
      assigneeId: null,
      priority: "none",
      dueDate: new Date("2026-06-01T12:00:00.000Z"),
    });

    const caller = createCaller({ prisma: prisma as never, session: { user: { id: USER_ID } } as never });

    await expect(caller.delete({ id: TASK_ID })).resolves.toEqual({ success: true });
    expect(emitWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "task.deleted" }),
    );
  });
});
