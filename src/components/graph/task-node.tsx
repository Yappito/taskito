"use client";

import { memo } from "react";

import type { AlertLevel } from "@/lib/alert-utils";
import { Avatar } from "@/components/ui/avatar";

interface TaskNodeProps {
  id: string;
  title: string;
  dueDate: string | Date;
  statusName: string;
  statusColor: string;
  priority: string;
  tags: Array<{ name: string; color: string }>;
  assigneeName?: string | null;
  assigneeEmail?: string | null;
  assigneeImage?: string | null;
  dependencyState?: {
    blockingTaskCount: number;
    openChildCount: number;
  };
  x: number;
  y: number;
  width: number;
  height: number;
  selected?: boolean;
  highlighted?: boolean;
  alertLevel?: AlertLevel;
  onClick?: () => void;
  onInfoClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Called when user starts dragging from the output port */
  onPortDragStart?: (side: "left" | "right") => void;
  /** Called when user drops on a port */
  onPortDrop?: (event: React.MouseEvent) => void;
  /** Whether this node is a valid drop target during linking */
  isLinkTarget?: boolean;
}

/** Format relative time until due date */
function formatTimeLeft(dueDate: string | Date): string {
  const now = new Date();
  const due = new Date(dueDate);
  const diffMs = due.getTime() - now.getTime();
  const absDays = Math.abs(Math.round(diffMs / (1000 * 60 * 60 * 24)));
  const past = diffMs < 0;

  if (absDays === 0) return "today";
  if (absDays === 1) return past ? "1d ago" : "1d left";
  if (absDays < 7) return past ? `${absDays}d ago` : `${absDays}d left`;
  const weeks = Math.round(absDays / 7);
  if (absDays < 30) return past ? `${weeks}w ago` : `${weeks}w left`;
  const months = Math.round(absDays / 30);
  return past ? `${months}mo ago` : `${months}mo left`;
}

const priorityColors: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#6366f1",
  none: "transparent",
};

const priorityIcons: Record<string, string> = {
  urgent: "⬆⬆",
  high: "⬆",
  medium: "➡",
  low: "⬇",
  none: "",
};

function getDependencyMessages(dependencyState?: {
  blockingTaskCount: number;
  openChildCount: number;
}) {
  const messages: string[] = [];

  if ((dependencyState?.blockingTaskCount ?? 0) > 0) {
    messages.push(`B:${dependencyState!.blockingTaskCount}`);
  }

  if ((dependencyState?.openChildCount ?? 0) > 0) {
    messages.push(`C:${dependencyState!.openChildCount}`);
  }

  return messages;
}

/** Modern task node with Sankey connection ports */
export const TaskNode = memo(function TaskNode({
  id,
  title,
  dueDate,
  statusName,
  statusColor,
  priority,
  tags,
  assigneeName,
  assigneeEmail,
  assigneeImage,
  dependencyState,
  x,
  y,
  width,
  height,
  selected,
  highlighted,
  alertLevel,
  onClick,
  onInfoClick,
  onMouseEnter,
  onMouseLeave,
  onPortDragStart,
  onPortDrop,
  isLinkTarget,
}: TaskNodeProps) {
  const portRadius = 6;
  const timeLeft = formatTimeLeft(dueDate);
  const isPast = new Date(dueDate) < new Date();
  const assigneeLabel = assigneeName?.trim() || "Unassigned";
  const dependencyMessages = getDependencyMessages(dependencyState);
  const showAlertPulse = alertLevel !== "none" && !!alertLevel;
  const nodeStyle = selected
    ? { filter: "drop-shadow(0 0 8px var(--color-accent-muted))" }
    : highlighted
      ? { filter: "drop-shadow(0 0 6px var(--color-accent-muted))" }
      : isLinkTarget
        ? { filter: "drop-shadow(0 0 6px var(--color-accent-muted))", cursor: "crosshair" }
        : undefined;

  return (
    <g
      transform={`translate(${x}, ${y})`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="graph-node"
      data-task-id={id}
      data-task-title={title}
      data-task-tags={tags.map((tag) => tag.name).join(",")}
      data-filter-match={highlighted ? "true" : "false"}
      onMouseUp={
        isLinkTarget
          ? (e) => {
              e.stopPropagation();
              onPortDrop?.(e);
            }
          : undefined
      }
    >
      {/* Pulsating glow rect for due-date alerts */}
      {showAlertPulse && (
        <rect
          x={-4}
          y={-4}
          width={width + 8}
          height={height + 8}
          rx={14}
          fill="none"
          stroke={alertLevel === "critical" ? "#ef4444" : "#f59e0b"}
          strokeWidth={2}
          opacity={0.6}
        >
          <animate
            attributeName="opacity"
            values="0.6;0.15;0.6"
            dur={alertLevel === "critical" ? "1.5s" : "2s"}
            repeatCount="indefinite"
          />
          <animate
            attributeName="stroke-width"
            values="2;5;2"
            dur={alertLevel === "critical" ? "1.5s" : "2s"}
            repeatCount="indefinite"
          />
        </rect>
      )}

      {/* Drop shadow (theme-aware via filter) */}
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        rx={10}
        fill="var(--color-node-shadow)"
        transform="translate(1, 2)"
      />

      {/* Main card */}
      <rect
        width={width}
        height={height}
        rx={10}
        fill="var(--color-node-bg)"
        stroke={
          isLinkTarget
            ? "var(--color-accent)"
            : selected
              ? "var(--color-accent)"
              : highlighted
                ? "var(--color-accent)"
              : "var(--color-node-border)"
        }
        strokeWidth={isLinkTarget ? 2 : selected ? 2 : highlighted ? 2 : 1}
        style={nodeStyle}
      />

      {/* Status accent strip (left edge, rounded) */}
      <rect
        x={0}
        y={8}
        width={4}
        height={height - 16}
        rx={2}
        fill={statusColor}
      />

      {/* Priority indicator — arrow icons (matching board view) */}
      {priority !== "none" && (
        <foreignObject x={width - 48} y={8} width={20} height={16}>
          <div
            className="text-right text-xs leading-none"
            style={{ color: priorityColors[priority] ?? "transparent" }}
          >
            {priorityIcons[priority]}
          </div>
        </foreignObject>
      )}

      {/* Info button for opening the detail panel without toggling focus mode */}
      <foreignObject x={width - 24} y={8} width={16} height={16}>
        <button
          type="button"
          aria-label="Open task details"
          onClick={(e) => {
            e.stopPropagation();
            onInfoClick?.();
          }}
          className="flex h-4 w-4 items-center justify-center rounded-full border text-[9px] font-bold leading-none"
          style={{
            backgroundColor: "var(--color-surface)",
            borderColor: "var(--color-border)",
            color: "var(--color-text-muted)",
            cursor: "pointer",
          }}
        >
          i
        </button>
      </foreignObject>

      {/* Title */}
      <foreignObject x={14} y={10} width={width - 58} height={22}>
        <div
          className="truncate text-xs font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          {title}
        </div>
      </foreignObject>

      {/* Status label + time left */}
      <foreignObject x={14} y={34} width={width - 28} height={16}>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          <span
            className="truncate text-[10px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {statusName}
          </span>
          {dependencyMessages.map((message) => (
            <span
              key={message}
              className="rounded-full px-1.5 py-0.5 text-[8px] font-semibold"
              style={{
                backgroundColor: "color-mix(in srgb, var(--color-danger) 12%, transparent)",
                color: "var(--color-danger)",
              }}
              title={message === dependencyMessages[0] && (dependencyState?.blockingTaskCount ?? 0) > 0
                ? `${dependencyState?.blockingTaskCount ?? 0} blocking task${(dependencyState?.blockingTaskCount ?? 0) === 1 ? "" : "s"} still open`
                : `${dependencyState?.openChildCount ?? 0} child task${(dependencyState?.openChildCount ?? 0) === 1 ? "" : "s"} still open`}
            >
              {message}
            </span>
          ))}
          <span
            className="ml-auto shrink-0 text-[9px] font-medium"
            style={{ color: isPast ? "var(--color-danger, #ef4444)" : "var(--color-text-muted)" }}
          >
            {timeLeft}
          </span>
        </div>
      </foreignObject>

      {/* Tags row + assignee */}
      <foreignObject x={14} y={54} width={width - 28} height={24}>
        <div className="flex items-end justify-between gap-2 overflow-hidden">
          <div className="flex min-w-0 gap-1 overflow-hidden">
            {tags.slice(0, 2).map((tag, i) => (
              <span
                key={i}
                className="inline-block rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                style={{
                  backgroundColor: `${tag.color}18`,
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-1" title={assigneeLabel}>
            {assigneeEmail && (
              <Avatar name={assigneeName} email={assigneeEmail} image={assigneeImage} size="xs" />
            )}
            <span
              className="max-w-[4.8rem] truncate text-right text-[9px]"
              style={{ color: "var(--color-text-muted)" }}
            >
              {assigneeLabel}
            </span>
          </div>
        </div>
      </foreignObject>

      {/* ─── Connection Ports ──────────────────── */}
      {/* Left (input) port */}
      <g
        className="connection-port"
        onMouseDown={(e) => {
          e.stopPropagation();
          onPortDragStart?.("left");
        }}
        onMouseUp={(e) => {
          e.stopPropagation();
          onPortDrop?.(e);
        }}
      >
        {/* Large invisible hit area when this node is a valid link target */}
        {isLinkTarget && (
          <rect
            x={-30}
            y={0}
            width={60}
            height={height}
            fill="transparent"
            style={{ cursor: "crosshair" }}
          />
        )}
        <circle
          cx={0}
          cy={height / 2}
          r={isLinkTarget ? portRadius + 3 : portRadius}
          fill={isLinkTarget ? "var(--color-accent)" : "var(--color-node-bg)"}
          stroke={isLinkTarget ? "var(--color-accent)" : "var(--color-node-border)"}
          strokeWidth={1.5}
          style={{ cursor: "crosshair" }}
        />
        {isLinkTarget && (
          <circle
            cx={0}
            cy={height / 2}
            r={portRadius + 10}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            opacity={0.3}
          />
        )}
      </g>

      {/* Right (output) port */}
      <g
        className="connection-port"
        onMouseDown={(e) => {
          e.stopPropagation();
          onPortDragStart?.("right");
        }}
      >
        <circle
          cx={width}
          cy={height / 2}
          r={portRadius}
          fill="var(--color-node-bg)"
          stroke="var(--color-node-border)"
          strokeWidth={1.5}
          style={{ cursor: "crosshair" }}
        />
      </g>
    </g>
  );
});
