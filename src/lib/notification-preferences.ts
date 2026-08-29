/**
 * Notification preference helpers shared by the notification router, the user
 * router, and the services. Preferences live in User.settings JSON:
 *
 *   settings.notificationPreferences = { assignments, comments, statusChanges, mentions }
 *   settings.emailChannel            = { assignments, comments, statusChanges, mentions, digest }
 *
 * In-app settings default ON; the email channel defaults OFF for everything
 * except `mentioned` and `assigned`.
 */

export const NOTIFICATION_PREF_KEYS = ["assignments", "comments", "statusChanges", "mentions"] as const;

export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

export const EMAIL_CHANNEL_KEYS = [...NOTIFICATION_PREF_KEYS, "digest"] as const;

export type EmailChannelKey = (typeof EMAIL_CHANNEL_KEYS)[number];

export const DEFAULT_EMAIL_CHANNEL: Record<EmailChannelKey, boolean> = {
  assignments: true,
  comments: false,
  statusChanges: false,
  mentions: true,
  digest: false,
};

export interface NotificationPreferences {
  assignments: boolean;
  comments: boolean;
  statusChanges: boolean;
  mentions: boolean;
  emailChannel: Record<EmailChannelKey, boolean>;
}

export function getNotificationPreferences(settings: unknown): NotificationPreferences {
  const root = (settings ?? {}) as Record<string, unknown>;
  const preferences = (root.notificationPreferences ?? {}) as Record<string, unknown>;
  const emailChannel = (root.emailChannel ?? {}) as Record<string, unknown>;

  return {
    assignments: preferences.assignments !== false,
    comments: preferences.comments !== false,
    statusChanges: preferences.statusChanges !== false,
    mentions: preferences.mentions !== false,
    emailChannel: readEmailChannel(emailChannel),
  };
}

export function readEmailChannel(emailChannel: unknown): Record<EmailChannelKey, boolean> {
  const values = (emailChannel ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    EMAIL_CHANNEL_KEYS.map((key) => [
      key,
      typeof values[key] === "boolean" ? (values[key] as boolean) : DEFAULT_EMAIL_CHANNEL[key],
    ])
  ) as Record<EmailChannelKey, boolean>;
}

/** Validate/normalize an updatePreferences payload (requests may be partial). */
export function normalizeEmailChannelInput(value: unknown): Record<EmailChannelKey, boolean> {
  const next = readEmailChannel((value ?? {}) as Record<string, unknown>);
  const values = (value ?? {}) as Record<string, unknown>;
  for (const key of EMAIL_CHANNEL_KEYS) {
    if (typeof values[key] === "boolean") {
      next[key] = values[key] as boolean;
    }
  }
  return next;
}