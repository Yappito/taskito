"use client";

import { cn } from "@/lib/utils";
import type { TaskFilterAssigneeOption, TaskFilterTagOption } from "@/lib/types";

interface TaskViewFiltersProps {
  search: string;
  selectedTagIds: string[];
  selectedAssigneeIds: string[];
  tags: TaskFilterTagOption[];
  assignees?: TaskFilterAssigneeOption[];
  onSearchChange: (value: string) => void;
  onToggleTag: (tagId: string) => void;
  onToggleAssignee: (assigneeId: string) => void;
  onClear: () => void;
  searchPlaceholder?: string;
  helperText?: string;
  className?: string;
}

/** Shared title/tag filter controls for task views. */
export function TaskViewFilters({
  search,
  selectedTagIds,
  tags,
  selectedAssigneeIds,
  assignees = [],
  onSearchChange,
  onToggleTag,
  onToggleAssignee,
  onClear,
  searchPlaceholder = "Filter by title...",
  helperText,
  className,
}: TaskViewFiltersProps) {
  return (
    <div
      className={cn("rounded-xl border p-3", className)}
      style={{
        backgroundColor: "var(--color-surface)",
        borderColor: "var(--color-border)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex-1">
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)",
              color: "var(--color-text)",
            }}
          />
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg px-3 py-2 text-xs transition-colors"
          style={{
            backgroundColor: "var(--color-bg-muted)",
            color: "var(--color-text-secondary)",
          }}
        >
          Clear filters
        </button>
      </div>

      {helperText && (
        <p
          className="mt-2 text-xs"
          style={{ color: "var(--color-text-muted)" }}
        >
          {helperText}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {tags.map((tag) => {
          const selected = selectedTagIds.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() => onToggleTag(tag.id)}
              className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
              style={{
                backgroundColor: selected ? `${tag.color}20` : "var(--color-surface)",
                borderColor: selected ? tag.color : "var(--color-border)",
                color: selected ? tag.color : "var(--color-text-secondary)",
              }}
            >
              {tag.name}
            </button>
          );
        })}
      </div>

      {assignees.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {assignees.map((assignee) => {
            const selected = selectedAssigneeIds.includes(assignee.id);
            const label = assignee.name?.trim() || assignee.email;

            return (
              <button
                key={assignee.id}
                type="button"
                onClick={() => onToggleAssignee(assignee.id)}
                className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                style={{
                  backgroundColor: selected ? "var(--color-accent-muted)" : "var(--color-surface)",
                  borderColor: selected ? "var(--color-accent)" : "var(--color-border)",
                  color: selected ? "var(--color-accent)" : "var(--color-text-secondary)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}