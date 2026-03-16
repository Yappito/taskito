"use client";

import type { ReactNode } from "react";
import { StatusBadge } from "./status-badge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AlertLevel } from "@/lib/alert-utils";
import type { TaskCardData } from "@/lib/types";

interface TaskCardProps {
  task: TaskCardData;
  onClick?: () => void;
  className?: string;
  alertLevel?: AlertLevel;
  leadingContent?: ReactNode;
}

const priorityColors: Record<string, string> = {
  urgent: "var(--color-danger)",
  high: "#f97316",
  medium: "#eab308",
  low: "var(--color-accent)",
  none: "var(--color-text-muted)",
};

const priorityIcons: Record<string, string> = {
  urgent: "⬆⬆",
  high: "⬆",
  medium: "➡",
  low: "⬇",
  none: "",
};

function getDependencyMessages(task: TaskCardData) {
  const messages: string[] = [];

  if ((task.dependencyState?.blockingTaskCount ?? 0) > 0) {
    messages.push(`Blocked by ${task.dependencyState!.blockingTaskCount}`);
  }

  if ((task.dependencyState?.openChildCount ?? 0) > 0) {
    messages.push(`${task.dependencyState!.openChildCount} open child${task.dependencyState!.openChildCount === 1 ? "" : "ren"}`);
  }

  return messages;
}

/** Card displaying a single task with status, priority, tags */
export function TaskCard({ task, onClick, className, alertLevel, leadingContent }: TaskCardProps) {
  const dueDate = new Date(task.dueDate);
  const isOverdue = dueDate < new Date() && task.status.name !== "Done" && task.status.name !== "Cancelled";
  const taskKey = task.project?.key && task.taskNumber
    ? `${task.project.key}-${task.taskNumber}`
    : null;
  const assigneeLabel = task.assignee?.name?.trim() || task.assignee?.email || "Unassigned";
  const dependencyMessages = getDependencyMessages(task);

  return (
    <div
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-lg border p-3 shadow-sm transition-colors transition-shadow",
        alertLevel === "critical" && "pulse-critical",
        alertLevel === "warning" && "pulse-warning",
        className
      )}
      style={{
        backgroundColor: "var(--color-surface)",
        borderColor: "var(--color-border)",
        color: "var(--color-text)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {leadingContent}
          <div className="min-w-0">
          {taskKey && (
            <span
              className="mb-0.5 block text-[10px] font-semibold"
              style={{ color: "var(--color-text-muted)" }}
            >
              {taskKey}
            </span>
          )}
          <h3 className="text-sm font-medium line-clamp-2">
            {task.title}
          </h3>
          </div>
        </div>
        {task.priority !== "none" && (
          <span className="text-xs shrink-0" style={{ color: priorityColors[task.priority] }}>
            {priorityIcons[task.priority]}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusBadge name={task.status.name} color={task.status.color} />
        {task.tags.slice(0, 3).map(({ tag }) => (
          <Badge
            key={tag.id}
            className="text-[10px]"
            style={{ backgroundColor: `${tag.color}20`, color: tag.color } as React.CSSProperties}
          >
            {tag.name}
          </Badge>
        ))}
      </div>

      {dependencyMessages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {dependencyMessages.map((message) => (
            <span
              key={message}
              className="rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: "color-mix(in srgb, var(--color-danger) 12%, transparent)",
                color: "var(--color-danger)",
              }}
            >
              {message}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span
          className={cn("text-xs", isOverdue ? "font-medium" : "")}
          style={{ color: isOverdue ? "var(--color-danger)" : "var(--color-text-muted)" }}
        >
          {dueDate.toLocaleDateString()}
        </span>
        <span
          className="max-w-[8rem] truncate text-right text-[11px]"
          style={{ color: "var(--color-text-muted)" }}
          title={assigneeLabel}
        >
          {assigneeLabel}
        </span>
      </div>
    </div>
  );
}
