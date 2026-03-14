"use client";

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

/** Card displaying a single task with status, priority, tags */
export function TaskCard({ task, onClick, className, alertLevel }: TaskCardProps) {
  const dueDate = new Date(task.dueDate);
  const isOverdue = dueDate < new Date() && task.status.name !== "Done" && task.status.name !== "Cancelled";
  const taskKey = task.project?.key && task.taskNumber
    ? `${task.project.key}-${task.taskNumber}`
    : null;

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

      <div className="mt-2 flex items-center justify-between">
        <span
          className={cn("text-xs", isOverdue ? "font-medium" : "")}
          style={{ color: isOverdue ? "var(--color-danger)" : "var(--color-text-muted)" }}
        >
          {dueDate.toLocaleDateString()}
        </span>
      </div>
    </div>
  );
}
