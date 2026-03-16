"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { BulkActionBar } from "./bulk-action-bar";
import { TaskCard } from "./task-card";
import { TaskDetail } from "./task-detail";
import { TaskViewFilters } from "./task-view-filters";
import { getAlertConfig, getAlertLevel } from "@/lib/alert-utils";
import type { BoardStatus, TaskCardData, TaskFilterTagOption } from "@/lib/types";

interface BoardViewProps {
  projectId: string;
  statuses: BoardStatus[];
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

interface DragPreviewState {
  x: number;
  y: number;
  width: number;
}

interface PointerDragState {
  pointerId: number;
  taskId: string;
  sourceStatusId: string;
  originX: number;
  originY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  didDrag: boolean;
  element: HTMLDivElement;
}

const DRAG_START_DISTANCE = 6;

function getDropStatusIdFromPoint(clientX: number, clientY: number): string | null {
  const target = document.elementFromPoint(clientX, clientY);
  if (!(target instanceof HTMLElement)) return null;

  const dropZone = target.closest<HTMLElement>("[data-board-status-id]");
  return dropZone?.dataset.boardStatusId ?? null;
}

/** Kanban board view — columns per status with drag-and-drop */
export function BoardView({ projectId, statuses, tags, projectSettings }: BoardViewProps) {
  const alertConfig = getAlertConfig(projectSettings);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragOverStatusId, setDragOverStatusId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<string[]>([]);
  const dragStateRef = useRef<PointerDragState | null>(null);
  const suppressClickRef = useRef(false);
  const utils = trpc.useUtils();
  const { data: people } = trpc.project.people.useQuery({ projectId });
  const { data: presets = [] } = trpc.project.filterPresets.useQuery({ projectId });

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [search]);

  const taskListInput = useMemo(
    () => ({
      projectId,
      limit: 100,
      search: debouncedSearch.trim() || undefined,
      tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
      assigneeIds: selectedAssigneeIds.length > 0 ? selectedAssigneeIds : undefined,
    }),
    [projectId, debouncedSearch, selectedTagIds, selectedAssigneeIds]
  );

  const { data, isLoading } = trpc.task.list.useQuery(taskListInput, {
    placeholderData: (previousData) => previousData,
  });

  const tasks = useMemo(() => (data?.items ?? []) as TaskCardData[], [data]);

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

  const updateTask = trpc.task.update.useMutation({
    onMutate: async (variables) => {
      setActionError(null);
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await utils.task.list.cancel(taskListInput);
      // Snapshot previous data
      const prev = utils.task.list.getData(taskListInput);
      // Optimistically update the status
      if (variables.statusId && prev) {
        const newStatus = statuses.find((s) => s.id === variables.statusId);
        utils.task.list.setData(taskListInput, {
          ...prev,
          items: prev.items.map((t) =>
            t.id === variables.id
              ? { ...t, statusId: variables.statusId!, status: newStatus ? { ...t.status, id: newStatus.id, name: newStatus.name, color: newStatus.color } : t.status }
              : t
          ),
        });
      }
      return { prev };
    },
    onError: (error, _variables, context) => {
      // Roll back on error
      if (context?.prev) {
        utils.task.list.setData(taskListInput, context.prev);
      }
      setActionError(error.message || "Unable to move task.");
    },
    onSettled: () => {
      utils.task.list.invalidate();
    },
  });

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  }

  function clearFilters() {
    setSearch("");
    setSelectedTagIds([]);
    setSelectedAssigneeIds([]);
  }

  function toggleAssignee(assigneeId: string) {
    setSelectedAssigneeIds((prev) =>
      prev.includes(assigneeId)
        ? prev.filter((id) => id !== assigneeId)
        : [...prev, assigneeId]
    );
  }

  if (isLoading && !data) {
    return (
      <div className="flex gap-4 overflow-x-auto p-4">
        {statuses.map((s) => (
          <div
            key={s.id}
            className="w-72 shrink-0 animate-pulse rounded-lg p-4"
            style={{ backgroundColor: "var(--color-bg-muted)" }}
          >
            <div
              className="h-5 w-20 rounded"
              style={{ backgroundColor: "var(--color-border)" }}
            />
          </div>
        ))}
      </div>
    );
  }

  const draggedTask = draggingTaskId
    ? tasks.find((task) => task.id === draggingTaskId) ?? null
    : null;

  const visibleTaskIds = tasks.map((task) => task.id);
  const allVisibleSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((taskId) => selectedTaskIds.includes(taskId));

  function releasePointerCapture(dragState: PointerDragState | null) {
    if (!dragState) return;

    if (dragState.element.hasPointerCapture(dragState.pointerId)) {
      dragState.element.releasePointerCapture(dragState.pointerId);
    }
  }

  function clearDragState(preserveClickSuppression = false) {
    releasePointerCapture(dragStateRef.current);
    dragStateRef.current = null;
    setDraggingTaskId(null);
    setDragOverStatusId(null);
    setDragPreview(null);

    if (!preserveClickSuppression) {
      suppressClickRef.current = false;
    }
  }

  function resetClickSuppression() {
    requestAnimationFrame(() => {
      suppressClickRef.current = false;
    });
  }

  function handlePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    taskId: string,
    statusId: string
  ) {
    if (e.button !== 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: e.pointerId,
      taskId,
      sourceStatusId: statusId,
      originX: e.clientX,
      originY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      didDrag: false,
      element: e.currentTarget,
    };
    suppressClickRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;

    const dragDistance = Math.hypot(
      e.clientX - dragState.originX,
      e.clientY - dragState.originY
    );

    if (!dragState.didDrag) {
      if (dragDistance < DRAG_START_DISTANCE) return;

      dragState.didDrag = true;
      suppressClickRef.current = true;
      setDraggingTaskId(dragState.taskId);
    }

    setDragPreview({
      x: e.clientX - dragState.offsetX,
      y: e.clientY - dragState.offsetY,
      width: dragState.width,
    });
    setDragOverStatusId(getDropStatusIdFromPoint(e.clientX, e.clientY));
    e.preventDefault();
  }

  function finishPointerDrag(clientX: number, clientY: number) {
    const dragState = dragStateRef.current;
    if (!dragState) return;

    const targetStatusId = dragState.didDrag
      ? getDropStatusIdFromPoint(clientX, clientY)
      : null;
    const shouldMoveTask =
      dragState.didDrag &&
      !!targetStatusId &&
      targetStatusId !== dragState.sourceStatusId;

    clearDragState(dragState.didDrag);

    if (shouldMoveTask && targetStatusId) {
      updateTask.mutate({
        id: dragState.taskId,
        statusId: targetStatusId,
      });
    }

    if (dragState.didDrag) {
      resetClickSuppression();
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    finishPointerDrag(e.clientX, e.clientY);
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;

    const didDrag = dragState.didDrag;
    clearDragState(didDrag);
    if (didDrag) {
      resetClickSuppression();
    }
  }

  function handleLostPointerCapture(e: React.PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;

    const didDrag = dragState.didDrag;
    clearDragState(didDrag);
    if (didDrag) {
      resetClickSuppression();
    }
  }

  function handleTaskClick(taskId: string) {
    if (suppressClickRef.current) return;
    setSelectedTaskId(taskId);
  }

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
        search={search}
        selectedTagIds={selectedTagIds}
        selectedAssigneeIds={selectedAssigneeIds}
        tags={tags}
        assignees={people ?? []}
        onSearchChange={setSearch}
        onToggleTag={toggleTag}
        onToggleAssignee={toggleAssignee}
        onClear={clearFilters}
        presets={presets as Array<{ id: string; name: string; search: string; tagIds: string[]; assigneeIds: string[] }>}
        onApplyPreset={(preset) => {
          setSearch(preset.search);
          setSelectedTagIds(preset.tagIds);
          setSelectedAssigneeIds(preset.assigneeIds);
        }}
        onSavePreset={(name) => {
          savePreset.mutate({
            projectId,
            preset: {
              id: crypto.randomUUID(),
              name,
              search,
              tagIds: selectedTagIds,
              assigneeIds: selectedAssigneeIds,
            },
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

      <div className="flex flex-1 gap-4 overflow-x-auto p-4">
        {statuses.map((status) => {
          const columnTasks = tasks.filter(
            (t) => t.statusId === status.id
          );
          const isOver = dragOverStatusId === status.id;

          return (
            <div
              key={status.id}
              data-board-column
              data-board-status-id={status.id}
              data-board-status-name={status.name}
              className="w-72 shrink-0 rounded-lg p-3"
              style={{
                backgroundColor: isOver
                  ? "var(--color-surface-hover)"
                  : "var(--color-bg-muted)",
                border: `2px ${isOver ? "dashed" : "solid"} ${isOver ? status.color : "transparent"}`,
                outline: isOver
                  ? "none"
                  : "1px solid var(--color-border-muted)",
                transition: "background-color 150ms, border-color 150ms",
              }}
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: status.color }}
                  />
                  <h3
                    className="text-sm font-semibold"
                    style={{ color: "var(--color-text)" }}
                  >
                    {status.name}
                  </h3>
                </div>
                <span
                  className="rounded-full px-2 py-0.5 text-xs"
                  style={{
                    backgroundColor: "var(--color-surface-active)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {columnTasks.length}
                </span>
              </div>

              <div className="space-y-2" style={{ minHeight: "48px" }}>
                {columnTasks.map((task) => (
                  <div
                    key={task.id}
                    data-board-task-id={task.id}
                    className="select-none"
                    onClick={() => handleTaskClick(task.id)}
                    onPointerDown={(e) => handlePointerDown(e, task.id, status.id)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    onLostPointerCapture={handleLostPointerCapture}
                    style={{
                      opacity: draggingTaskId === task.id ? 0.35 : 1,
                      cursor: draggingTaskId === task.id ? "grabbing" : "grab",
                      transition: "opacity 150ms",
                      touchAction: "none",
                    }}
                  >
                    <TaskCard
                      task={task}
                      className={selectedTaskIds.includes(task.id) ? "ring-2 ring-[var(--color-accent)]" : undefined}
                      leadingContent={
                        <input
                          type="checkbox"
                          checked={selectedTaskIds.includes(task.id)}
                          onChange={() => toggleTaskSelection(task.id)}
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                          aria-label={`Select ${task.title}`}
                          className="mt-0.5 shrink-0"
                        />
                      }
                      alertLevel={getAlertLevel(
                        task.dueDate,
                        (task.status as { category?: string }).category,
                        (task as { alertAcknowledged?: boolean }).alertAcknowledged ?? false,
                        alertConfig
                      )}
                    />
                  </div>
                ))}
                {columnTasks.length === 0 && draggingTaskId && (
                  <div
                    className="flex h-12 items-center justify-center rounded-lg border-2 border-dashed text-xs"
                    style={{
                      borderColor: "var(--color-border)",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    Drop here
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selectedTaskId && (
        <TaskDetail
          taskId={selectedTaskId}
          statuses={statuses}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {draggedTask && dragPreview && (
        <div
          className="pointer-events-none fixed z-50"
          style={{
            left: dragPreview.x,
            top: dragPreview.y,
            width: dragPreview.width,
            transform: "rotate(2deg)",
          }}
        >
          <TaskCard
            task={draggedTask}
            className="shadow-lg"
            alertLevel={getAlertLevel(
              draggedTask.dueDate,
              draggedTask.status.category,
              draggedTask.alertAcknowledged ?? false,
              alertConfig
            )}
          />
        </div>
      )}
    </div>
  );
}
