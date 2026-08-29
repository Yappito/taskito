"use client";

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { StatusBadge } from "./status-badge";
import { PriorityBadge } from "@/components/ui/priority-badge";
import { TagBadgeList } from "@/components/ui/tag-badge";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { isInteractiveCardTarget } from "./task-view-helpers";
import type { AlertLevel } from "@/lib/alert-utils";
import type { TaskCardData } from "@/lib/types";

export interface TaskCardStatusOption {
  id: string;
  name: string;
}

export interface TaskCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onClick"> {
  task: TaskCardData;
  onClick?: () => void;
  className?: string;
  alertLevel?: AlertLevel;
  leadingContent?: ReactNode;
  /** Statuses offered by the per-card "Move to…" select (keyboard/wheel status changes) */
  statusOptions?: TaskCardStatusOption[];
  /** Same status update the drag-and-drop gesture performs */
  onMoveToStatus?: (statusId: string) => void;
}

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
export function TaskCard({
  task,
  onClick,
  className,
  alertLevel,
  leadingContent,
  statusOptions,
  onMoveToStatus,
  onKeyDown,
  style,
  ...rest
}: TaskCardProps) {
  const dueDate = new Date(task.dueDate);
  const isOverdue =
    dueDate < new Date() && task.status.category !== "done" && task.status.category !== "cancelled";
  const taskKey = task.project?.key && task.taskNumber
    ? `${task.project.key}-${task.taskNumber}`
    : null;
  const assigneeLabel = task.assignee?.name?.trim() || task.assignee?.email || "Unassigned";
  const participantPeople = (task.participants ?? []).map((participant) => participant.user);
  const visibleParticipants = participantPeople.slice(0, 3);
  const extraParticipantCount = Math.max(participantPeople.length - visibleParticipants.length, 0);
  const participantTitle = participantPeople.map((person) => person.name?.trim() || person.email).join(", ");
  const dependencyMessages = getDependencyMessages(task);
  const interactive = onClick != null;

  function handleCardKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveCardTarget(event.target, event.currentTarget)) return;
    event.preventDefault();
    onClick?.();
  }

  return (
    <div
      {...rest}
      onClick={onClick}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) handleCardKeyDown(event);
      }}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      className={cn(
        "group overflow-hidden rounded-2xl border p-3.5 transition-colors transition-shadow hover:shadow-[var(--shadow-md)]",
        interactive ? "cursor-pointer" : "",
        alertLevel === "critical" && "pulse-critical",
        alertLevel === "warning" && "pulse-warning",
        className
      )}
      style={{
        backgroundColor: "var(--color-surface)",
        borderColor: isOverdue ? "color-mix(in srgb, var(--color-danger) 42%, var(--color-border))" : "var(--color-border)",
        color: "var(--color-text)",
        boxShadow: "var(--shadow-sm)",
        ...style,
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <StatusBadge name={task.status.name} color={task.status.color} />
        <PriorityBadge priority={task.priority} />
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
        {task.sprint && (
          <Badge
            className="text-[10px]"
            style={{ backgroundColor: "var(--color-accent-muted)", color: "var(--color-accent)" } as React.CSSProperties}
          >
            Sprint: {task.sprint.name}
          </Badge>
        )}
        {task.tags.length > 0 && (
          <TagBadgeList
            tags={task.tags.map(({ tag }) => tag)}
            max={3}
            className="max-w-full"
          />
        )}
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

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: "var(--color-border-muted)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn("rounded-full px-2 py-1 text-[11px]", isOverdue ? "font-semibold" : "")}
            style={{
              backgroundColor: isOverdue ? "var(--color-danger-muted)" : "var(--color-bg-muted)",
              color: isOverdue ? "var(--color-danger)" : "var(--color-text-muted)",
            }}
          >
            {isOverdue ? "Overdue" : "Due"} {dueDate.toLocaleDateString()}
          </span>
          {onMoveToStatus && (statusOptions?.length ?? 0) > 0 && (
            <div
              className="cursor-pointer"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <Select
                aria-label={`Move ${task.title} to status`}
                value={task.statusId}
                onChange={(event) => {
                  const statusId = event.target.value;
                  if (statusId) onMoveToStatus(statusId);
                }}
                className="h-7 w-32 px-2 py-0 text-[11px]"
              >
                {statusOptions!.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div className="flex max-w-[11rem] items-center gap-2 text-right">
          {participantPeople.length > 0 && (
            <div className="flex items-center" title={participantTitle}>
              {visibleParticipants.map((participant, index) => (
                <Avatar
                  key={participant.id}
                  name={participant.name}
                  email={participant.email}
                  image={participant.image}
                  size="xs"
                  className="ring-1 ring-[var(--color-border)]"
                  style={{ marginLeft: index === 0 ? 0 : -8 }}
                />
              ))}
              {extraParticipantCount > 0 && (
                <span
                  className="ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{
                    backgroundColor: "var(--color-bg-muted)",
                    color: "var(--color-text-muted)",
                  }}
                >
                  +{extraParticipantCount}
                </span>
              )}
            </div>
          )}
          <div className="flex min-w-0 items-center gap-1.5" title={assigneeLabel}>
            {task.assignee && (
              <Avatar
                name={task.assignee.name}
                email={task.assignee.email}
                image={task.assignee.image}
                size="xs"
                className="ring-1 ring-[var(--color-border)]"
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
    </div>
  );
}