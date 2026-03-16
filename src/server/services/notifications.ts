import { Prisma, type NotificationType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

interface CreateNotificationInput {
  recipientId: string;
  actorId?: string | null;
  taskId?: string | null;
  type: NotificationType;
  payload?: Prisma.InputJsonValue;
}

const notificationPreferenceKeyByType: Record<NotificationType, string> = {
  assigned: "assignments",
  commented: "comments",
  statusChanged: "statusChanges",
  mentioned: "mentions",
};

async function notificationAllowed(recipientId: string, type: NotificationType) {
  const user = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { settings: true },
  });

  const settings = (user?.settings ?? {}) as Record<string, unknown>;
  const preferences = (settings.notificationPreferences ?? {}) as Record<string, unknown>;
  const preferenceKey = notificationPreferenceKeyByType[type];
  return preferences[preferenceKey] !== false;
}

export async function createNotification(input: CreateNotificationInput) {
  if (!(await notificationAllowed(input.recipientId, input.type))) {
    return null;
  }

  return prisma.notification.create({
    data: {
      recipientId: input.recipientId,
      actorId: input.actorId ?? null,
      taskId: input.taskId ?? null,
      type: input.type,
      payload: input.payload ?? {},
    },
  });
}

export async function notifyTaskWatchers(input: {
  taskId: string;
  actorId?: string | null;
  type: NotificationType;
  payload?: Prisma.InputJsonValue;
  excludeUserIds?: string[];
}) {
  const watchers = await prisma.taskWatcher.findMany({
    where: { taskId: input.taskId },
    select: { userId: true },
  });

  const excluded = new Set([...(input.excludeUserIds ?? []), ...(input.actorId ? [input.actorId] : [])]);
  const recipients = watchers.map((watcher) => watcher.userId).filter((userId) => !excluded.has(userId));

  if (recipients.length === 0) {
    return;
  }

  await Promise.all(
    recipients.map((recipientId) =>
      createNotification({
        recipientId,
        actorId: input.actorId ?? null,
        taskId: input.taskId,
        type: input.type,
        payload: input.payload,
      })
    )
  );
}

export async function resolveMentionedUserIds(projectId: string, content: string) {
  const people = await prisma.projectMember.findMany({
    where: { projectId },
    select: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });

  const normalizedTokens = new Set(
    [...content.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((match) => match[1].toLowerCase())
  );

  return people
    .map((membership) => membership.user)
    .filter((user) => {
      const emailToken = user.email.split("@")[0]?.toLowerCase();
      const nameToken = user.name?.trim().toLowerCase().replace(/\s+/g, "-");
      return (emailToken && normalizedTokens.has(emailToken)) || (nameToken && normalizedTokens.has(nameToken));
    })
    .map((user) => user.id);
}