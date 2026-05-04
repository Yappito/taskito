"use client";

import type { ReactNode } from "react";
import { StatusBadge } from "./status-badge";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
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
  urgent: "var(--color-priority-urgent)",
  high: "var(--color-priority-high)",
  medium: "var(--color-priority-medium)",
  low: "var(--color-priority-low)",
  none: "var(--color-text-muted)",
};

const priorityLabels: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
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
        "group cursor-pointer overflow-hidden rounded-2xl border p-3.5 transition-colors transition-shadow hover:shadow-[var(--shadow-md)]",
        alertLevel === "critical" && "pulse-critical",
        alertLevel === "warning" && "pulse-warning",
        className
      )}
      style={{
        backgroundColor: "var(--color-surface)",
        borderColor: isOverdue ? "color-mix(in srgb, var(--color-danger) 42%, var(--color-border))" : "var(--color-border)",
        color: "var(--color-text)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <StatusBadge name={task.status.name} color={task.status.color} />
        {task.priority !== "none" && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]"
            style={{
              backgroundColor: `color-mix(in srgb, ${priorityColors[task.priority]} 14%, transparent)`,
              color: priorityColors[task.priority],
            }}
          >
            {priorityLabels[task.priority]}
          </span>
        )}
      </div>

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
          <h3 className="line-clamp-2 text-sm font-semibold leading-5 transition-colors group-hover:text-[var(--color-accent)]">
            {task.title}
          </h3>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
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

      <div className="mt-3 flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--color-border-muted)" }}>
        <span
          className={cn("rounded-full px-2 py-1 text-[11px]", isOverdue ? "font-semibold" : "")}
          style={{
            backgroundColor: isOverdue ? "var(--color-danger-muted)" : "var(--color-bg-muted)",
            color: isOverdue ? "var(--color-danger)" : "var(--color-text-muted)",
          }}
        >
          {isOverdue ? "Overdue" : "Due"} {dueDate.toLocaleDateString()}
        </span>
        <div className="flex max-w-[8.75rem] items-center gap-1.5 text-right" title={assigneeLabel}>
          {task.assignee && (
            <Avatar
              name={task.assignee.name}
              email={task.assignee.email}
              image={task.assignee.image}
              size="xs"
              className="ring-1 ring-black/5"
            />
          )}
          <span
            className="truncate text-[11px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {assigneeLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
