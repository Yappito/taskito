import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import {
  captureAiCheckpointAfter,
  captureAiCheckpointBefore,
  rollbackAiActionCheckpoint,
  type AiActionCheckpoint,
} from "@/server/services/ai/checkpoints";

const projectId = "clxproject00000000000000000";
const taskId = "clxtask0000000000000000000";
const sprintId = "clxsprint000000000000000000";
const actorId = "clxuser00000000000000000001";
const UPDATED_AT = new Date("2026-08-01T10:00:00.000Z");

function createTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: taskId,
    projectId,
    taskNumber: 41,
    creatorId: actorId,
    assigneeId: "clxuser00000000000000000002",
    title: "Prepare release notes",
    description: null,
    body: null,
    statusId: "clxstatus000000000000000000",
    priority: "medium",
    dueDate: new Date("2026-08-15T12:00:00.000Z"),
    startDate: new Date("2026-08-01T08:00:00.000Z"),
    closedAt: null,
    archivedAt: null,
    alertAcknowledged: false,
    createdAt: new Date("2026-07-20T09:00:00.000Z"),
    updatedAt: UPDATED_AT,
    sprintId,
    tags: [{ tagId: "clxtag00000000000000000000" }],
    customFieldValues: [],
    ...overrides,
  };
}

function createPrismaMock() {
  const prisma = {
    task: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    taskTag: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    customFieldValue: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    activityEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) => await callback(prisma)),
  };
  return prisma;
}

function createRollbackExecution(before: AiActionCheckpoint, after: AiActionCheckpoint) {
  return {
    id: "exec-1",
    checkpointBefore: before as unknown as Prisma.JsonValue,
    checkpointAfter: after as unknown as Prisma.JsonValue,
  };
}

describe("ai action checkpoints", () => {
  it("captures sprintId in the task snapshot", async () => {
    const prisma = createPrismaMock();
    prisma.task.findMany.mockResolvedValue([createTaskRow()]);

    const checkpoint = await captureAiCheckpointBefore(prisma as never, {
      actionType: "moveStatus",
      projectId,
      payload: { taskId },
    });

    expect(checkpoint.tasks).toHaveLength(1);
    expect(checkpoint.tasks[0].data?.sprintId).toBe(sprintId);
    expect(checkpoint.tasks[0].data?.statusId).toBe("clxstatus000000000000000000");
  });

  it("captures null sprintId when the task has no sprint", async () => {
    const prisma = createPrismaMock();
    prisma.task.findMany.mockResolvedValue([createTaskRow({ sprintId: null })]);

    const checkpoint = await captureAiCheckpointBefore(prisma as never, {
      actionType: "moveStatus",
      projectId,
      payload: { taskId },
    });

    expect(checkpoint.tasks[0].data?.sprintId).toBeNull();
  });

  it("restores sprintId on rollback", async () => {
    const prisma = createPrismaMock();
    prisma.task.findMany.mockResolvedValue([createTaskRow()]);
    prisma.task.findUnique.mockResolvedValue({ updatedAt: UPDATED_AT });
    prisma.task.update.mockResolvedValue({});
    prisma.taskTag.deleteMany.mockResolvedValue({ count: 0 });
    prisma.taskTag.createMany.mockResolvedValue({ count: 1 });
    prisma.customFieldValue.deleteMany.mockResolvedValue({ count: 0 });
    prisma.activityEvent.create.mockResolvedValue({});

    const before = await captureAiCheckpointBefore(prisma as never, {
      actionType: "moveStatus",
      projectId,
      payload: { taskId },
    });
    const after = await captureAiCheckpointAfter(prisma as never, {
      actionType: "moveStatus",
      projectId,
      payload: { taskId },
      result: { id: taskId },
      before,
    });

    await rollbackAiActionCheckpoint(prisma as never, {
      execution: createRollbackExecution(before, after),
      actorId,
    });

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: taskId },
      data: expect.objectContaining({ sprintId }),
    });
    expect(prisma.taskTag.createMany).toHaveBeenCalledWith({
      data: [{ taskId, tagId: "clxtag00000000000000000000" }],
      skipDuplicates: true,
    });
  });

  it("restores a null sprintId when the snapshot has none", async () => {
    const prisma = createPrismaMock();
    prisma.task.findMany.mockResolvedValue([createTaskRow({ sprintId: null })]);
    prisma.task.findUnique.mockResolvedValue({ updatedAt: UPDATED_AT });
    prisma.task.update.mockResolvedValue({});
    prisma.taskTag.deleteMany.mockResolvedValue({ count: 0 });
    prisma.taskTag.createMany.mockResolvedValue({ count: 1 });
    prisma.customFieldValue.deleteMany.mockResolvedValue({ count: 0 });
    prisma.activityEvent.create.mockResolvedValue({});

    const before = await captureAiCheckpointBefore(prisma as never, {
      actionType: "moveStatus",
      projectId,
      payload: { taskId },
    });
    const after = await captureAiCheckpointAfter(prisma as never, {
      actionType: "moveStatus",
      projectId,
      payload: { taskId },
      result: { id: taskId },
      before,
    });

    await rollbackAiActionCheckpoint(prisma as never, {
      execution: createRollbackExecution(before, after),
      actorId,
    });

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: taskId },
      data: expect.objectContaining({ sprintId: null }),
    });
  });

  it("still rolls back a created task by deleting it", async () => {
    const prisma = createPrismaMock();
    const createdTaskId = "clxtask00000000000000000099";
    const createdRow = createTaskRow({ id: createdTaskId });
    prisma.task.findMany.mockResolvedValue([createdRow]);
    prisma.task.findUnique.mockResolvedValue({ id: createdTaskId, updatedAt: UPDATED_AT });
    prisma.task.delete.mockResolvedValue({});

    const before = await captureAiCheckpointBefore(prisma as never, {
      actionType: "createTask",
      projectId,
      payload: { title: "New task", dueDate: "2026-08-20T12:00:00.000Z" },
    });
    const after = await captureAiCheckpointAfter(prisma as never, {
      actionType: "createTask",
      projectId,
      payload: { title: "New task", dueDate: "2026-08-20T12:00:00.000Z" },
      result: { id: createdTaskId },
      before,
    });

    await rollbackAiActionCheckpoint(prisma as never, {
      execution: createRollbackExecution(before, after),
      actorId,
    });

    expect(prisma.task.delete).toHaveBeenCalledWith({ where: { id: createdTaskId } });
    expect(prisma.task.update).not.toHaveBeenCalled();
  });
});
