import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireTaskAccess,
  createTaskActivity,
  createNotification,
  notifyTaskWatchers,
  resolveMentionedUserIds,
} = vi.hoisted(() => ({
  requireTaskAccess: vi.fn(),
  createTaskActivity: vi.fn(),
  createNotification: vi.fn(),
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
  notifyTaskWatchers,
  resolveMentionedUserIds,
}));

import { createTaskComment, updateTaskComment } from "../comment-service";

describe("comment service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireTaskAccess.mockResolvedValue({ id: "task-1", projectId: "project-1", statusId: "status-1" });
    createTaskActivity.mockResolvedValue(undefined);
    createNotification.mockResolvedValue(undefined);
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
              }),
            ],
          },
        }),
      })
    );
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
        data: { content: "Updated @alex and @sam" },
      })
    );
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
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
        data: { content: "" },
      })
    );
  });
});
