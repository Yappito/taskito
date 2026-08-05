import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentActor, requireProjectAccess, requireWorkflowStatusAccess, requireWorkflowTransitionAccess } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  requireProjectAccess: vi.fn(),
  requireWorkflowStatusAccess: vi.fn(),
  requireWorkflowTransitionAccess: vi.fn(),
}));

vi.mock("@/server/authz", () => ({
  getCurrentActor,
  requireProjectAccess,
  requireWorkflowStatusAccess,
  requireWorkflowTransitionAccess,
}));

import { createCallerFactory } from "@/server/trpc";
import { workflowRouter } from "@/server/routers/workflow";

const createCaller = createCallerFactory(workflowRouter);

const PROJECT_ID = "cmab8yxxp0001i7p4k8n2v3q4";
const USER_ID = "cmab8yxxp0002i7p4k8n2v3q5";
const STATUS_ID = "cmab8yxxp0003i7p4k8n2v3q6";

function createPrismaMock() {
  const prisma = {
    workflowStatus: {
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    task: {
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) => await callback(prisma)),
  };

  return prisma;
}

describe("workflow router deleteStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentActor.mockResolvedValue({ id: USER_ID, role: "admin" });
    requireWorkflowStatusAccess.mockResolvedValue({
      id: STATUS_ID,
      projectId: PROJECT_ID,
      category: "todo",
      isFinal: false,
      autoArchive: false,
      autoArchiveDays: 0,
    });
  });

  it("throws a friendly error and does not delete when tasks still use the status", async () => {
    const prisma = createPrismaMock();
    prisma.task.count.mockResolvedValue(3);

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await expect(caller.deleteStatus({ id: STATUS_ID })).rejects.toThrow(
      /Cannot delete status: 3 task\(s\) still use it/
    );
    expect(prisma.task.count).toHaveBeenCalledWith({ where: { statusId: STATUS_ID } });
    expect(prisma.workflowStatus.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("deletes the status and syncs closed tasks when no task uses it", async () => {
    const prisma = createPrismaMock();
    prisma.task.count.mockResolvedValue(0);
    prisma.workflowStatus.delete.mockResolvedValue({ id: STATUS_ID });
    prisma.workflowStatus.findMany.mockResolvedValue([]);
    prisma.task.updateMany.mockResolvedValue({ count: 0 });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    await expect(caller.deleteStatus({ id: STATUS_ID })).resolves.toEqual({ success: true });
    expect(prisma.task.count).toHaveBeenCalledWith({ where: { statusId: STATUS_ID } });
    expect(prisma.workflowStatus.delete).toHaveBeenCalledWith({ where: { id: STATUS_ID } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.task.updateMany).toHaveBeenCalledTimes(1);
  });
});
