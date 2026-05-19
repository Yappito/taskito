import { createTaskActivity } from "@/server/services/task-activity";
import { createNotification, notifyTaskWatchers, resolveMentionedUserIds } from "@/server/services/notifications";
import { requireTaskAccess } from "@/server/authz";
import { getCommentBody, normalizeCommentContent } from "@/lib/comment-content";

import type { StoredCommentAttachmentInput } from "./comment-attachments";

const MAX_COMMENT_LENGTH = 5000;

export async function createTaskComment(
  prisma: typeof import("@/lib/prisma").prisma,
  input: {
    taskId: string;
    authorId: string;
    content: string;
    attachments?: StoredCommentAttachmentInput[];
  }
) {
  const task = await requireTaskAccess(prisma, input.authorId, input.taskId);
  const attachments = input.attachments ?? [];
  const finalContent = normalizeCommentContent(input.content);

  if (finalContent.length > MAX_COMMENT_LENGTH) {
    throw new Error(`Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`);
  }

  if (!finalContent && attachments.length === 0) {
    throw new Error("Comment content or attachments are required");
  }

  const comment = await prisma.comment.create({
    data: {
      taskId: input.taskId,
      authorId: input.authorId,
      content: finalContent,
      ...(attachments.length > 0
        ? {
            attachments: {
              create: attachments.map((attachment) => ({
                originalName: attachment.originalName,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                storagePath: attachment.storagePath,
              })),
            },
          }
        : {}),
    },
    include: {
      author: { select: { id: true, name: true, image: true } },
      attachments: {
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  createTaskActivity({
    taskId: input.taskId,
    actorId: input.authorId,
    action: "commented",
    details: { commentId: comment.id },
  }).catch(() => {});

  notifyTaskWatchers({
    taskId: input.taskId,
    actorId: input.authorId,
    type: "commented",
    payload: { commentId: comment.id },
  }).catch(() => {});

  resolveMentionedUserIds(task.projectId, finalContent)
    .then((userIds) => Promise.all(
      userIds
        .filter((userId) => userId !== input.authorId)
        .map((userId) =>
          createNotification({
            recipientId: userId,
            actorId: input.authorId,
            taskId: input.taskId,
            type: "mentioned",
            payload: { commentId: comment.id },
          })
        )
    ))
    .catch(() => {});

  return comment;
}

export async function updateTaskComment(
  prisma: typeof import("@/lib/prisma").prisma,
  input: {
    taskId: string;
    commentId: string;
    actorId: string;
    content: string;
  }
) {
  const task = await requireTaskAccess(prisma, input.actorId, input.taskId);
  const existingComment = await prisma.comment.findUnique({
    where: { id: input.commentId },
    select: {
      id: true,
      taskId: true,
      authorId: true,
      content: true,
      attachments: {
        select: {
          originalName: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!existingComment || existingComment.taskId !== input.taskId) {
    throw new Error("Comment not found");
  }

  if (existingComment.authorId !== input.actorId) {
    throw new Error("You can only edit your own comments");
  }

  const content = normalizeCommentContent(input.content);
  if (content.length > MAX_COMMENT_LENGTH) {
    throw new Error(`Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`);
  }

  if (!content && existingComment.attachments.length === 0) {
    throw new Error("Comment content or attachments are required");
  }

  const previousBody = getCommentBody(existingComment.content, existingComment.attachments);
  const updatedComment = await prisma.comment.update({
    where: { id: input.commentId },
    data: { content },
    include: {
      author: { select: { id: true, name: true, image: true } },
      attachments: {
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const [previousMentionedUserIds, nextMentionedUserIds] = await Promise.all([
    resolveMentionedUserIds(task.projectId, previousBody),
    resolveMentionedUserIds(task.projectId, content),
  ]);
  const previousMentionSet = new Set(previousMentionedUserIds);

  await Promise.all(
    nextMentionedUserIds
      .filter((userId) => userId !== input.actorId && !previousMentionSet.has(userId))
      .map((userId) =>
        createNotification({
          recipientId: userId,
          actorId: input.actorId,
          taskId: input.taskId,
          type: "mentioned",
          payload: { commentId: input.commentId },
        })
      )
  );

  return updatedComment;
}
