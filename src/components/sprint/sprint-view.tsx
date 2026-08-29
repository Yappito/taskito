"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { TaskDetail } from "@/components/task/task-detail";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { trpc } from "@/lib/trpc-client";
import type { StatusCategory, TaskCardData, TaskFilterTagOption } from "@/lib/types";

interface SprintViewProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string; category?: string }>;
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
  pointerType: string;
  /** Touch drags only start after a long-press so vertical page scroll keeps working */
  longPressed: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  touchMoveBlocker: ((event: TouchEvent) => void) | null;
}

const DRAG_START_DISTANCE = 6;
const LONG_PRESS_START_MS = 250;

function getSprintDropStatusIdFromPoint(clientX: number, clientY: number): string | null {
  const target = document.elementFromPoint(clientX, clientY);
  if (!(target instanceof HTMLElement)) return null;

  const dropZone = target.closest<HTMLElement>("[data-sprint-status-id]");
  return dropZone?.dataset.sprintStatusId ?? null;
}

function defaultEndDate() {
  const date = new Date();
  date.setDate(date.getDate() + 13);
  return date.toISOString().split("T")[0];
}

interface SprintSummaryData {
  committedCount: number;
  completedCount: number;
  carriedOverCount: number;
  completedTaskIds?: string[];
}

function parseSprintSummary(summary: unknown): SprintSummaryData | null {
  if (!summary || typeof summary !== "object") return null;
  const value = summary as Record<string, unknown>;
  if (typeof value.committedCount !== "number" || typeof value.completedCount !== "number" || typeof value.carriedOverCount !== "number") {
    return null;
  }
  return {
    committedCount: value.committedCount,
    completedCount: value.completedCount,
    carriedOverCount: value.carriedOverCount,
  };
}

export function SprintView({ projectId, statuses }: SprintViewProps) {
  const utils = trpc.useUtils();
  const { data: sprints = [] } = trpc.sprint.list.useQuery({ projectId });
  const { data: people = [] } = trpc.project.people.useQuery({ projectId });
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<string[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageMembersOpen, setManageMembersOpen] = useState(false);
  const [completeDialogOpen, setCompleteDialogOpen] = useState(false);
  const [carryOverTarget, setCarryOverTarget] = useState("backlog");
  const [sprintActionError, setSprintActionError] = useState<string | null>(null);
  const [createdSprintName, setCreatedSprintName] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberSelection, setMemberSelection] = useState<string[]>([]);
  const [collapsedSprints, setCollapsedSprints] = useState<Record<string, boolean>>({});
  const [dragOverStatusId, setDragOverStatusId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const dragStateRef = useRef<PointerDragState | null>(null);
  const suppressClickRef = useRef(false);
  const sprintId = selectedSprintId ?? sprints.find((sprint) => sprint.status === "active")?.id ?? sprints[0]?.id ?? null;
  const selectedSprint = sprints.find((sprint) => sprint.id === sprintId);
  const taskListInput = useMemo(
    () => ({
      projectId,
      sprintId,
      includeArchived: false,
      limit: 100,
      ...(selectedAssigneeIds.length > 0 ? { assigneeIds: selectedAssigneeIds } : {}),
    }),
    [projectId, selectedAssigneeIds, sprintId]
  );
  const { data: tasks } = trpc.task.list.useQuery(taskListInput, { enabled: !!sprintId });
  const sprintTasks = useMemo(() => (tasks?.items ?? []) as unknown as TaskCardData[], [tasks?.items]);
  const sprintSummary = parseSprintSummary(selectedSprint?.summary);
  const carryOverSprints = sprints.filter(
    (sprint) => sprint.id !== sprintId && sprint.status !== "completed"
  );
  const hasPlannedSprint = carryOverSprints.some((sprint) => sprint.status === "planning");
  const createSprint = trpc.sprint.create.useMutation({
    onSuccess: async (createdSprint) => {
      setCreateError(null);
      setCreateOpen(false);
      setCreatedSprintName(createdSprint.name);
      setSelectedSprintId(createdSprint.id);
      await utils.sprint.list.invalidate({ projectId });
    },
    onError: (error) => {
      setCreateError(error.message || "Unable to create sprint.");
    },
  });
  const startSprint = trpc.sprint.start.useMutation({
    onSuccess: async () => {
      setSprintActionError(null);
      await utils.sprint.list.invalidate({ projectId });
    },
    onError: (error) => {
      setSprintActionError(error.message || "Unable to start sprint.");
    },
  });
  const completeSprint = trpc.sprint.complete.useMutation({
    onSuccess: async () => {
      setSprintActionError(null);
      setCompleteDialogOpen(false);
      await utils.sprint.list.invalidate({ projectId });
    },
    onError: (error) => {
      setCompleteError(error.message || "Unable to complete sprint.");
    },
  });
  const assignSprintMembers = trpc.sprint.assignMembers.useMutation({
    onSuccess: async () => {
      setMemberError(null);
      setManageMembersOpen(false);
      await utils.sprint.list.invalidate({ projectId });
    },
    onError: (error) => {
      setMemberError(error.message || "Unable to save sprint members.");
    },
  });
  const updateTask = trpc.task.update.useMutation({
    onMutate: async (variables) => {
      await utils.task.list.cancel(taskListInput);
      const previous = utils.task.list.getData(taskListInput);

      if (variables.statusId && previous) {
        const nextStatus = statuses.find((status) => status.id === variables.statusId);
        const nextItems = (previous.items as unknown as TaskCardData[]).map((task) =>
          task.id === variables.id
            ? {
                ...task,
                statusId: variables.statusId ?? task.statusId,
                status: nextStatus
                  ? {
                      ...task.status,
                      id: nextStatus.id,
                      name: nextStatus.name,
                      color: nextStatus.color,
                      ...(nextStatus.category ? { category: nextStatus.category as StatusCategory } : {}),
                    }
                  : task.status,
              }
            : task
        );

        utils.task.list.setData(taskListInput, {
          ...previous,
          items: nextItems as unknown as typeof previous.items,
        });
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        utils.task.list.setData(taskListInput, context.previous);
      }
    },
    onSettled: () => {
      utils.task.list.invalidate(taskListInput);
    },
  });
  const groupedTasks = useMemo(() => {
    const groups = new Map(statuses.map((status) => [status.id, { status, tasks: [] as TaskCardData[] }]));
    for (const task of sprintTasks) {
      const group = groups.get(task.statusId);
      if (group) group.tasks.push(task);
    }
    return [...groups.values()];
  }, [sprintTasks, statuses]);
  const draggedTask = draggingTaskId ? sprintTasks.find((task) => task.id === draggingTaskId) ?? null : null;
  const sprintAssigneeOptions = useMemo(() => {
    const sprintMemberIds = new Set(selectedSprint?.members.map((member) => member.userId) ?? []);
    const assignedPeople = new Map(people.map((person) => [person.id, person]));

    const options = people.filter((person) =>
      sprintMemberIds.size === 0 || sprintMemberIds.has(person.id)
    );

    for (const task of sprintTasks) {
      if (task.assigneeId && assignedPeople.has(task.assigneeId)) {
        const person = assignedPeople.get(task.assigneeId)!;
        if (!options.some((option) => option.id === person.id)) {
          options.push(person);
        }
      }
    }

    return options;
  }, [people, selectedSprint, sprintTasks]);
  const isCompletedSprintCollapsed = selectedSprint
    ? (collapsedSprints[selectedSprint.id] ?? (selectedSprint.status === "completed"))
    : false;

  useEffect(() => {
    if (!selectedSprint || selectedSprint.status !== "completed") {
      return;
    }

    setCollapsedSprints((current) => (
      current[selectedSprint.id] !== undefined
        ? current
        : { ...current, [selectedSprint.id]: true }
    ));
  }, [selectedSprint]);

  useEffect(() => {
    setMemberSelection(selectedSprint?.members.map((member) => member.userId) ?? []);
  }, [selectedSprint]);

  useEffect(() => {
    setSelectedAssigneeIds([]);
  }, [selectedSprint?.id]);

  function toggleAssigneeFilter(assigneeId: string) {
    setSelectedAssigneeIds((current) =>
      current.includes(assigneeId)
        ? current.filter((id) => id !== assigneeId)
        : [...current, assigneeId]
    );
  }

  function releasePointerCapture(dragState: PointerDragState | null) {
    if (!dragState) return;

    if (dragState.element.hasPointerCapture(dragState.pointerId)) {
      dragState.element.releasePointerCapture(dragState.pointerId);
    }
  }

  function clearDragState(preserveClickSuppression = false) {
    const dragState = dragStateRef.current;
    releasePointerCapture(dragState);
    if (dragState?.longPressTimer) {
      clearTimeout(dragState.longPressTimer);
    }
    if (dragState?.touchMoveBlocker) {
      dragState.element.removeEventListener("touchmove", dragState.touchMoveBlocker);
    }
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

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>, taskId: string, statusId: string) {
    if (e.button !== 0) return;

    const element = e.currentTarget;
    const rect = element.getBoundingClientRect();
    const isTouch = e.pointerType === "touch";
    const dragState: PointerDragState = {
      pointerId: e.pointerId,
      taskId,
      sourceStatusId: statusId,
      originX: e.clientX,
      originY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      didDrag: false,
      element,
      pointerType: e.pointerType,
      longPressed: false,
      longPressTimer: null,
      touchMoveBlocker: null,
    };

    if (isTouch) {
      // Keep vertical page scroll available (touch-action: pan-y); a drag only
      // starts after a ~250ms long-press. The non-passive blocker stops the
      // browser from hijacking the gesture into a scroll once dragging begins.
      dragState.touchMoveBlocker = (event: TouchEvent) => {
        if (dragStateRef.current === dragState && dragState.longPressed) {
          event.preventDefault();
        }
      };
      element.addEventListener("touchmove", dragState.touchMoveBlocker, { passive: false });
      dragState.longPressTimer = setTimeout(() => {
        if (dragStateRef.current !== dragState || dragState.didDrag) return;
        dragState.longPressed = true;
        if (!element.hasPointerCapture(dragState.pointerId)) {
          element.setPointerCapture(dragState.pointerId);
        }
      }, LONG_PRESS_START_MS);
    }

    dragStateRef.current = dragState;
    suppressClickRef.current = false;
    element.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    // Touch drags wait for the long-press; otherwise the browser handles scrolling
    if (dragState.pointerType === "touch" && !dragState.longPressed) return;

    const dragDistance = Math.hypot(e.clientX - dragState.originX, e.clientY - dragState.originY);
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
    setDragOverStatusId(getSprintDropStatusIdFromPoint(e.clientX, e.clientY));
    e.preventDefault();
  }

  function finishPointerDrag(clientX: number, clientY: number) {
    const dragState = dragStateRef.current;
    if (!dragState) return;

    const targetStatusId = dragState.didDrag ? getSprintDropStatusIdFromPoint(clientX, clientY) : null;
    const shouldMoveTask = dragState.didDrag && !!targetStatusId && targetStatusId !== dragState.sourceStatusId;

    clearDragState(dragState.didDrag);

    if (shouldMoveTask && targetStatusId) {
      updateTask.mutate({ id: dragState.taskId, statusId: targetStatusId });
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

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createSprint.mutate({
      projectId,
      name: String(form.get("name") || "Sprint"),
      goal: String(form.get("goal") || "") || null,
      startDate: new Date(String(form.get("startDate"))),
      endDate: new Date(String(form.get("endDate"))),
      memberIds: form.getAll("memberIds").map((value) => String(value)),
      status: "planning",
    });
  }

  function handleManageMembers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSprint) {
      return;
    }

    assignSprintMembers.mutate({ id: selectedSprint.id, memberIds: memberSelection });
  }

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold" style={{ color: "var(--color-text)" }}>Sprints</h2>
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>Plan time-boxed cycles, monitor scope, and inspect sprint work by status.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button type="button" onClick={() => setCreateOpen(true)}>Create Sprint</Button>
          {selectedSprint && (
            <Button type="button" variant="outline" onClick={() => setManageMembersOpen(true)}>
              Assign sprint members
            </Button>
          )}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
              Select Sprint
            </label>
            <Select
              aria-label="Select Sprint"
              value={sprintId ?? ""}
              onChange={(event) => setSelectedSprintId(event.target.value || null)}
              className="min-w-56 rounded-xl"
            >
              <option value="">Select sprint...</option>
              {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name} ({sprint.status})</option>)}
            </Select>
          </div>
          {createdSprintName && (
            <div
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm"
              style={{ borderColor: "var(--color-success)", backgroundColor: "var(--color-success-muted)", color: "var(--color-success)" }}
            >
              <span>Sprint “{createdSprintName}” created.</span>
              <button
                type="button"
                onClick={() => setCreatedSprintName(null)}
                className="text-xs font-semibold"
                aria-label="Dismiss sprint created acknowledgement"
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--color-text)" }}>Create Sprint</h2>
        <form onSubmit={handleCreate} className="space-y-3">
          {createError && (
            <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))", backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)", color: "var(--color-danger)" }}>
              {createError}
            </div>
          )}
          <input name="name" required placeholder="Sprint name" className="h-10 w-full rounded-xl border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }} />
          <input name="goal" placeholder="Sprint goal" className="h-10 w-full rounded-xl border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }} />
          <div className="grid grid-cols-2 gap-3">
            <input name="startDate" type="date" required defaultValue={new Date().toISOString().split("T")[0]} className="h-10 rounded-xl border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }} />
            <input name="endDate" type="date" required min={new Date().toISOString().split("T")[0]} defaultValue={defaultEndDate()} className="h-10 rounded-xl border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }} />
          </div>
          <div>
            <div className="mb-2 text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Sprint members</div>
            <div className="max-h-48 space-y-2 overflow-y-auto rounded-2xl border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
              {people.map((person) => (
                <label key={person.id} className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
                  <input type="checkbox" name="memberIds" value={person.id} className="rounded" />
                  <Avatar name={person.name} email={person.email} image={person.image} size="xs" />
                  <span>{person.name?.trim() || person.email}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createSprint.isPending}>{createSprint.isPending ? "Creating..." : "Create Sprint"}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={manageMembersOpen} onClose={() => setManageMembersOpen(false)}>
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--color-text)" }}>Assign sprint members</h2>
        <form onSubmit={handleManageMembers} className="space-y-3">
          {memberError && (
            <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))", backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)", color: "var(--color-danger)" }}>
              {memberError}
            </div>
          )}
          <div>
            <div className="mb-2 text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Sprint team</div>
            <div className="max-h-72 space-y-2 overflow-y-auto rounded-2xl border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
              {people.length > 0 ? people.map((person) => {
                const checked = memberSelection.includes(person.id);
                return (
                  <label key={person.id} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: checked ? "var(--color-accent)" : "var(--color-border)", color: "var(--color-text-secondary)", backgroundColor: checked ? "var(--color-accent-muted)" : "var(--color-surface)" }}>
                    <input
                      type="checkbox"
                      name="assignedMemberIds"
                      checked={checked}
                      onChange={() => setMemberSelection((current) => current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id])}
                    />
                    <Avatar name={person.name} email={person.email} image={person.image} size="xs" />
                    <span>{person.name?.trim() || person.email}</span>
                  </label>
                );
              }) : (
                <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No project members available to assign.</p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setManageMembersOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={assignSprintMembers.isPending || !selectedSprint}>
              {assignSprintMembers.isPending ? "Saving..." : "Save sprint members"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={completeDialogOpen}
        onClose={() => setCompleteDialogOpen(false)}
        title="Complete sprint"
        description="Move unfinished work out of the sprint, then mark it completed."
        panelClassName="max-w-md"
      >
        {selectedSprint && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!selectedSprint) return;
              const target = carryOverTarget === "" ? (hasPlannedSprint ? "next" : "backlog") : carryOverTarget;
              completeSprint.mutate({ id: selectedSprint.id, carryOverTo: target });
            }}
            className="space-y-3"
          >
            {completeError && (
              <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))", backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)", color: "var(--color-danger)" }}>
                {completeError}
              </div>
            )}
            <Field
              label="Carry over unfinished work to"
              hint="Tasks that are not done or cancelled move to the chosen target.">
              {(ids) => (
                <Select
                  id={ids.id}
                  value={carryOverTarget}
                  onChange={(event) => setCarryOverTarget(event.target.value)}
                >
                  <option value="backlog">Backlog (no sprint)</option>
                  {hasPlannedSprint && (
                    <option value="next">Next planned sprint</option>
                  )}
                  {carryOverSprints.map((sprint) => (
                    <option key={sprint.id} value={sprint.id}>{sprint.name} ({sprint.status})</option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCompleteDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={completeSprint.isPending}>
                {completeSprint.isPending ? "Completing..." : "Complete sprint"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      {selectedSprint ? (
        <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>{selectedSprint.name}</h3>
              <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>{selectedSprint.goal || "No sprint goal set."}</p>
              <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>{new Date(selectedSprint.startDate).toLocaleDateString()} – {new Date(selectedSprint.endDate).toLocaleDateString()} · {selectedSprint._count.tasks} tasks</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Sprint team</span>
                {selectedSprint.members.length > 0 ? selectedSprint.members.map((member) => (
                  <span key={member.userId} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)", backgroundColor: "var(--color-bg-overlay)" }}>
                    <Avatar name={member.user.name} email={member.user.email} image={member.user.image} size="xs" />
                    <span>{member.user.name?.trim() || member.user.email}</span>
                  </span>
                )) : (
                  <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>No sprint members yet.</span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Filter assignees</span>
                {sprintAssigneeOptions.length > 0 ? sprintAssigneeOptions.map((person) => {
                  const active = selectedAssigneeIds.includes(person.id);
                  return (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => toggleAssigneeFilter(person.id)}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors"
                      style={{
                        borderColor: active ? "var(--color-accent)" : "var(--color-border)",
                        backgroundColor: active ? "var(--color-accent-muted)" : "var(--color-bg-overlay)",
                        color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                      }}
                    >
                      <Avatar name={person.name} email={person.email} image={person.image} size="xs" />
                      <span>{person.name?.trim() || person.email}</span>
                    </button>
                  );
                }) : (
                  <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>No assignees available for this sprint.</span>
                )}
                {selectedAssigneeIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedAssigneeIds([])}
                    className="rounded-full border px-2 py-1 text-xs transition-colors"
                    style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)", backgroundColor: "var(--color-surface)" }}
                  >
                    Clear filter
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {selectedSprint.status === "completed" && sprintSummary && (
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  <span className="rounded-full border px-2 py-1" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
                    {sprintSummary.completedCount}/{sprintSummary.committedCount} completed
                  </span>
                  <span className="rounded-full border px-2 py-1" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
                    {sprintSummary.carriedOverCount} carried over
                  </span>
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={startSprint.isPending || completeSprint.isPending || selectedSprint.status === "active" || selectedSprint.status === "completed"}
                onClick={() => startSprint.mutate({ id: selectedSprint.id })}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={completeSprint.isPending || selectedSprint.status === "completed"}
                onClick={() => {
                  setCompleteError(null);
                  setSprintActionError(null);
                  setCarryOverTarget(hasPlannedSprint ? "next" : "backlog");
                  setCompleteDialogOpen(true);
                }}
              >
                Complete
              </Button>
              {selectedSprint.status === "completed" && !isCompletedSprintCollapsed && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCollapsedSprints((current) => ({
                    ...current,
                    [selectedSprint.id]: !(current[selectedSprint.id] ?? true),
                  }))}
                >
                  Minimize sprint
                </Button>
              )}
            </div>
          </div>
          {sprintActionError && (
            <div
              role="alert"
              className="mt-4 rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))", backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)", color: "var(--color-danger)" }}
            >
              {sprintActionError}
            </div>
          )}
          {isCompletedSprintCollapsed ? (
            <div
              className="mt-4 rounded-2xl border p-4"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                    {selectedSprint.name} is completed
                  </p>
                  <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    {selectedSprint._count.tasks} sprint task{selectedSprint._count.tasks === 1 ? "" : "s"} · {selectedSprint.members.length} member{selectedSprint.members.length === 1 ? "" : "s"} · completed {new Date(selectedSprint.endDate).toLocaleDateString()}
                    {sprintSummary
                      ? ` · ${sprintSummary.completedCount}/${sprintSummary.committedCount} completed · ${sprintSummary.carriedOverCount} carried over`
                      : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCollapsedSprints((current) => ({ ...current, [selectedSprint.id]: false }))}
                >
                  Expand sprint
                </Button>
              </div>
            </div>
          ) : (
          <div className="mt-4 flex gap-5 overflow-x-auto pb-1">
            {groupedTasks.map((group) => (
              <div
                key={group.status.id}
                data-sprint-status-id={group.status.id}
                className="w-80 shrink-0 rounded-3xl p-3.5"
                style={{
                  backgroundColor: dragOverStatusId === group.status.id
                    ? "color-mix(in srgb, var(--color-accent) 10%, var(--color-surface))"
                    : "color-mix(in srgb, var(--color-bg-muted) 78%, var(--color-surface))",
                  border: `1px ${dragOverStatusId === group.status.id ? "dashed" : "solid"} ${dragOverStatusId === group.status.id ? group.status.color : "var(--color-border)"}`,
                  outline: dragOverStatusId === group.status.id
                    ? "none"
                    : "1px solid color-mix(in srgb, var(--color-surface) 60%, transparent)",
                  boxShadow: dragOverStatusId === group.status.id ? "var(--shadow-md)" : "var(--shadow-sm)",
                  transition: "background-color 150ms, border-color 150ms, box-shadow 150ms",
                }}
              >
                <div className="mb-3 rounded-2xl border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full shadow-sm" style={{ backgroundColor: group.status.color }} />
                      <h4 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                        {group.status.name}
                      </h4>
                    </div>
                    <span
                      className="rounded-full px-2 py-0.5 text-xs"
                      style={{
                        backgroundColor: "var(--color-surface-active)",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      {group.tasks.length}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: "var(--color-bg-muted)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, Math.max(8, group.tasks.length * 8))}%`,
                        backgroundColor: group.status.color,
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-2" style={{ minHeight: "64px" }}>
                  {group.tasks.map((task) => (
                    <div
                      key={task.id}
                      data-sprint-task-id={task.id}
                      className="select-none w-full rounded-xl border p-3 text-left text-sm"
                      onClick={() => handleTaskClick(task.id)}
                      onPointerDown={(event) => handlePointerDown(event, task.id, group.status.id)}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={handlePointerCancel}
                      onLostPointerCapture={handleLostPointerCapture}
                      style={{
                        borderColor: "var(--color-border)",
                        backgroundColor: "var(--color-surface)",
                        color: "var(--color-text)",
                        opacity: draggingTaskId === task.id ? 0.35 : 1,
                        cursor: draggingTaskId === task.id ? "grabbing" : "grab",
                        transition: "opacity 150ms",
                        touchAction: "pan-y",
                      }}
                    >
                      <button
                        type="button"
                        className="w-full text-left"
                        style={{ color: "var(--color-text)" }}
                      >
                        <div className="font-medium">{task.title}</div>
                        <div className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>Due {new Date(task.dueDate).toLocaleDateString()} · {task.priority}</div>
                        <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                          {task.assignee ? (
                            <>
                              <Avatar name={task.assignee.name} email={task.assignee.email} image={task.assignee.image} size="xs" />
                              <span>{task.assignee.name?.trim() || task.assignee.email}</span>
                            </>
                          ) : (
                            <span>Unassigned</span>
                          )}
                        </div>
                      </button>
                    </div>
                  ))}
                  {group.tasks.length === 0 && draggingTaskId && (
                    <div
                      className="flex h-20 items-center justify-center rounded-2xl border-2 border-dashed text-xs font-medium"
                      style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                    >
                      Drop here
                    </div>
                  )}
                  {group.tasks.length === 0 && (
                    <div
                      className="flex h-24 flex-col items-center justify-center rounded-2xl border border-dashed px-4 text-center text-xs"
                      style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)", backgroundColor: "var(--color-bg-overlay)" }}
                    >
                      <span className="font-medium">No tasks here</span>
                      <span className="mt-1">Assign sprint work to {group.status.name} to populate this lane.</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          )}
        </section>
      ) : (
        <div className="rounded-2xl border p-8 text-center text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>Create a sprint to start planning cycles.</div>
      )}
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} statuses={statuses} onClose={() => setSelectedTaskId(null)} />}
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
          <div className="w-full rounded-xl border p-3 text-left text-sm shadow-lg" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}>
            <div className="font-medium">{draggedTask.title}</div>
            <div className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              Due {new Date(draggedTask.dueDate).toLocaleDateString()} · {draggedTask.priority}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
