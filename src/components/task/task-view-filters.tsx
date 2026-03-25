"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { TaskDateFilterState, TaskFilterAssigneeOption, TaskFilterPreset, TaskFilterTagOption } from "@/lib/types";
import type { TaskQuickDateFilter } from "@/hooks/use-task-view-filters";

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function getStartOfWeek(base: Date) {
  const day = base.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = shiftDate(base, diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function getEndOfWeek(base: Date) {
  const sunday = shiftDate(getStartOfWeek(base), 6);
  sunday.setHours(0, 0, 0, 0);
  return sunday;
}

function getStartOfMonth(base: Date) {
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

function getEndOfMonth(base: Date) {
  return new Date(base.getFullYear(), base.getMonth() + 1, 0);
}

interface TaskViewFiltersProps {
  search: string;
  selectedTagIds: string[];
  selectedAssigneeIds: string[];
  dueDateFrom: string;
  dueDateTo: string;
  closedAtFrom: string;
  closedAtTo: string;
  tags: TaskFilterTagOption[];
  assignees?: TaskFilterAssigneeOption[];
  onSearchChange: (value: string) => void;
  onToggleTag: (tagId: string) => void;
  onToggleAssignee: (assigneeId: string) => void;
  onDateFilterChange: (key: keyof TaskDateFilterState, value: string) => void;
  onApplyQuickDateFilter?: (filter: TaskQuickDateFilter) => void;
  onClear: () => void;
  presets?: TaskFilterPreset[];
  onApplyPreset?: (preset: TaskFilterPreset) => void;
  onSavePreset?: (name: string) => void;
  onDeletePreset?: (presetId: string) => void;
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
  dueDateFrom,
  dueDateTo,
  closedAtFrom,
  closedAtTo,
  assignees = [],
  onSearchChange,
  onToggleTag,
  onToggleAssignee,
  onDateFilterChange,
  onApplyQuickDateFilter,
  onClear,
  presets = [],
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  searchPlaceholder = "Filter by title...",
  helperText,
  className,
}: TaskViewFiltersProps) {
  const [presetName, setPresetName] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);

  const activeAdvancedFilterCount =
    selectedTagIds.length +
    selectedAssigneeIds.length +
    [dueDateFrom, dueDateTo, closedAtFrom, closedAtTo].filter(Boolean).length;

  const hasAnyFilters = !!search.trim() || activeAdvancedFilterCount > 0;
  const today = new Date();
  const todayValue = formatDateInput(today);
  const dueThisWeekFrom = formatDateInput(getStartOfWeek(today));
  const dueThisWeekTo = formatDateInput(getEndOfWeek(today));
  const closedThisMonthFrom = formatDateInput(getStartOfMonth(today));
  const closedThisMonthTo = formatDateInput(getEndOfMonth(today));

  function isQuickFilterActive(filter: TaskQuickDateFilter) {
    if (filter === "clear-dates") {
      return !dueDateFrom && !dueDateTo && !closedAtFrom && !closedAtTo;
    }

    if (filter === "due-this-week") {
      return (
        dueDateFrom === dueThisWeekFrom &&
        dueDateTo === dueThisWeekTo &&
        !closedAtFrom &&
        !closedAtTo
      );
    }

    if (filter === "closed-today") {
      return (
        closedAtFrom === todayValue &&
        closedAtTo === todayValue &&
        !dueDateFrom &&
        !dueDateTo
      );
    }

    if (filter === "closed-this-week") {
      return (
        closedAtFrom === dueThisWeekFrom &&
        closedAtTo === dueThisWeekTo &&
        !dueDateFrom &&
        !dueDateTo
      );
    }

    return (
      closedAtFrom === closedThisMonthFrom &&
      closedAtTo === closedThisMonthTo &&
      !dueDateFrom &&
      !dueDateTo
    );
  }

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
          onClick={() => setIsExpanded((value) => !value)}
          className="rounded-lg px-3 py-2 text-xs transition-colors"
          style={{
            backgroundColor: "var(--color-bg-muted)",
            color: "var(--color-text-secondary)",
          }}
        >
          {isExpanded ? "Hide filters" : `Show filters${activeAdvancedFilterCount > 0 ? ` (${activeAdvancedFilterCount})` : ""}`}
        </button>
      </div>

      <button
        type="button"
        onClick={onClear}
        className="mt-2 rounded-lg px-3 py-2 text-xs transition-colors"
        style={{
          backgroundColor: hasAnyFilters
            ? "color-mix(in srgb, var(--color-danger) 14%, var(--color-surface))"
            : "var(--color-bg-muted)",
          color: hasAnyFilters ? "var(--color-danger)" : "var(--color-text-secondary)",
          border: hasAnyFilters
            ? "1px solid color-mix(in srgb, var(--color-danger) 28%, var(--color-border))"
            : "1px solid var(--color-border)",
        }}
      >
        Clear all filters
      </button>

      {isExpanded && (
        <>
          {helperText && (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--color-text-muted)" }}
            >
              {helperText}
            </p>
          )}

          {(onSavePreset || presets.length > 0) && (
            <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              {onSavePreset && (
                <div className="flex gap-2">
                  <input
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                    placeholder="Preset name"
                    className="rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    style={{
                      backgroundColor: "var(--color-surface)",
                      borderColor: "var(--color-border)",
                      color: "var(--color-text)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const trimmed = presetName.trim();
                      if (!trimmed) return;
                      onSavePreset(trimmed);
                      setPresetName("");
                    }}
                    className="rounded-lg px-3 py-2 text-xs font-medium transition-colors"
                    style={{
                      backgroundColor: "var(--color-accent)",
                      color: "white",
                    }}
                  >
                    Save preset
                  </button>
                </div>
              )}

              {presets.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {presets.map((preset) => (
                    <div key={preset.id} className="flex items-center gap-1 rounded-full border px-2 py-1" style={{ borderColor: "var(--color-border)" }}>
                      <button
                        type="button"
                        onClick={() => {
                          onApplyPreset?.(preset);
                          setIsExpanded(true);
                        }}
                        className="text-xs font-medium transition-colors"
                        style={{ color: "var(--color-text-secondary)" }}
                      >
                        {preset.name}
                      </button>
                      {onDeletePreset && (
                        <button
                          type="button"
                          onClick={() => onDeletePreset(preset.id)}
                          className="text-xs transition-colors"
                          style={{ color: "var(--color-text-muted)" }}
                          aria-label={`Delete preset ${preset.name}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)" }}>
              <div className="mb-2 text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Due Date Range
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  From
                  <input
                    type="date"
                    value={dueDateFrom}
                    onChange={(event) => onDateFilterChange("dueDateFrom", event.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    style={{
                      backgroundColor: "var(--color-surface)",
                      borderColor: "var(--color-border)",
                      color: "var(--color-text)",
                    }}
                  />
                </label>
                <label className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  To
                  <input
                    type="date"
                    value={dueDateTo}
                    onChange={(event) => onDateFilterChange("dueDateTo", event.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    style={{
                      backgroundColor: "var(--color-surface)",
                      borderColor: "var(--color-border)",
                      color: "var(--color-text)",
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)" }}>
              <div className="mb-2 text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Closure Date Range
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  From
                  <input
                    type="date"
                    value={closedAtFrom}
                    onChange={(event) => onDateFilterChange("closedAtFrom", event.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    style={{
                      backgroundColor: "var(--color-surface)",
                      borderColor: "var(--color-border)",
                      color: "var(--color-text)",
                    }}
                  />
                </label>
                <label className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  To
                  <input
                    type="date"
                    value={closedAtTo}
                    onChange={(event) => onDateFilterChange("closedAtTo", event.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    style={{
                      backgroundColor: "var(--color-surface)",
                      borderColor: "var(--color-border)",
                      color: "var(--color-text)",
                    }}
                  />
                </label>
              </div>
            </div>
          </div>

          {onApplyQuickDateFilter && (
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                { id: "due-this-week", label: "Due this week" },
                { id: "closed-today", label: "Closed today" },
                { id: "closed-this-week", label: "Closed this week" },
                { id: "closed-this-month", label: "Closed this month" },
                { id: "clear-dates", label: "Clear dates" },
              ].map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => onApplyQuickDateFilter(action.id as TaskQuickDateFilter)}
                  className="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                  style={
                    isQuickFilterActive(action.id as TaskQuickDateFilter)
                      ? {
                          borderColor: "var(--color-accent)",
                          backgroundColor: "var(--color-accent-muted)",
                          color: "var(--color-accent)",
                        }
                      : {
                          borderColor: "var(--color-border)",
                          backgroundColor: "var(--color-bg-muted)",
                          color: "var(--color-text-secondary)",
                        }
                  }
                >
                  {action.label}
                </button>
              ))}
            </div>
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
        </>
      )}
    </div>
  );
}