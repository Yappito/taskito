"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { TaskFilterAssigneeOption, TaskFilterTagOption } from "@/lib/types";

interface SavedFilterPreset {
  id: string;
  name: string;
  search: string;
  tagIds: string[];
  assigneeIds: string[];
}

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
  presets?: SavedFilterPreset[];
  onApplyPreset?: (preset: SavedFilterPreset) => void;
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
  assignees = [],
  onSearchChange,
  onToggleTag,
  onToggleAssignee,
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
                    onClick={() => onApplyPreset?.(preset)}
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