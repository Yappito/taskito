"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { useTaskViewFilters } from "@/hooks/use-task-view-filters";
import { TaskCard } from "./task-card";
import { TaskDetail } from "./task-detail";
import { TaskViewFilters } from "./task-view-filters";
import { Button } from "@/components/ui/button";
import type { TaskFilterPreset, TaskFilterTagOption } from "@/lib/types";

interface ArchivedTasksProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string }>;
  tags: TaskFilterTagOption[];
}

/** View for archived tasks with the ability to unarchive */
export function ArchivedTasks({ projectId, statuses, tags }: ArchivedTasksProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const filters = useTaskViewFilters();
  const utils = trpc.useUtils();
  const { data: people } = trpc.project.people.useQuery({ projectId });
  const { data: presets = [] } = trpc.project.filterPresets.useQuery({ projectId });

  const taskListInput = useMemo(
    () => ({
      projectId,
      archivedOnly: true,
      limit: 100,
      ...filters.queryFilters,
    }),
    [projectId, filters.queryFilters]
  );

  const { data, isLoading } = trpc.task.list.useQuery(taskListInput, {
    placeholderData: (previousData) => previousData,
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

  const unarchiveTask = trpc.task.unarchive.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
    },
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-lg"
              style={{ backgroundColor: "var(--color-bg-muted)" }}
            />
          ))}
        </div>
      </div>
    );
  }

  const tasks = data?.items ?? [];

  if (tasks.length === 0) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <div className="text-center">
          <p
            className="text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            No archived tasks
          </p>
          <p
            className="mt-1 text-xs"
            style={{ color: "var(--color-text-muted)" }}
          >
            Tasks in statuses with auto-archive enabled will appear here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex">
      <div className="flex-1 p-4">
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
          helperText="Filter archived work by due date or by when it was actually closed."
          className="mb-4"
        />

        <div className="mb-3 flex items-center justify-between">
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Archived Tasks ({tasks.length})
          </h2>
        </div>
        <div className="space-y-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center gap-2"
            >
              <div className="flex-1">
                <TaskCard
                  task={task}
                  onClick={() => setSelectedTaskId(task.id)}
                  className="opacity-70"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => unarchiveTask.mutate({ id: task.id })}
                disabled={unarchiveTask.isPending}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
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
