"use client";

import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { getAlertConfig, getAlertLevel } from "@/lib/alert-utils";
import { useTaskViewFilters } from "@/hooks/use-task-view-filters";

import { TaskDetail } from "./task-detail";
import { BulkActionBar } from "./bulk-action-bar";
import { StatusBadge } from "./status-badge";
import { TaskViewFilters } from "./task-view-filters";
import { Avatar } from "@/components/ui/avatar";
import type { TaskFilterPreset, TaskFilterTagOption } from "@/lib/types";
import { AiChatLauncher } from "@/components/ai/ai-chat-launcher";

interface ListViewProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string }>;
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

/** List view — sortable table of tasks */
export function ListView({ projectId, statuses, tags, projectSettings }: ListViewProps) {
  const alertConfig = getAlertConfig(projectSettings);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<"dueDate" | "title" | "priority">("dueDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const filters = useTaskViewFilters();
  const utils = trpc.useUtils();
  const { data: people } = trpc.project.people.useQuery({ projectId });
  const { data: presets = [] } = trpc.project.filterPresets.useQuery({ projectId });

  const taskListInput = useMemo(
    () => ({
      projectId,
      limit: 100,
      ...filters.queryFilters,
    }),
    [projectId, filters.queryFilters]
  );

  const { data, isLoading } = trpc.task.list.useQuery(taskListInput, {
    placeholderData: (previousData) => previousData,
  });

  const tasks = useMemo(() => data?.items ?? [], [data]);

  useEffect(() => {
    setSelectedTaskIds((prev) => prev.filter((taskId) => tasks.some((task) => task.id === taskId)));
  }, [tasks]);

  const bulkUpdate = trpc.task.bulkUpdate.useMutation({
    onMutate: async () => {
      setActionError(null);
    },
    onSuccess: () => {
      setActionError(null);
      setSelectedTaskIds([]);
      utils.task.list.invalidate();
    },
    onError: (error) => {
      setActionError(error.message || "Unable to apply bulk update.");
    },
  });

  const savePreset = trpc.project.saveFilterPreset.useMutation({
    onSuccess: () => {
      utils.project.filterPresets.invalidate({ projectId });
    },
  });

  const deletePreset = trpc.project.deleteFilterPreset.useMutation({
    onSuccess: () => {
      utils.project.filterPresets.invalidate({ projectId });
    },
  });

  if (isLoading && !data) {
    return (
      <div className="animate-pulse space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-12 rounded"
            style={{ backgroundColor: "var(--color-bg-muted)" }}
          />
        ))}
      </div>
    );
  }

  const sorted = [...tasks].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortField === "dueDate") {
      return (new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()) * dir;
    }
    if (sortField === "title") {
      return a.title.localeCompare(b.title) * dir;
    }
    const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };
    return ((priorityOrder[a.priority] ?? 0) - (priorityOrder[b.priority] ?? 0)) * dir;
  });

  function handleSort(field: typeof sortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sortIcon = (field: string) =>
    sortField === field ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const visibleTaskIds = sorted.map((task) => task.id);
  const allVisibleSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((taskId) => selectedTaskIds.includes(taskId));

  function toggleTaskSelection(taskId: string) {
    setSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  }

  function toggleVisibleSelection() {
    setSelectedTaskIds((prev) => {
      if (allVisibleSelected) {
        return prev.filter((taskId) => !visibleTaskIds.includes(taskId));
      }

      return [...new Set([...prev, ...visibleTaskIds])];
    });
  }

  function applyBulkUpdate(input: {
    statusId?: string;
    assigneeId?: string | null;
    addTagIds?: string[];
    removeTagIds?: string[];
    archive?: boolean;
  }) {
    if (selectedTaskIds.length === 0) {
      return;
    }

    bulkUpdate.mutate({
      projectId,
      taskIds: selectedTaskIds,
      ...input,
    });
  }

  return (
    <div className="flex flex-col">
      <TaskViewFilters
        search={filters.search}
        selectedTagIds={filters.selectedTagIds}
        selectedAssigneeIds={filters.selectedAssigneeIds}
        dueDateFrom={filters.dueDateFrom}
        dueDateTo={filters.dueDateTo}
        closedAtFrom={filters.closedAtFrom}
        closedAtTo={filters.closedAtTo}
        tags={tags}
        assignees={people ?? []}
        onSearchChange={filters.setSearch}
        onToggleTag={filters.toggleTag}
        onToggleAssignee={filters.toggleAssignee}
        onDateFilterChange={(key, value) => {
          if (key === "dueDateFrom") filters.setDueDateFrom(value);
          if (key === "dueDateTo") filters.setDueDateTo(value);
          if (key === "closedAtFrom") filters.setClosedAtFrom(value);
          if (key === "closedAtTo") filters.setClosedAtTo(value);
        }}
        onApplyQuickDateFilter={filters.applyQuickDateFilter}
        onClear={filters.clearFilters}
        presets={presets as TaskFilterPreset[]}
        onApplyPreset={filters.applyPreset}
        onSavePreset={(name) => {
          savePreset.mutate({
            projectId,
            preset: filters.buildPreset(name),
          });
        }}
        onDeletePreset={(presetId) => deletePreset.mutate({ projectId, presetId })}
        className="mx-4 mt-4"
      />

      <BulkActionBar
        selectedCount={selectedTaskIds.length}
        statuses={statuses}
        tags={tags}
        assignees={people ?? []}
        isPending={bulkUpdate.isPending}
        allVisibleSelected={allVisibleSelected}
        onSelectAllVisible={toggleVisibleSelection}
        onClearSelection={() => setSelectedTaskIds([])}
        onApplyStatus={(statusId) => applyBulkUpdate({ statusId })}
        onApplyAssignee={(assigneeId) => applyBulkUpdate({ assigneeId })}
        onAddTag={(tagId) => applyBulkUpdate({ addTagIds: [tagId] })}
        onRemoveTag={(tagId) => applyBulkUpdate({ removeTagIds: [tagId] })}
        onArchive={() => applyBulkUpdate({ archive: true })}
      />

      {selectedTaskIds.length > 0 && (
        <div className="mx-4 mt-3 flex justify-end">
          <AiChatLauncher
            projectId={projectId}
            selectedTaskIds={selectedTaskIds}
            title={`AI chat for ${selectedTaskIds.length} selected task${selectedTaskIds.length === 1 ? "" : "s"}`}
            buttonLabel={`AI on ${selectedTaskIds.length} selected`}
          />
        </div>
      )}

      {actionError && (
        <div
          className="mx-4 mt-3 rounded-lg border px-3 py-2 text-sm"
          style={{
            backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
            borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))",
            color: "var(--color-danger)",
          }}
        >
          {actionError}
        </div>
      )}

      <div className="flex-1 overflow-x-auto p-4 pt-3">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="border-b text-left text-xs font-medium uppercase"
              style={{
                backgroundColor: "var(--color-bg-muted)",
                borderColor: "var(--color-border)",
                color: "var(--color-text-muted)",
              }}
            >
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleVisibleSelection}
                  aria-label="Select all visible tasks"
                />
              </th>
              <th
                className="cursor-pointer px-4 py-3"
                onClick={() => handleSort("title")}
              >
                Title{sortIcon("title")}
              </th>
              <th className="px-4 py-3">Status</th>
              <th
                className="cursor-pointer px-4 py-3"
                onClick={() => handleSort("priority")}
              >
                Priority{sortIcon("priority")}
              </th>
              <th
                className="cursor-pointer px-4 py-3"
                onClick={() => handleSort("dueDate")}
              >
                Due Date{sortIcon("dueDate")}
              </th>
              <th className="px-4 py-3">Assignee</th>
              <th className="px-4 py-3">Tags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((task) => {
              const alertLevel = getAlertLevel(
                task.dueDate,
                (task.status as { category?: string }).category,
                (task as { alertAcknowledged?: boolean }).alertAcknowledged ?? false,
                alertConfig
              );
              return (
              <tr
                key={task.id}
                onClick={() => setSelectedTaskId(task.id)}
                className={cn(
                  "cursor-pointer border-b transition-colors",
                  alertLevel === "critical" && "pulse-critical",
                  alertLevel === "warning" && "pulse-warning"
                )}
                style={{
                  borderColor: "var(--color-border)",
                  backgroundColor:
                    selectedTaskId === task.id
                      ? "var(--color-accent-muted)"
                      : undefined,
                }}
                onMouseEnter={(e) => {
                  if (selectedTaskId !== task.id)
                    e.currentTarget.style.backgroundColor = "var(--color-surface-hover)";
                }}
                onMouseLeave={(e) => {
                  if (selectedTaskId !== task.id)
                    e.currentTarget.style.backgroundColor = "";
                }}
              >
                <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedTaskIds.includes(task.id)}
                    onChange={() => toggleTaskSelection(task.id)}
                    aria-label={`Select ${task.title}`}
                  />
                </td>
                <td className="px-4 py-3 font-medium" style={{ color: "var(--color-text)" }}>
                  {(task as { taskNumber?: number }).taskNumber && (task as { project?: { key: string } }).project?.key && (
                    <span
                      className="mr-2 text-[10px] font-semibold"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {(task as { project?: { key: string } }).project!.key}-{(task as { taskNumber?: number }).taskNumber}
                    </span>
                  )}
                  <div>{task.title}</div>
                  {((task.dependencyState?.blockingTaskCount ?? 0) > 0 || (task.dependencyState?.openChildCount ?? 0) > 0) && (
                    <div className="mt-1 text-xs font-normal" style={{ color: "var(--color-danger)" }}>
                      {(task.dependencyState?.blockingTaskCount ?? 0) > 0 && (
                        <span>
                          Blocked by {task.dependencyState?.blockingTaskCount}
                        </span>
                      )}
                      {(task.dependencyState?.blockingTaskCount ?? 0) > 0 && (task.dependencyState?.openChildCount ?? 0) > 0 && " · "}
                      {(task.dependencyState?.openChildCount ?? 0) > 0 && (
                        <span>
                          {task.dependencyState?.openChildCount} open child{(task.dependencyState?.openChildCount ?? 0) === 1 ? "" : "ren"}
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge name={task.status.name} color={task.status.color} />
                </td>
                <td className="px-4 py-3 capitalize" style={{ color: "var(--color-text-secondary)" }}>
                  {task.priority}
                </td>
                <td className="px-4 py-3" style={{ color: "var(--color-text-secondary)" }}>
                  {new Date(task.dueDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-3" style={{ color: "var(--color-text-secondary)" }}>
                  <div className="flex items-center gap-2">
                    {task.assignee ? (
                      <>
                        <Avatar
                          name={task.assignee.name}
                          email={task.assignee.email}
                          image={task.assignee.image}
                          size="xs"
                        />
                        <span className="truncate">
                          {task.assignee.name?.trim() || task.assignee.email}
                        </span>
                      </>
                    ) : (
                      <span>Unassigned</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    {task.tags.slice(0, 2).map(({ tag }: { tag: { id: string; name: string; color: string } }) => (
                      <span
                        key={tag.id}
                        className="rounded px-1.5 py-0.5 text-xs"
                        style={{
                          backgroundColor: `${tag.color}20`,
                          color: tag.color,
                        }}
                      >
                        {tag.name}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {tasks.length === 0 && (
          <p
            className="p-8 text-center"
            style={{ color: "var(--color-text-muted)" }}
          >
            No tasks yet. Create one!
          </p>
        )}
      </div>

      {selectedTaskId && (
        <TaskDetail
          taskId={selectedTaskId}
          statuses={statuses}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
