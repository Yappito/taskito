import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireTaskAccess,
  createTaskActivity,
  createNotification,
  dispatchNotification,
  notifyTaskWatchers,
  resolveMentionedUserIds,
} = vi.hoisted(() => ({
  requireTaskAccess: vi.fn(),
  createTaskActivity: vi.fn(),
  createNotification: vi.fn(),
  dispatchNotification: vi.fn(),
  notifyTaskWatchers: vi.fn(),
  resolveMentionedUserIds: vi.fn(),
}));

vi.mock("@/server/authz", () => ({
  requireTaskAccess,
}));

vi.mock("@/server/services/task-activity", () => ({
  createTaskActivity,
}));

vi.mock("@/server/services/notifications", () => ({
  createNotification,
  dispatchNotification,
  notifyTaskWatchers,
  resolveMentionedUserIds,
}));

import { createTaskComment, deleteTaskComment, updateTaskComment } from "../comment-service";

describe("comment service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireTaskAccess.mockResolvedValue({ id: "task-1", projectId: "project-1", statusId: "status-1" });
    createTaskActivity.mockResolvedValue(undefined);
    createNotification.mockResolvedValue(undefined);
    dispatchNotification.mockResolvedValue(undefined);
    notifyTaskWatchers.mockResolvedValue(undefined);
    resolveMentionedUserIds.mockResolvedValue([]);
  });

  it("stores comment text separately from attachments", async () => {
    const createdComment = {
      id: "comment-1",
      taskId: "task-1",
      authorId: "user-1",
      content: "Hello world",
      author: { id: "user-1", name: "User One", image: null },
      attachments: [],
    };
    const prisma = {
      comment: {
        create: vi.fn().mockResolvedValue(createdComment),
      },
      // CITADEL-e10 (finding 5): the thread-version bump is a second op in
      // the same array transaction as the create.
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
      task: { update: vi.fn().mockResolvedValue({}) },
    };

    await createTaskComment(prisma as never, {
      taskId: "task-1",
      authorId: "user-1",
      content: "  Hello world  ",
      attachments: [
        {
          originalName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
          storagePath: "/tmp/note.txt",
          storageProvider: "local",
          storageBucket: null,
          storageKey: "comment-attachments/note.txt",
        },
      ],
    });

    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: "task-1",
          authorId: "user-1",
          content: "Hello world",
          attachments: {
            create: [
              expect.objectContaining({
                originalName: "note.txt",
                mimeType: "text/plain",
                sizeBytes: 42,
                storagePath: "/tmp/note.txt",
                storageProvider: "local",
                storageBucket: null,
                storageKey: "comment-attachments/note.txt",
              }),
            ],
          },
        }),
      })
    );
    // The version bump commits atomically with the comment create.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { commentThreadVersion: { increment: 1 } },
    });
  });

  it("lets the author update comment text and notifies only newly mentioned users", async () => {
    const prisma = {
      comment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "comment-1",
          taskId: "task-1",
          authorId: "user-1",
          content: "Hello @alex",
          attachments: [{ originalName: "note.txt" }],
        }),
        update: vi.fn().mockResolvedValue({
          id: "comment-1",
          taskId: "task-1",
          authorId: "user-1",
          content: "Updated @alex and @sam",
          createdAt: new Date(),
          author: { id: "user-1", name: "User One", image: null },
          attachments: [
            {
              id: "attachment-1",
              originalName: "note.txt",
              mimeType: "text/plain",
              sizeBytes: 42,
              createdAt: new Date(),
            },
          ],
        }),
      },
    };

    resolveMentionedUserIds
      .mockResolvedValueOnce(["user-2"])
      .mockResolvedValueOnce(["user-2", "user-3"]);

    const updated = await updateTaskComment(prisma as never, {
      taskId: "task-1",
      commentId: "comment-1",
      actorId: "user-1",
      content: "Updated @alex and @sam",
    });

    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "comment-1" },
        data: {
          content: "Updated @alex and @sam",
          // CITADEL-e10 (finding 5): in-place edits keep createdAt, so the
          // durable thread version is bumped in the same write.
          task: { update: { commentThreadVersion: { increment: 1 } } },
        },
      })
    );
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: "user-3",
        actorId: "user-1",
        taskId: "task-1",
        type: "mentioned",
        payload: { commentId: "comment-1" },
      })
    );
    expect(updated).toMatchObject({
      id: "comment-1",
      content: "Updated @alex and @sam",
    });
  });

  it("rejects edits from non-authors", async () => {
    const prisma = {
      comment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "comment-1",
          taskId: "task-1",
          authorId: "user-2",
          content: "Original",
          attachments: [],
        }),
      },
    };

    await expect(
      updateTaskComment(prisma as never, {
        taskId: "task-1",
        commentId: "comment-1",
        actorId: "user-1",
        content: "Changed",
      })
    ).rejects.toThrow("You can only edit your own comments");
  });

  it("allows empty edited text when the comment has attachments", async () => {
    const prisma = {
      comment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "comment-1",
          taskId: "task-1",
          authorId: "user-1",
          content: "Existing text",
          attachments: [{ originalName: "note.txt" }],
        }),
        update: vi.fn().mockResolvedValue({
          id: "comment-1",
          taskId: "task-1",
          authorId: "user-1",
          content: "",
          createdAt: new Date(),
          author: { id: "user-1", name: "User One", image: null },
          attachments: [
            {
              id: "attachment-1",
              originalName: "note.txt",
              mimeType: "text/plain",
              sizeBytes: 42,
              createdAt: new Date(),
            },
          ],
        }),
      },
    };

    await expect(
      updateTaskComment(prisma as never, {
        taskId: "task-1",
        commentId: "comment-1",
        actorId: "user-1",
        content: "   ",
      })
    ).resolves.toMatchObject({ id: "comment-1", content: "" });

    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          content: "",
          task: { update: { commentThreadVersion: { increment: 1 } } },
        },
      })
    );
  });

  it("lets the author delete their own comment and bumps the thread version atomically", async () => {
    const tx = {
      comment: { delete: vi.fn().mockResolvedValue({ id: "comment-1", taskId: "task-1", authorId: "user-1" }) },
      task: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      comment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "comment-1",
          taskId: "task-1",
          authorId: "user-1",
        }),
      },
      // CITADEL-e10 (finding 5): the version bump must commit in the SAME
      // transaction as the delete so the AI summary cache CAS can never miss
      // a deletion.
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    };

    const deleted = await deleteTaskComment(prisma as never, {
      taskId: "task-1",
      commentId: "comment-1",
      actorId: "user-1",
    });

    expect(deleted).toMatchObject({ id: "comment-1" });
    expect(tx.comment.delete).toHaveBeenCalledWith({ where: { id: "comment-1" } });
    expect(tx.task.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { commentThreadVersion: { increment: 1 } },
    });
  });

  it("rejects deletes from non-authors", async () => {
    const prisma = {
      comment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "comment-1",
          taskId: "task-1",
          authorId: "user-2",
        }),
      },
      $transaction: vi.fn(),
    };

    await expect(
      deleteTaskComment(prisma as never, {
        taskId: "task-1",
        commentId: "comment-1",
        actorId: "user-1",
      })
    ).rejects.toThrow("You can only delete your own comments");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
