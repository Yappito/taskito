import * as React from "react";
import { cn } from "@/lib/utils";

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** One token per priority so every view renders the same pill colours */
export const priorityTokens: Record<TaskPriority, string> = {
  urgent: "var(--color-priority-urgent)",
  high: "var(--color-priority-high)",
  medium: "var(--color-priority-medium)",
  low: "var(--color-priority-low)",
  none: "var(--color-text-muted)",
};

export const priorityLabels: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

/** Resolves any priority-ish string to a --color-priority-* token (falls back to muted) */
export function getPriorityToken(priority: string): string {
  return isTaskPriority(priority) ? priorityTokens[priority] : priorityTokens.none;
}

export function getPriorityLabel(priority: string): string {
  return isTaskPriority(priority) ? priorityLabels[priority] : priority;
}

export interface PriorityBadgeProps {
  priority: string;
  /** Also render a muted pill for "none" (hidden by default, like the task card) */
  showNone?: boolean;
  className?: string;
}

/** Shared priority pill used across board/list/detail views */
function PriorityBadge({ priority, showNone = false, className }: PriorityBadgeProps) {
  if (priority === "none" && !showNone) {
    return null;
  }

  const token = getPriorityToken(priority);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]",
        className
      )}
      style={{
        backgroundColor: `color-mix(in srgb, ${token} 14%, transparent)`,
        color: token,
      }}
    >
      {getPriorityLabel(priority)}
    </span>
  );
}

export { PriorityBadge };
