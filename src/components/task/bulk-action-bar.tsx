"use client";

import { useMemo, useState } from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { TaskFilterAssigneeOption, TaskFilterTagOption } from "@/lib/types";

interface BulkActionStatusOption {
  id: string;
  name: string;
  color: string;
}

interface BulkActionSprintOption {
  id: string;
  name: string;
  status: "planning" | "active" | "completed";
}

interface BulkActionBarProps {
  selectedCount: number;
  /** Number of tasks currently loaded in the view; bulk selection only ever
   * acts on these, never on unloaded pages. */
  loadedCount: number;
  statuses: BulkActionStatusOption[];
  sprints: BulkActionSprintOption[];
  tags: TaskFilterTagOption[];
  assignees: TaskFilterAssigneeOption[];
  isPending?: boolean;
  allVisibleSelected?: boolean;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onApplyStatus: (statusId: string) => void;
  onApplyAssignee: (assigneeId: string | null) => void;
  onApplySprint: (sprintId: string | null) => void;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onArchive: () => void;
}

const UNASSIGNED_VALUE = "__unassigned";
const NO_SPRINT_VALUE = "__no_sprint";

export function BulkActionBar({
  selectedCount,
  loadedCount,
  statuses,
  sprints,
  tags,
  assignees,
  isPending = false,
  allVisibleSelected = false,
  onSelectAllVisible,
  onClearSelection,
  onApplyStatus,
  onApplyAssignee,
  onApplySprint,
  onAddTag,
  onRemoveTag,
  onArchive,
}: BulkActionBarProps) {
  const [statusId, setStatusId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [sprintId, setSprintId] = useState("");
  const [tagId, setTagId] = useState("");
  const { confirm, confirmElement } = useConfirm();

  const assigneeOptions = useMemo(
    () => assignees.map((assignee) => ({ value: assignee.id, label: assignee.name?.trim() || assignee.email })),
    [assignees]
  );

  async function handleArchiveClick() {
    const confirmed = await confirm({
      title: "Archive selected tasks?",
      description: `${selectedCount} ${selectedCount === 1 ? "task" : "tasks"} will be moved to the archive. You can restore them from the archive view.`,
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      destructive: true,
    });

    if (confirmed) {
      onArchive();
    }
  }

  if (selectedCount === 0) {
    return confirmElement;
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
          <Button type="button" variant="secondary" size="sm" onClick={onSelectAllVisible} aria-label={allVisibleSelected ? "Deselect all loaded tasks" : "Select all loaded tasks"}>
            {allVisibleSelected ? `Deselect all loaded (${loadedCount})` : `Select all loaded (${loadedCount})`}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onClearSelection}>
            Clear selection
          </Button>
        </div>

        <div className="grid gap-2 md:grid-cols-2 xl:flex xl:flex-wrap xl:items-center">
          <div className="flex gap-2">
            <Select value={statusId} onChange={(event) => setStatusId(event.target.value)} disabled={isPending} className="min-w-40">
              <option value="">Move to status...</option>
              {statuses.map((status) => (
                <option key={status.id} value={status.id}>{status.name}</option>
              ))}
            </Select>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!statusId || isPending}
              onClick={() => {
                onApplyStatus(statusId);
                setStatusId("");
              }}
            >
              Apply status
            </Button>
          </div>

          <div className="flex gap-2">
            <Select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} disabled={isPending} className="min-w-44">
              <option value="">Assign to...</option>
              <option value={UNASSIGNED_VALUE}>Unassigned</option>
              {assigneeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!assigneeId || isPending}
              onClick={() => {
                onApplyAssignee(assigneeId === UNASSIGNED_VALUE ? null : assigneeId);
                setAssigneeId("");
              }}
            >
              Apply assignee
            </Button>
          </div>

          <div className="flex gap-2">
            <Select
              value={sprintId}
              onChange={(event) => setSprintId(event.target.value)}
              disabled={isPending || (sprints.length === 0 && sprintId !== NO_SPRINT_VALUE)}
              className="min-w-44"
              aria-label="Select sprint for selected tasks"
            >
              <option value="">{sprints.length > 0 ? "Assign to sprint..." : "No sprints available"}</option>
              <option value={NO_SPRINT_VALUE}>No sprint</option>
              {sprints.map((sprint) => (
                <option key={sprint.id} value={sprint.id}>{sprint.name} ({sprint.status})</option>
              ))}
            </Select>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!sprintId || isPending}
              onClick={() => {
                onApplySprint(sprintId === NO_SPRINT_VALUE ? null : sprintId);
                setSprintId("");
              }}
            >
              Apply sprint
            </Button>
          </div>

          <div className="flex gap-2">
            <Select value={tagId} onChange={(event) => setTagId(event.target.value)} disabled={isPending} className="min-w-40">
              <option value="">Choose tag...</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!tagId || isPending}
              onClick={() => {
                onAddTag(tagId);
                setTagId("");
              }}
            >
              Add tag
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!tagId || isPending}
              onClick={() => {
                onRemoveTag(tagId);
                setTagId("");
              }}
            >
              Remove tag
            </Button>
          </div>

          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isPending}
            onClick={handleArchiveClick}
          >
            Archive selected
          </Button>
        </div>
      </div>
      {confirmElement}
    </div>
  );
}