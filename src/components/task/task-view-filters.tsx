"use client";

import { cn } from "@/lib/utils";
import type { TaskFilterTagOption } from "@/lib/types";

interface TaskViewFiltersProps {
  search: string;
  selectedTagIds: string[];
  tags: TaskFilterTagOption[];
  onSearchChange: (value: string) => void;
  onToggleTag: (tagId: string) => void;
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
  onSearchChange,
  onToggleTag,
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
    </div>
  );
}