"use client";

import { useMemo, useState } from "react";
import { Select } from "@/components/ui/select";
import type { TaskFilterAssigneeOption, TaskFilterTagOption } from "@/lib/types";

interface BulkActionStatusOption {
  id: string;
  name: string;
  color: string;
}

interface BulkActionBarProps {
  selectedCount: number;
  statuses: BulkActionStatusOption[];
  tags: TaskFilterTagOption[];
  assignees: TaskFilterAssigneeOption[];
  isPending?: boolean;
  allVisibleSelected?: boolean;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onApplyStatus: (statusId: string) => void;
  onApplyAssignee: (assigneeId: string | null) => void;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onArchive: () => void;
}

const UNASSIGNED_VALUE = "__unassigned";

export function BulkActionBar({
  selectedCount,
  statuses,
  tags,
  assignees,
  isPending = false,
  allVisibleSelected = false,
  onSelectAllVisible,
  onClearSelection,
  onApplyStatus,
  onApplyAssignee,
  onAddTag,
  onRemoveTag,
  onArchive,
}: BulkActionBarProps) {
  const [statusId, setStatusId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [tagId, setTagId] = useState("");

  const assigneeOptions = useMemo(
    () => assignees.map((assignee) => ({ value: assignee.id, label: assignee.name?.trim() || assignee.email })),
    [assignees]
  );

  if (selectedCount === 0) {
    return null;
  }

  return (
    <div
      className="mx-4 mt-3 rounded-xl border p-3"
      style={{
        backgroundColor: "var(--color-surface)",
        borderColor: "var(--color-border)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: "var(--color-text)" }}>
          <span className="font-medium">{selectedCount} selected</span>
          <button
            type="button"
            onClick={onSelectAllVisible}
            className="rounded-lg px-2.5 py-1 text-xs transition-colors"
            style={{
              backgroundColor: "var(--color-bg-muted)",
              color: "var(--color-text-secondary)",
            }}
          >
            {allVisibleSelected ? "Deselect visible" : "Select visible"}
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            className="rounded-lg px-2.5 py-1 text-xs transition-colors"
            style={{
              backgroundColor: "var(--color-bg-muted)",
              color: "var(--color-text-secondary)",
            }}
          >
            Clear selection
          </button>
        </div>

        <div className="grid gap-2 md:grid-cols-2 xl:flex xl:flex-wrap xl:items-center">
          <div className="flex gap-2">
            <Select value={statusId} onChange={(event) => setStatusId(event.target.value)} disabled={isPending} className="min-w-40">
              <option value="">Move to status...</option>
              {statuses.map((status) => (
                <option key={status.id} value={status.id}>{status.name}</option>
              ))}
            </Select>
            <button
              type="button"
              disabled={!statusId || isPending}
              onClick={() => {
                onApplyStatus(statusId);
                setStatusId("");
              }}
              className="rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: "var(--color-accent)", color: "white" }}
            >
              Apply status
            </button>
          </div>

          <div className="flex gap-2">
            <Select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} disabled={isPending} className="min-w-44">
              <option value="">Assign to...</option>
              <option value={UNASSIGNED_VALUE}>Unassigned</option>
              {assigneeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
            <button
              type="button"
              disabled={!assigneeId || isPending}
              onClick={() => {
                onApplyAssignee(assigneeId === UNASSIGNED_VALUE ? null : assigneeId);
                setAssigneeId("");
              }}
              className="rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: "var(--color-accent)", color: "white" }}
            >
              Apply assignee
            </button>
          </div>

          <div className="flex gap-2">
            <Select value={tagId} onChange={(event) => setTagId(event.target.value)} disabled={isPending} className="min-w-40">
              <option value="">Choose tag...</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </Select>
            <button
              type="button"
              disabled={!tagId || isPending}
              onClick={() => {
                onAddTag(tagId);
                setTagId("");
              }}
              className="rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-secondary)" }}
            >
              Add tag
            </button>
            <button
              type="button"
              disabled={!tagId || isPending}
              onClick={() => {
                onRemoveTag(tagId);
                setTagId("");
              }}
              className="rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-secondary)" }}
            >
              Remove tag
            </button>
          </div>

          <button
            type="button"
            disabled={isPending}
            onClick={onArchive}
            className="rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: "var(--color-danger)", color: "white" }}
          >
            Archive selected
          </button>
        </div>
      </div>
    </div>
  );
}