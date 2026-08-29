import { beforeEach, describe, expect, it, vi } from "vitest";

import { rollbackAiActionCheckpoint } from "../checkpoints";

/**
 * Transaction-client mock mirroring the surfaces the rollback touches.
 * Every statement is recorded so tests can assert they all ran on the SAME
 * transaction client (the rollback is one atomic unit).
 */
function makeTx() {
  return {
    comment: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    task: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    taskLink: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    taskTag: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customFieldValue: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    activityEvent: { create: vi.fn().mockResolvedValue({}) },
  };
}

type Tx = ReturnType<typeof makeTx>;

function makePrisma(tx: Tx) {
  return {
    $transaction: vi.fn(async (fn: (client: Tx) => Promise<unknown>) => fn(tx)),
  };
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    actionType: "addComment",
    projectId: "proj-1",
    capturedAt: new Date("2026-05-19T10:00:00.000Z").toISOString(),
    tasks: [],
    links: [],
    comments: [],
    createdTaskIds: [],
    ...overrides,
  };
}

describe("AI checkpoint rollback — created comments", () => {
  let tx: Tx;

  beforeEach(() => {
    tx = makeTx();
  });

  // CITADEL-ae2 (finding 3): rolling back an AI add_comment used to delete
  // the comment with a bare tx.comment.deleteMany and NEVER bump the owning
  // task's durable commentThreadVersion. A task summary written after the AI
  // comment (its CAS observed the bumped version) kept passing the
  // compare-and-swap even though the comment was rolled back away — a
  // permanently stale summary cache. The rollback must bump the version in
  // the same transaction, exactly like comment-service.deleteTaskComment
  // does for user-initiated deletions.
  it("bumps commentThreadVersion on the affected task in the same transaction as the delete", async () => {
    const prisma = makePrisma(tx);
    const before = checkpoint({ comments: [] });
    const after = checkpoint({
      comments: [{ id: "comment-1", exists: true, taskId: "task-1" }],
    });

    await rollbackAiActionCheckpoint(prisma as never, {
      execution: { id: "exec-1", checkpointBefore: before, checkpointAfter: after },
      actorId: "user-1",
    });

    expect(tx.comment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["comment-1"] } },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-1"] } },
      data: { commentThreadVersion: { increment: 1 } },
    });
    // Both statements ran on the SAME transaction client: the bump commits
    // atomically with the deletion (or neither happens).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("bumps each affected task once when several rolled-back comments share a task", async () => {
    const prisma = makePrisma(tx);
    const after = checkpoint({
      comments: [
        { id: "comment-1", exists: true, taskId: "task-1" },
        { id: "comment-2", exists: true, taskId: "task-1" },
        { id: "comment-3", exists: true, taskId: "task-2" },
      ],
    });

    await rollbackAiActionCheckpoint(prisma as never, {
      execution: { id: "exec-1", checkpointBefore: checkpoint(), checkpointAfter: after },
      actorId: "user-1",
    });

    // The version is a change detector for an equality-based CAS: one
    // increment per task is enough (and keeps the bump a single statement).
    expect(tx.task.updateMany).toHaveBeenCalledTimes(1);
    const call = tx.task.updateMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(call.where.id.in.sort()).toEqual(["task-1", "task-2"]);
  });

  it("does not touch commentThreadVersion when the rollback deletes no comments", async () => {
    const prisma = makePrisma(tx);
    const after = checkpoint({
      comments: [{ id: "comment-1", exists: false, taskId: "task-1" }],
    });

    await rollbackAiActionCheckpoint(prisma as never, {
      execution: { id: "exec-1", checkpointBefore: checkpoint(), checkpointAfter: after },
      actorId: "user-1",
    });

    expect(tx.comment.deleteMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });
});
