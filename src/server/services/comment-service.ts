import { createTaskActivity } from "@/server/services/task-activity";
import { dispatchNotification, notifyTaskWatchers, resolveMentionedUserIds } from "@/server/services/notifications";
import { emitTaskWebhookEvent } from "@/server/services/webhooks/dispatcher";
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
  const task = await requireTaskAccess(prisma, input.authorId, input.taskId, { permission: "task_comment" });
  const attachments = input.attachments ?? [];
  const finalContent = normalizeCommentContent(input.content);

  if (finalContent.length > MAX_COMMENT_LENGTH) {
    throw new Error(`Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`);
  }

  if (!finalContent && attachments.length === 0) {
    throw new Error("Comment content or attachments are required");
  }

  // CITADEL-e10 (finding 5): bump the durable comment-thread version in the
  // same transaction as the create so the AI summary cache compare-and-swap
  // always observes the new comment. (Prisma's create-side nested relation
  // input cannot update the parent, hence the explicit transaction.)
  const [comment] = await prisma.$transaction([
    prisma.comment.create({
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
                storageProvider: attachment.storageProvider,
                storageBucket: attachment.storageBucket,
                storageKey: attachment.storageKey,
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
    }),
    prisma.task.update({
      where: { id: input.taskId },
      data: { commentThreadVersion: { increment: 1 } },
    }),
  ]);

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

  // Fire-and-forget outbound webhook; never fails the mutation (and never
  // carries the comment body — only its id).
  emitTaskWebhookEvent(prisma, {
    projectId: task.projectId,
    event: "comment.created",
    taskId: input.taskId,
    actorId: input.authorId,
    commentId: comment.id,
  }).catch(() => {});

  resolveMentionedUserIds(task.projectId, finalContent)
    .then((userIds) => Promise.all(
      userIds
        .filter((userId) => userId !== input.authorId)
        .map((userId) =>
          dispatchNotification({
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
  const task = await requireTaskAccess(prisma, input.actorId, input.taskId, { permission: "task_comment" });
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
    data: {
      content,
      // CITADEL-e10 (finding 5): an in-place edit keeps the comment's
      // createdAt, so the durable thread version — not any comment timestamp
      // — is what invalidates stale AI summary caches. Bumped in the same
      // write (single statement, atomic with the edit).
      task: { update: { commentThreadVersion: { increment: 1 } } },
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

  const [previousMentionedUserIds, nextMentionedUserIds] = await Promise.all([
    resolveMentionedUserIds(task.projectId, previousBody),
    resolveMentionedUserIds(task.projectId, content),
  ]);
  const previousMentionSet = new Set(previousMentionedUserIds);

  await Promise.all(
    nextMentionedUserIds
      .filter((userId) => userId !== input.actorId && !previousMentionSet.has(userId))
      .map((userId) =>
        dispatchNotification({
          recipientId: userId,
          actorId: input.actorId,
          taskId: input.taskId,
          type: "mentioned",
          payload: { commentId: input.commentId },
        })
      )
  );

  // Fire-and-forget outbound webhook; never fails the mutation (and never
  // carries the comment body — only its id).
  emitTaskWebhookEvent(prisma, {
    projectId: task.projectId,
    event: "comment.updated",
    taskId: input.taskId,
    actorId: input.actorId,
    commentId: input.commentId,
  }).catch(() => {});

  return updatedComment;
}

export async function deleteTaskComment(
  prisma: typeof import("@/lib/prisma").prisma,
  input: {
    taskId: string;
    commentId: string;
    actorId: string;
  }
) {
  await requireTaskAccess(prisma, input.actorId, input.taskId, { permission: "task_comment" });
  const existingComment = await prisma.comment.findUnique({
    where: { id: input.commentId },
    select: { id: true, taskId: true, authorId: true },
  });

  if (!existingComment || existingComment.taskId !== input.taskId) {
    throw new Error("Comment not found");
  }

  if (existingComment.authorId !== input.actorId) {
    throw new Error("You can only delete your own comments");
  }

  // CITADEL-e10 (finding 5): the comment-thread version bump commits
  // atomically with the delete, so the AI summary cache compare-and-swap can
  // never miss a deletion. (No outbound webhook yet: comment.deleted is not
  // a subscribable event name — see src/lib/webhook-events.ts.)
  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.delete({ where: { id: input.commentId } });
    await tx.task.update({
      where: { id: input.taskId },
      data: { commentThreadVersion: { increment: 1 } },
    });
    return comment;
  });
}
