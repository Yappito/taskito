import { createTaskActivity } from "@/server/services/task-activity";
import { createNotification, notifyTaskWatchers, resolveMentionedUserIds } from "@/server/services/notifications";
import { requireTaskAccess } from "@/server/authz";

import type { StoredCommentAttachmentInput } from "./comment-attachments";

function appendAttachmentReferences(content: string, attachments: StoredCommentAttachmentInput[]) {
  const trimmed = content.trim();
  if (attachments.length === 0) {
    return trimmed;
  }

  const attachmentLines = attachments.map((attachment) => `- ${attachment.originalName}`).join("\n");
  const attachmentBlock = `Attachments:\n${attachmentLines}`;
  return trimmed ? `${trimmed}\n\n${attachmentBlock}` : attachmentBlock;
}

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
  const finalContent = appendAttachmentReferences(input.content, attachments);

  if (!finalContent.trim()) {
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