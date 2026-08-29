import { Prisma, type NotificationType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { DEFAULT_EMAIL_CHANNEL } from "@/lib/notification-preferences";
import { isEmailConfigured, queueEmail } from "@/server/services/email/smtp-client";
import { appBaseUrl, renderNotificationEmail } from "@/server/services/email/templates";

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

/**
 * Email channel switches (stored under settings.emailChannel in User.settings,
 * next to the in-app settings.notificationPreferences). Defaults OFF for
 * everything except mentioned and assigned — single source of truth in
 * src/lib/notification-preferences.ts.
 */
export function getEmailChannelDefaults(): Record<string, boolean> {
  return { ...DEFAULT_EMAIL_CHANNEL };
}

/** Read the emailChannel user preference for a notification type or "digest". */
export function readEmailChannelPreference(
  settings: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  const emailChannel = (settings?.emailChannel ?? {}) as Record<string, unknown>;
  const value = emailChannel[key];
  if (typeof value === "boolean") return value;
  return DEFAULT_EMAIL_CHANNEL[key as keyof typeof DEFAULT_EMAIL_CHANNEL] ?? false;
}

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

/** Fire-and-forget email delivery for one notification. */
async function deliverNotificationEmail(input: CreateNotificationInput): Promise<void> {
  if (!isEmailConfigured()) {
    return;
  }

  // Never email actors about their own actions.
  if (input.actorId && input.recipientId === input.actorId) {
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: input.recipientId },
    select: { id: true, name: true, email: true, settings: true },
  });
  if (!user?.email) {
    return;
  }

  const settings = (user.settings ?? {}) as Record<string, unknown>;
  const preferenceKey = notificationPreferenceKeyByType[input.type];
  if (!readEmailChannelPreference(settings, preferenceKey)) {
    return;
  }

  const actor = input.actorId
    ? await prisma.user.findUnique({ where: { id: input.actorId }, select: { name: true } })
    : null;

  const task = input.taskId
    ? await prisma.task.findUnique({
        where: { id: input.taskId },
        select: {
          id: true,
          title: true,
          taskNumber: true,
          project: { select: { name: true, slug: true, key: true } },
        },
      })
    : null;

  const email = renderNotificationEmail({
    type: input.type,
    actorName: actor?.name,
    taskKey: task ? `${task.project.key}-${task.taskNumber}` : null,
    taskTitle: task?.title,
    projectName: task?.project.name,
    projectSlug: task?.project.slug,
    taskId: task?.id,
  }, appBaseUrl(process.env.AUTH_URL));

  const outcome = queueEmail({
    to: user.email,
    toName: user.name,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  if (outcome === "dropped") {
    console.warn(`[email] notification email for user ${user.id} dropped (queue full)`);
  }
}

/**
 * dispatchNotification = the single notification entry point:
 * creates the in-app row (unchanged gating) and, fire-and-forget, sends an
 * email when the recipient has the email channel enabled for this type and is
 * not the actor. Never blocks or fails the originating mutation.
 */
export async function dispatchNotification(input: CreateNotificationInput) {
  const notification = await createNotification(input);

  void deliverNotificationEmail(input).catch((error) => {
    console.error(
      "[email] notification email failed:",
      error instanceof Error ? error.message : String(error)
    );
  });

  return notification;
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
      dispatchNotification({
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
  const people = await prisma.user.findMany({
    where: {
      disabledAt: null,
      OR: [
        { role: "admin" },
        { projectMemberships: { some: { projectId } } },
        { groupMemberships: { some: { group: { projectMemberships: { some: { projectId } } } } } },
      ],
    },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });

  const normalizedTokens = new Set(
    [...content.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((match) => match[1].toLowerCase())
  );

  return people
    .filter((user) => {
      const emailToken = user.email.split("@")[0]?.toLowerCase();
      const nameToken = user.name?.trim().toLowerCase().replace(/\s+/g, "-");
      return (emailToken && normalizedTokens.has(emailToken)) || (nameToken && normalizedTokens.has(nameToken));
    })
    .map((user) => user.id);
}