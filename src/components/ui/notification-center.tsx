"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { trpc } from "@/lib/trpc-client";

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: notifications = [] } = trpc.notification.list.useQuery(undefined, {
    enabled: open,
  });
  const { data: unreadCount = 0 } = trpc.notification.unreadCount.useQuery();
  const { data: preferences } = trpc.notification.preferences.useQuery(undefined, {
    enabled: open,
  });

  const markRead = trpc.notification.markRead.useMutation({
    onSuccess: () => {
      utils.notification.list.invalidate();
      utils.notification.unreadCount.invalidate();
    },
  });

  const markAllRead = trpc.notification.markAllRead.useMutation({
    onSuccess: () => {
      utils.notification.list.invalidate();
      utils.notification.unreadCount.invalidate();
    },
  });

  const clearAll = trpc.notification.clearAll.useMutation({
    onSuccess: () => {
      utils.notification.list.invalidate();
      utils.notification.unreadCount.invalidate();
    },
  });

  const updatePreferences = trpc.notification.updatePreferences.useMutation({
    onSuccess: () => {
      utils.notification.preferences.invalidate();
    },
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="relative rounded-lg px-2.5 py-1.5 text-sm transition-colors"
        style={{ color: "var(--color-text-secondary)" }}
        aria-label="Open notifications"
      >
        Notifications
        {unreadCount > 0 && (
          <span
            className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold"
            style={{ backgroundColor: "var(--color-danger)", color: "white" }}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-2 w-[24rem] rounded-xl border p-3 shadow-lg"
          style={{
            backgroundColor: "var(--color-surface)",
            borderColor: "var(--color-border)",
          }}
        >
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              Notifications
            </h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                className="text-xs transition-colors"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Mark all read
              </button>
              <button
                type="button"
                onClick={() => clearAll.mutate()}
                className="text-xs transition-colors"
                style={{ color: "var(--color-danger)" }}
              >
                Clear all
              </button>
            </div>
          </div>

          {preferences && (
            <div className="mb-3 rounded-lg border p-3 text-xs" style={{ borderColor: "var(--color-border)" }}>
              <div className="mb-2 font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Preferences
              </div>
              {([
                ["assignments", "Assignments"],
                ["comments", "Comments"],
                ["statusChanges", "Status changes"],
                ["mentions", "Mentions"],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between py-1" style={{ color: "var(--color-text-secondary)" }}>
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={preferences[key]}
                    onChange={(event) =>
                      updatePreferences.mutate({
                        ...preferences,
                        [key]: event.target.checked,
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}

          <div className="max-h-96 space-y-2 overflow-y-auto">
            {notifications.map((notification) => {
              const actorLabel = notification.actor?.name?.trim() || notification.actor?.email || "System";
              const taskLabel = notification.task
                ? `${notification.task.project.key}-${notification.task.taskNumber} ${notification.task.title}`
                : "a task";

              return (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => {
                    markRead.mutate({ id: notification.id });
                    if (notification.task) {
                      router.push(`/${notification.task.project.slug}?task=${notification.task.id}`);
                    }
                    setOpen(false);
                  }}
                  className="block w-full rounded-lg border p-3 text-left transition-colors"
                  style={{
                    borderColor: "var(--color-border)",
                    backgroundColor: notification.readAt ? "var(--color-surface)" : "var(--color-accent-muted)",
                  }}
                >
                  <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
                    {actorLabel}
                  </div>
                  <div className="mt-1 text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    {notification.type === "assigned" && `assigned you to ${taskLabel}`}
                    {notification.type === "commented" && `commented on ${taskLabel}`}
                    {notification.type === "statusChanged" && `changed the status of ${taskLabel}`}
                    {notification.type === "mentioned" && `mentioned you on ${taskLabel}`}
                  </div>
                  <div className="mt-2 text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                    {new Date(notification.createdAt).toLocaleString()}
                  </div>
                </button>
              );
            })}

            {notifications.length === 0 && (
              <p className="py-6 text-center text-xs" style={{ color: "var(--color-text-muted)" }}>
                No notifications yet
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}