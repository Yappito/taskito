"use client";

import Image from "next/image";
import { GripVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { trpc } from "@/lib/trpc-client";
import { getCommentBody } from "@/lib/comment-content";
// CITADEL-d77.17 (markdown + mentions): shared renderer and mention textarea.
import { Markdown } from "@/components/ui/markdown";
import { MentionTextarea } from "@/components/task/mention-textarea";
import {
  DEFAULT_TASK_DETAIL_SECTION_ORDER,
  getTaskDetailSectionOrderStorageKey,
  isTaskDetailSectionId,
  moveTaskDetailSectionOrder,
  normalizeTaskDetailSectionOrder,
  type TaskDetailSectionDropPosition,
  type TaskDetailSectionId,
} from "@/lib/task-detail-section-order";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CustomFieldInputs, type TaskCustomFieldValueMap } from "@/components/task/custom-field-inputs";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "./status-badge";
import { Badge } from "@/components/ui/badge";
import { TaskSearchInput } from "@/components/ui/task-search-input";
import { Avatar } from "@/components/ui/avatar";
import { AiChatLauncher } from "@/components/ai/ai-chat-launcher";
import { TimeTrackingControls } from "@/components/time/time-tracking-controls";
import { RecurrenceControls } from "@/components/recurrence/recurrence-controls";

type ProjectPersonOption = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

type TaskDetailData = {
  id: string;
  projectId: string;
  taskNumber?: number;
  title: string;
  body?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  dueDate: Date | string;
  startDate?: Date | string | null;
  closedAt?: Date | string | null;
  archivedAt?: Date | string | null;
  alertAcknowledged?: boolean;
  statusId: string;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  status: {
    id?: string;
    name: string;
    color: string;
    category?: string | null;
  };
  project?: {
    key: string;
    slug?: string;
  };
  creator?: ProjectPersonOption | null;
  assignee?: ProjectPersonOption | null;
  participants?: Array<{ user: ProjectPersonOption }>;
  sprintId?: string | null;
  sprint?: {
    id: string;
    name: string;
    status: string;
    startDate: Date | string;
    endDate: Date | string;
  } | null;
  recurrenceRule?: {
    frequency: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
    nextDueDate: Date | string;
    endDate?: Date | string | null;
  } | null;
  comments: Array<{
    id: string;
    authorId: string;
    content: string;
    createdAt: Date | string;
    author: { id: string; name: string | null; image?: string | null };
    attachments?: Array<{
      id: string;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      createdAt?: Date | string;
    }>;
  }>;
  tags: Array<{ tag: { id: string; name: string; color: string } }>;
  customFieldValues: Array<{
    id?: string;
    customFieldId: string;
    value: unknown;
    customField?: {
      id: string;
      name: string;
      type: string;
      required?: boolean;
      options?: unknown;
    };
  }>;
  activityEvents?: Array<{
    id: string;
    action: string;
    details?: Record<string, unknown> | null;
    createdAt: Date | string;
    actor?: { name: string | null; email: string } | null;
  }>;
  sourceLinks: Array<{
    id?: string;
    linkType: string;
    targetTask?: {
      id: string;
      taskNumber?: number;
      title: string;
      status?: { category?: string | null; name?: string | null } | null;
      project?: { key: string } | null;
    } | null;
  }>;
  targetLinks: Array<{
    id?: string;
    linkType: string;
    sourceTask?: {
      id: string;
      taskNumber?: number;
      title: string;
      status?: { category?: string | null; name?: string | null } | null;
      project?: { key: string } | null;
    } | null;
  }>;
  dependencyState?: {
    blockingTaskCount: number;
    openChildCount: number;
  };
};

interface TaskDetailProps {
  taskId: string;
  statuses: Array<{ id: string; name: string; color: string }>;
  onClose: () => void;
}

function describeActivityEvent(event: { action: string; details?: Record<string, unknown> | null }) {
  switch (event.action) {
    case "created":
      return "created this task";
    case "updated": {
      const changedFields = Array.isArray(event.details?.changedFields)
        ? event.details.changedFields.filter((field): field is string => typeof field === "string")
        : [];
      return changedFields.length > 0
        ? `updated ${changedFields.join(", ")}`
        : "updated this task";
    }
    case "bulkUpdated":
      return "applied a bulk update";
    case "commented":
      return "added a comment";
    case "archived":
      return "archived this task";
    case "unarchived":
      return "restored this task";
    case "duplicated":
      return "created this task by duplicating another one";
    default:
      return event.action;
  }
}

function getDependencyMessages(task: {
  dependencyState?: {
    blockingTaskCount: number;
    openChildCount: number;
  };
}) {
  const messages: string[] = [];

  if ((task.dependencyState?.blockingTaskCount ?? 0) > 0) {
    messages.push(`Blocked by ${task.dependencyState!.blockingTaskCount} incomplete prerequisite${task.dependencyState!.blockingTaskCount === 1 ? "" : "s"}`);
  }

  if ((task.dependencyState?.openChildCount ?? 0) > 0) {
    messages.push(`${task.dependencyState!.openChildCount} child task${task.dependencyState!.openChildCount === 1 ? " is" : "s are"} still open`);
  }

  return messages;
}

function getMutationErrorMessage(error: { message?: string } | null) {
  return error?.message || "Unable to save task changes.";
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TaskDetailSectionDescriptor {
  id: TaskDetailSectionId;
  label: string;
  content: ReactNode;
}

const SECTION_DRAG_START_DISTANCE = 6;

/** Side panel showing full task details with editing */
export function TaskDetail({ taskId, statuses, onClose }: TaskDetailProps) {
  const [editing, setEditing] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [linkTargetId, setLinkTargetId] = useState("");
  const [customFieldValues, setCustomFieldValues] = useState<TaskCustomFieldValueMap>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [commentContent, setCommentContent] = useState("");
  const [commentFiles, setCommentFiles] = useState<File[]>([]);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentContent, setEditingCommentContent] = useState("");
  const [editingCommentError, setEditingCommentError] = useState<string | null>(null);
  const [isUpdatingComment, setIsUpdatingComment] = useState(false);
  const [sectionOrder, setSectionOrder] = useState<TaskDetailSectionId[]>(DEFAULT_TASK_DETAIL_SECTION_ORDER);
  const [hasLoadedSectionOrder, setHasLoadedSectionOrder] = useState(false);
  const [draggingSectionId, setDraggingSectionId] = useState<TaskDetailSectionId | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    targetId: TaskDetailSectionId;
    position: TaskDetailSectionDropPosition;
  } | null>(null);
  const sectionDragStateRef = useRef<{
    pointerId: number;
    sourceId: TaskDetailSectionId;
    originX: number;
    originY: number;
    active: boolean;
    element: HTMLButtonElement;
  } | null>(null);
  const utils = trpc.useUtils();

  const { data: taskData, isLoading } = trpc.task.byId.useQuery({ id: taskId });
  const task = taskData as TaskDetailData | undefined;
  const { data: currentUser } = trpc.user.me.useQuery();

  // Fetch sibling tasks for the link selector
  const { data: siblingTasks } = trpc.task.list.useQuery(
    { projectId: task?.projectId ?? "", limit: 100 },
    { enabled: !!task?.projectId }
  );

  const { data: projectTags } = trpc.tag.list.useQuery(
    { projectId: task?.projectId ?? "" },
    { enabled: !!task?.projectId }
  );
  const { data: people, status: peopleStatus } = trpc.project.people.useQuery(
    { projectId: task?.projectId ?? "" },
    { enabled: !!task?.projectId }
  );
  const { data: sprints = [] } = trpc.sprint.list.useQuery(
    { projectId: task?.projectId ?? "" },
    { enabled: !!task?.projectId }
  );
  const { data: customFields } = trpc.customField.list.useQuery(
    { projectId: task?.projectId ?? "" },
    { enabled: !!task?.projectId }
  );
  const { data: isWatching = false } = trpc.task.isWatching.useQuery(
    { taskId },
    { enabled: !!taskId }
  );

  const updateTask = trpc.task.update.useMutation({
    onMutate: async (variables) => {
      setFormError(null);
      await utils.task.byId.cancel({ id: taskId });
      const prev = utils.task.byId.getData({ id: taskId }) as TaskDetailData | undefined;
      if (prev) {
        const previousParticipants = prev.participants;
        const nextParticipants = variables.participantIds !== undefined && people
          ? variables.participantIds
            .map((participantId) => people?.find((person) => person.id === participantId))
            .filter((person): person is ProjectPersonOption => Boolean(person))
            .map((person) => ({ user: person }))
          : previousParticipants;

        utils.task.byId.setData(
          { id: taskId },
          (((current: TaskDetailData | undefined) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              ...variables,
              ...(variables.participantIds !== undefined ? { participants: nextParticipants } : {}),
            };
          }) as never)
        );
      }
      return { prev };
    },
    onError: (error, _variables, context) => {
      if (context?.prev) {
        utils.task.byId.setData({ id: taskId }, context.prev as never);
      }
      setFormError(getMutationErrorMessage(error));
    },
    onSuccess: () => {
      setFormError(null);
      setEditing(false);
    },
    onSettled: () => {
      utils.task.byId.invalidate({ id: taskId });
      utils.task.list.invalidate();
    },
  });

  const deleteTask = trpc.task.delete.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      onClose();
    },
  });

  const archiveTask = trpc.task.archive.useMutation({
    onSuccess: () => {
      utils.task.byId.invalidate({ id: taskId });
      utils.task.list.invalidate();
      onClose();
    },
  });

  const duplicateTask = trpc.task.duplicate.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
    },
  });

  const addLink = trpc.task.addLink.useMutation({
    onSuccess: () => {
      utils.task.byId.invalidate({ id: taskId });
      utils.task.links.invalidate();
      setShowLinkForm(false);
    },
  });

  const removeLink = trpc.task.removeLink.useMutation({
    onSuccess: () => {
      utils.task.byId.invalidate({ id: taskId });
      utils.task.links.invalidate();
    },
  });

  const watchTask = trpc.task.watch.useMutation({
    onSuccess: () => {
      utils.task.byId.invalidate({ id: taskId });
    },
  });

  const unwatchTask = trpc.task.unwatch.useMutation({
    onSuccess: () => {
      utils.task.byId.invalidate({ id: taskId });
    },
  });

  const customFieldValueMap = useMemo(
    () =>
      ((task?.customFieldValues ?? []) as Array<{ customFieldId: string; value: unknown }>).reduce<TaskCustomFieldValueMap>((accumulator, fieldValue) => {
        const rawValue = fieldValue.value;
        accumulator[fieldValue.customFieldId] = rawValue == null ? "" : String(rawValue);
        return accumulator;
      }, {}),
    [task?.customFieldValues]
  );

  useEffect(() => {
    if (!task) {
      setCustomFieldValues({});
      return;
    }

    if (editing) {
      setCustomFieldValues(customFieldValueMap);
      return;
    }

    setCustomFieldValues({});
  }, [customFieldValueMap, editing, task]);

  useEffect(() => {
    if (!task?.projectId || typeof window === "undefined") {
      return;
    }

    setHasLoadedSectionOrder(false);

    const storageKey = getTaskDetailSectionOrderStorageKey(task.projectId);

    try {
      const storedValue = window.localStorage.getItem(storageKey);
      const parsedValue = storedValue ? JSON.parse(storedValue) : null;
      setSectionOrder(normalizeTaskDetailSectionOrder(parsedValue));
    } catch {
      setSectionOrder(DEFAULT_TASK_DETAIL_SECTION_ORDER);
    }

    setHasLoadedSectionOrder(true);
  }, [task?.projectId]);

  useEffect(() => {
    if (!task?.projectId || typeof window === "undefined" || !hasLoadedSectionOrder) {
      return;
    }

    const storageKey = getTaskDetailSectionOrderStorageKey(task.projectId);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(normalizeTaskDetailSectionOrder(sectionOrder)));
    } catch {
      // Ignore persistence failures; section order falls back to the default order.
    }
  }, [hasLoadedSectionOrder, sectionOrder, task?.projectId]);

  if (isLoading) {
    return (
      <div
        className="fixed inset-y-0 right-0 z-40 w-full max-w-2xl border-l p-6 shadow-xl"
        style={{
          backgroundColor: "var(--color-surface)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="animate-pulse space-y-4">
          <div
            className="h-6 w-3/4 rounded"
            style={{ backgroundColor: "var(--color-border)" }}
          />
          <div
            className="h-4 w-1/2 rounded"
            style={{ backgroundColor: "var(--color-border)" }}
          />
        </div>
      </div>
    );
  }

  if (!task) return null;

  const dependencyMessages = getDependencyMessages(task);
  const isTerminalTask = task.status.category === "done" || task.status.category === "cancelled";
  const isArchived = !!task.archivedAt && new Date(task.archivedAt) <= new Date();
  const canArchiveNow = isTerminalTask && !isArchived;

  const otherTasks = (siblingTasks?.items ?? []).filter(
    (t: { id: string }) => t.id !== taskId
  );

  function clearSectionDragState() {
    sectionDragStateRef.current = null;
    setDraggingSectionId(null);
    setDropIndicator(null);
  }

  function reorderSections(sourceId: TaskDetailSectionId, targetId: TaskDetailSectionId, position: TaskDetailSectionDropPosition) {
    setSectionOrder((currentOrder) => moveTaskDetailSectionOrder(currentOrder, sourceId, targetId, position));
  }

  function updateSectionDropIndicator(clientX: number, clientY: number) {
    const sourceId = sectionDragStateRef.current?.sourceId;
    if (!sourceId) {
      setDropIndicator(null);
      return null;
    }

    const targetElement = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-task-detail-section]");
    const rawTargetId = targetElement?.dataset.taskDetailSection;
    if (!rawTargetId || !isTaskDetailSectionId(rawTargetId) || rawTargetId === sourceId) {
      setDropIndicator(null);
      return null;
    }

    const rect = targetElement.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const position: TaskDetailSectionDropPosition = clientY < midpoint ? "before" : "after";
    setDropIndicator((current) => (
      current?.targetId === rawTargetId && current.position === position
        ? current
        : { targetId: rawTargetId, position }
    ));

    return { targetId: rawTargetId, position };
  }

  function handleSectionHandlePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    sectionId: TaskDetailSectionId
  ) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    sectionDragStateRef.current = {
      pointerId: event.pointerId,
      sourceId: sectionId,
      originX: event.clientX,
      originY: event.clientY,
      active: false,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleSectionHandlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const dragState = sectionDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const distance = Math.hypot(event.clientX - dragState.originX, event.clientY - dragState.originY);
    if (!dragState.active) {
      if (distance < SECTION_DRAG_START_DISTANCE) {
        return;
      }

      dragState.active = true;
      setDraggingSectionId(dragState.sourceId);
    }

    updateSectionDropIndicator(event.clientX, event.clientY);
    event.preventDefault();
  }

  function finishSectionPointerDrag(clientX: number, clientY: number) {
    const dragState = sectionDragStateRef.current;
    if (!dragState) {
      return;
    }

    const resolvedDropTarget = dragState.active ? updateSectionDropIndicator(clientX, clientY) : null;
    if (dragState.active && resolvedDropTarget) {
      reorderSections(dragState.sourceId, resolvedDropTarget.targetId, resolvedDropTarget.position);
    }

    clearSectionDragState();
  }

  function handleSectionHandlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const dragState = sectionDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    finishSectionPointerDrag(event.clientX, event.clientY);
  }

  function handleSectionHandlePointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    const dragState = sectionDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    clearSectionDragState();
  }

  function handleSectionHandleLostPointerCapture(event: ReactPointerEvent<HTMLButtonElement>) {
    const dragState = sectionDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    clearSectionDragState();
  }

  function renderSectionDragHandle(sectionId: TaskDetailSectionId, label: string) {
    return (
      <button
        type="button"
        onPointerDown={(event) => handleSectionHandlePointerDown(event, sectionId)}
        onPointerMove={handleSectionHandlePointerMove}
        onPointerUp={handleSectionHandlePointerUp}
        onPointerCancel={handleSectionHandlePointerCancel}
        onLostPointerCapture={handleSectionHandleLostPointerCapture}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
          draggingSectionId === sectionId ? "opacity-60" : "opacity-80 hover:opacity-100"
        )}
        style={{
          borderColor: "var(--color-border)",
          backgroundColor: "var(--color-bg-muted)",
          color: "var(--color-text-muted)",
          cursor: "grab",
          touchAction: "none",
        }}
        aria-label={`Reorder ${label} section`}
        title={`Drag to reorder ${label.toLowerCase()}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
    );
  }

  function wrapSection(section: TaskDetailSectionDescriptor) {
    const showBeforeDropIndicator = dropIndicator?.targetId === section.id && dropIndicator.position === "before";
    const showAfterDropIndicator = dropIndicator?.targetId === section.id && dropIndicator.position === "after";

    return (
      <div
        key={section.id}
        data-task-detail-section={section.id}
        className="relative"
      >
        {showBeforeDropIndicator && (
          <div className="mb-2 h-1 rounded-full" style={{ backgroundColor: "var(--color-accent)" }} />
        )}
        {section.content}
        {showAfterDropIndicator && (
          <div className="mt-2 h-1 rounded-full" style={{ backgroundColor: "var(--color-accent)" }} />
        )}
      </div>
    );
  }

  function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const effectiveCustomFieldValues = Object.entries(customFieldValues).map(([customFieldId, value]) => ({
      customFieldId,
      value,
    }));

    updateTask.mutate({
      id: taskId,
      title: form.get("title") as string,
      body: (form.get("body") as string) || null,
      statusId: form.get("statusId") as string,
      priority: form.get("priority") as "none" | "low" | "medium" | "high" | "urgent",
      dueDate: new Date(form.get("dueDate") as string),
      startDate: form.get("startDate")
        ? new Date(form.get("startDate") as string)
        : null,
      sprintId: ((form.get("sprintId") as string) || null),
      tagIds: form.getAll("tags") as string[],
      customFieldValues: effectiveCustomFieldValues,
      ...(canEditPeopleFields
        ? {
            assigneeId: ((form.get("assigneeId") as string) || null),
            participantIds: form.getAll("participantIds") as string[],
          }
        : {}),
    });
  }

  async function handleAddComment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!commentContent.trim() && commentFiles.length === 0) return;

    const formData = new FormData();
    formData.set("content", commentContent);
    commentFiles.forEach((file) => formData.append("attachments", file));

    setIsSubmittingComment(true);
    setCommentError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "Unable to add comment");
      }

      setCommentContent("");
      setCommentFiles([]);
      await utils.task.byId.invalidate({ id: taskId });
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : "Unable to add comment");
    } finally {
      setIsSubmittingComment(false);
    }
  }

  function beginCommentEdit(comment: {
    id: string;
    content: string;
    attachments?: Array<{ originalName: string }>;
  }) {
    setEditingCommentId(comment.id);
    setEditingCommentContent(getCommentBody(comment.content, comment.attachments));
    setEditingCommentError(null);
  }

  function cancelCommentEdit() {
    setEditingCommentId(null);
    setEditingCommentContent("");
    setEditingCommentError(null);
  }

  async function handleUpdateComment(commentId: string) {
    setIsUpdatingComment(true);
    setEditingCommentError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/comments/${commentId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: editingCommentContent }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "Unable to update comment");
      }

      cancelCommentEdit();
      await utils.task.byId.invalidate({ id: taskId });
    } catch (error) {
      setEditingCommentError(error instanceof Error ? error.message : "Unable to update comment");
    } finally {
      setIsUpdatingComment(false);
    }
  }

  function handleAddLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const linkType = form.get("linkType") as "blocks" | "relates" | "parent" | "child";
    if (!linkTargetId) return;
    addLink.mutate({ sourceTaskId: taskId, targetTaskId: linkTargetId, linkType });
    setLinkTargetId("");
  }

  const taskKey = task.taskNumber && task.project?.key
    ? `${task.project.key}-${task.taskNumber}`
    : null;
  const taskBody = task.body;
  const creator = task.creator;
  const assignee = task.assignee;
  const participants = task.participants ?? [];
  const peopleOptions = people ?? [];
  const creatorLabel = creator?.name?.trim() || creator?.email || "Unknown";
  const assigneeLabel = assignee?.name?.trim() || assignee?.email || "Unassigned";
  const participantIds = participants.map((participant) => participant.user.id);
  const canEditPeopleFields = peopleStatus === "success" && peopleOptions.length > 0;
  const peopleFieldMessage = peopleStatus === "pending"
    ? "Loading project people. Saving now will keep the current values."
    : peopleStatus === "success"
      ? "No project people are available right now. Saving now will keep the current values."
      : "Project people are unavailable right now. Saving now will keep the current values.";
  const closedAt = task.closedAt;
  const activityEvents = task.activityEvents ?? [];
  const alertAcknowledged = task.alertAcknowledged ?? false;
  const hasLinks = task.sourceLinks.length > 0 || task.targetLinks.length > 0;
  const recurrenceRule = task.recurrenceRule ?? null;

  const visibleSections: TaskDetailSectionDescriptor[] = (() => {
    const sections: TaskDetailSectionDescriptor[] = [
      {
        id: "timeTracking",
        label: "Time tracking",
        content: (
          <TimeTrackingControls
            projectId={task.projectId}
            taskId={taskId}
            dragHandle={renderSectionDragHandle("timeTracking", "Time tracking")}
          />
        ),
      },
      {
        id: "recurrence",
        label: "Recurring task",
        content: (
          <RecurrenceControls
            taskId={taskId}
            dueDate={task.dueDate}
            rule={recurrenceRule}
            dragHandle={renderSectionDragHandle("recurrence", "Recurring task")}
          />
        ),
      },
      ...(dependencyMessages.length > 0
        ? [
            {
              id: "dependencyWarning" as const,
              label: "Dependency warning",
              content: (
                <section
                  className="rounded-2xl border p-4 text-sm"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--color-danger) 8%, transparent)",
                    borderColor: "color-mix(in srgb, var(--color-danger) 30%, var(--color-border))",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    {renderSectionDragHandle("dependencyWarning", "Dependency warning")}
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold" style={{ color: "var(--color-danger)" }}>
                        Dependency warning
                      </div>
                      <div className="mt-2 space-y-1">
                        {dependencyMessages.map((message) => (
                          <div key={message}>{message}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              ),
            },
          ]
        : []),
      {
        id: "overview",
        label: "Overview",
        content: (
          <section
            className="rounded-2xl border p-4"
            style={{
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)",
            }}
          >
            <div className="flex items-start gap-3">
              {renderSectionDragHandle("overview", "Overview")}
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                  Overview
                </h4>
                <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                  <div
                    className="rounded-2xl border p-4"
                    style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
                  >
                    <div className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
                      Due
                    </div>
                    <div className="mt-1 font-semibold" style={{ color: "var(--color-text)" }}>
                      {new Date(task.dueDate).toLocaleDateString()}
                    </div>
                  </div>
                  <div
                    className="rounded-2xl border p-4"
                    style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
                  >
                    <div className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
                      Start
                    </div>
                    <div className="mt-1 font-semibold" style={{ color: "var(--color-text)" }}>
                      {task.startDate ? new Date(task.startDate).toLocaleDateString() : "Not set"}
                    </div>
                  </div>
                  <div
                    className="rounded-2xl border p-4"
                    style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
                  >
                    <div className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
                      Assignee
                    </div>
                    <div className="mt-2 flex min-w-0 items-center gap-2 font-semibold" style={{ color: "var(--color-text)" }}>
                      {assignee && <Avatar name={assignee.name} email={assignee.email} image={assignee.image} size="xs" />}
                      <span className="truncate">{assigneeLabel}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        ),
      },
      {
        id: "participants",
        label: "Participants",
        content: (
          <section
            className="rounded-2xl border p-4"
            style={{
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)",
            }}
          >
            <div className="flex items-start gap-3">
              {renderSectionDragHandle("participants", "Participants")}
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                  Participants
                </h4>
                {participants.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {participants.map((participant) => (
                      <div
                        key={participant.user.id}
                        className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs"
                        style={{
                          borderColor: "var(--color-border)",
                          backgroundColor: "var(--color-bg-overlay)",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        <Avatar
                          name={participant.user.name}
                          email={participant.user.email}
                          image={participant.user.image}
                          size="xs"
                        />
                        <span>{participant.user.name?.trim() || participant.user.email}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm" style={{ color: "var(--color-text-muted)" }}>
                    No participants added.
                  </p>
                )}
              </div>
            </div>
          </section>
        ),
      },
      ...(taskBody
        ? [
            {
              id: "description" as const,
              label: "Description",
              content: (
                <section
                  className="rounded-2xl border p-4"
                  style={{
                    backgroundColor: "var(--color-bg-overlay)",
                    borderColor: "var(--color-border)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    {renderSectionDragHandle("description", "Description")}
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                        Description
                      </h4>
                      {/* citadel-d77.17: markdown-rendered description with @mention highlights */}
                      <Markdown source={taskBody} className="mt-3" mentionUsers={peopleOptions} />
                    </div>
                  </div>
                </section>
              ),
            },
          ]
        : []),
      {
        id: "comments",
        label: "Comments",
        content: (
          <section
            className="rounded-2xl border p-4"
            style={{
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)",
            }}
          >
            <div className="flex items-start gap-3">
              {renderSectionDragHandle("comments", "Comments")}
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                  Comments
                </h4>
                <div className="mt-3 space-y-2">
                  {task.comments.map((comment) => {
                      const canEditComment = currentUser?.id === comment.authorId;
                      const isEditingComment = editingCommentId === comment.id;
                      const commentBody = getCommentBody(comment.content, comment.attachments);
                      const canSaveComment = comment.attachments?.length
                        ? true
                        : Boolean(editingCommentContent.trim());

                      return (
                        <div
                          key={comment.id}
                          className="rounded-xl border p-3 text-sm"
                          style={{
                            backgroundColor: "var(--color-bg-overlay)",
                            borderColor: "var(--color-border)",
                          }}
                        >
                          <div
                            className="flex items-start justify-between gap-3 text-xs"
                            style={{ color: "var(--color-text-muted)" }}
                          >
                            <span>{comment.author.name ?? "User"}</span>
                            <div className="flex items-center gap-2">
                              <span>
                                {new Date(comment.createdAt).toLocaleDateString()}
                              </span>
                              {canEditComment && !isEditingComment && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-auto px-1 py-0 text-xs"
                                  aria-label="Edit comment"
                                  onClick={() => beginCommentEdit(comment)}
                                >
                                  Edit
                                </Button>
                              )}
                            </div>
                          </div>
                          {isEditingComment ? (
                            <div className="mt-2 space-y-2">
                              {editingCommentError && (
                                <div
                                  className="rounded-lg border px-3 py-2 text-sm"
                                  style={{
                                    backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
                                    borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))",
                                    color: "var(--color-danger)",
                                  }}
                                >
                                  {editingCommentError}
                                </div>
                              )}
                              {/* citadel-d77.17: mention autocomplete textarea */}
                              <MentionTextarea
                                value={editingCommentContent}
                                onChange={(next) => setEditingCommentContent(next)}
                                people={peopleOptions}
                                maxLength={5000}
                                rows={3}
                                className="w-full"
                              />
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  aria-label="Cancel comment edit"
                                  onClick={cancelCommentEdit}
                                  disabled={isUpdatingComment}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  aria-label="Save comment"
                                  onClick={() => handleUpdateComment(comment.id)}
                                  disabled={isUpdatingComment || !canSaveComment}
                                >
                                  {isUpdatingComment ? "Saving..." : "Save"}
                                </Button>
                              </div>
                            </div>
                          ) : commentBody ? (
                            // citadel-d77.17: markdown-rendered comment (single newlines kept as line breaks)
                            <Markdown source={commentBody} className="mt-1" mentionUsers={peopleOptions} breaks />
                          ) : null}
                          {(comment.attachments?.length ?? 0) > 0 && (
                            <div className="mt-3 space-y-2">
                              {comment.attachments!.map((attachment) => {
                                const attachmentUrl = `/api/comment-attachments/${attachment.id}`;
                                const isImage = attachment.mimeType.startsWith("image/");

                                return (
                                  <div key={attachment.id} className="rounded-md border p-2" style={{ borderColor: "var(--color-border)" }}>
                                    {isImage && (
                                      <a href={attachmentUrl} target="_blank" rel="noreferrer">
                                        <Image
                                          src={attachmentUrl}
                                          alt={attachment.originalName}
                                          width={720}
                                          height={420}
                                          unoptimized
                                          className="mb-2 max-h-44 rounded object-contain"
                                        />
                                      </a>
                                    )}
                                    <a
                                      href={attachmentUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-sm font-medium underline"
                                      style={{ color: "var(--color-accent)" }}
                                    >
                                      {attachment.originalName}
                                    </a>
                                    <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                                      {attachment.mimeType} · {formatBytes(attachment.sizeBytes)}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {task.comments.length === 0 && (
                    <p
                      className="rounded-xl border px-3 py-4 text-center text-xs italic"
                      style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                    >
                      No comments yet
                    </p>
                  )}
                </div>
                <form onSubmit={handleAddComment} className="mt-3 space-y-2">
                  {commentError && (
                    <div
                      className="rounded-lg border px-3 py-2 text-sm"
                      style={{
                        backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
                        borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))",
                        color: "var(--color-danger)",
                      }}
                    >
                      {commentError}
                    </div>
                  )}
                  <MentionTextarea
                    name="content"
                    value={commentContent}
                    onChange={(next) => setCommentContent(next)}
                    people={peopleOptions}
                    placeholder="Add a comment..."
                    maxLength={5000}
                    rows={3}
                    className="w-full"
                  />
                  <div>
                    <input
                      type="file"
                      multiple
                      onChange={(event) => setCommentFiles(Array.from(event.target.files ?? []))}
                      className="block w-full text-xs"
                    />
                    {commentFiles.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {commentFiles.map((file) => (
                          <span
                            key={`${file.name}-${file.size}`}
                            className="rounded-full px-2 py-1 text-xs"
                            style={{
                              backgroundColor: "var(--color-bg-muted)",
                              color: "var(--color-text-secondary)",
                            }}
                          >
                            {file.name} · {formatBytes(file.size)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" size="sm" disabled={isSubmittingComment || (!commentContent.trim() && commentFiles.length === 0)}>
                      {isSubmittingComment ? "Sending..." : "Send"}
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          </section>
        ),
      },
      ...((task.tags.length > 0 || task.customFieldValues.length > 0)
        ? [
            {
              id: "details" as const,
              label: "Details",
              content: (
                <section
                  className="rounded-2xl border p-4"
                  style={{
                    backgroundColor: "var(--color-surface)",
                    borderColor: "var(--color-border)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    {renderSectionDragHandle("details", "Details")}
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                        Details
                      </h4>
                      {task.tags.length > 0 && (
                        <div className="mt-3">
                          <div className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
                            Tags
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {task.tags.map(({ tag }: { tag: { id: string; name: string; color: string } }) => (
                              <Badge
                                key={tag.id}
                                style={
                                  {
                                    backgroundColor: `${tag.color}20`,
                                    color: tag.color,
                                  } as React.CSSProperties
                                }
                              >
                                {tag.name}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      {task.customFieldValues.length > 0 && (
                        <div className="mt-4">
                          <div className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
                            Custom Fields
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {task.customFieldValues.map((fieldValue) => (
                              <div
                                key={fieldValue.id ?? fieldValue.customFieldId}
                                className="rounded-xl border p-3 text-sm"
                                style={{
                                  backgroundColor: "var(--color-bg-overlay)",
                                  borderColor: "var(--color-border)",
                                }}
                              >
                                <div className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                                  {fieldValue.customField?.name ?? fieldValue.customFieldId}
                                </div>
                                <div className="mt-1" style={{ color: "var(--color-text)" }}>
                                  {fieldValue.value == null ? "—" : String(fieldValue.value)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              ),
            },
          ]
        : []),
      {
        id: "alert",
        label: "Due-date alert",
        content: (
          <section
            className="rounded-2xl border p-4"
            style={{
              backgroundColor: "var(--color-bg-overlay)",
              borderColor: "var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            <div className="flex items-start gap-3">
              {renderSectionDragHandle("alert", "Due-date alert")}
              <label className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium" style={{ color: "var(--color-text)" }}>
                    Due-date alert
                  </span>
                  <span className="mt-1 block text-xs" style={{ color: "var(--color-text-muted)" }}>
                    {alertAcknowledged ? "Acknowledged for this task" : "Not acknowledged yet"}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="rounded"
                  checked={alertAcknowledged}
                  onChange={(e) => {
                    updateTask.mutate({ id: taskId, alertAcknowledged: e.target.checked });
                  }}
                />
              </label>
            </div>
          </section>
        ),
      },
      {
        id: "dependencies",
        label: "Dependencies",
        content: (
          <section
            className="rounded-2xl border p-4"
            style={{
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)",
            }}
          >
            <div className="flex items-start gap-3">
              {renderSectionDragHandle("dependencies", "Dependencies")}
              <div className="min-w-0 flex-1">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                    Dependencies
                  </h4>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowLinkForm(!showLinkForm)}
                  >
                    {showLinkForm ? "Cancel" : "Add link"}
                  </Button>
                </div>

                {showLinkForm && (
                  <form
                    onSubmit={handleAddLink}
                    className="mb-3 space-y-2 rounded-2xl border p-3"
                    style={{
                      backgroundColor: "var(--color-bg-overlay)",
                      borderColor: "var(--color-border)",
                    }}
                  >
                    <Select name="linkType" defaultValue="blocks">
                      <option value="blocks">blocks</option>
                      <option value="relates">relates to</option>
                      <option value="parent">is parent of</option>
                      <option value="child">is child of</option>
                    </Select>
                    <TaskSearchInput
                      tasks={otherTasks}
                      value={linkTargetId}
                      onChange={setLinkTargetId}
                      placeholder="Search for a task..."
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={addLink.isPending || !linkTargetId}
                      className="w-full"
                    >
                      Create Link
                    </Button>
                  </form>
                )}

                <div className="space-y-2 text-sm">
                  {task.sourceLinks.map((link) => (
                      <div
                        key={link.id ?? `${link.linkType}-${link.targetTask?.id ?? "unknown"}`}
                        className="flex items-start justify-between gap-3 rounded-xl border px-3 py-2"
                        style={{
                          backgroundColor: "var(--color-bg-overlay)",
                          borderColor: "var(--color-border)",
                        }}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                              style={{
                                backgroundColor: "var(--color-accent-muted)",
                                color: "var(--color-accent)",
                              }}
                            >
                              {link.linkType}
                            </span>
                            <span className="font-semibold" style={{ color: "var(--color-text)" }}>
                              {link.targetTask?.project?.key ?? "TASK"}-{link.targetTask?.taskNumber ?? "?"}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
                            {link.targetTask?.title ?? "Linked task"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => link.id && removeLink.mutate({ id: link.id })}
                          className="text-xs opacity-50 hover:opacity-100"
                          style={{ color: "var(--color-danger)" }}
                          title="Remove link"
                          aria-label={`Remove link to ${link.targetTask?.project?.key ?? "TASK"}-${link.targetTask?.taskNumber ?? "?"}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  {task.targetLinks.map((link) => (
                      <div
                        key={link.id ?? `${link.linkType}-${link.sourceTask?.id ?? "unknown"}`}
                        className="flex items-start justify-between gap-3 rounded-xl border px-3 py-2"
                        style={{
                          backgroundColor: "var(--color-bg-overlay)",
                          borderColor: "var(--color-border)",
                        }}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                              style={{
                                backgroundColor: "var(--color-accent-muted)",
                                color: "var(--color-accent)",
                              }}
                            >
                              {link.linkType}
                            </span>
                            <span className="font-semibold" style={{ color: "var(--color-text)" }}>
                              {link.sourceTask?.project?.key ?? "TASK"}-{link.sourceTask?.taskNumber ?? "?"}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
                            {link.sourceTask?.title ?? "Linked task"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => link.id && removeLink.mutate({ id: link.id })}
                          className="text-xs opacity-50 hover:opacity-100"
                          style={{ color: "var(--color-danger)" }}
                          title="Remove link"
                          aria-label={`Remove link from ${link.sourceTask?.project?.key ?? "TASK"}-${link.sourceTask?.taskNumber ?? "?"}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  {!hasLinks && (
                    <p
                      className="rounded-xl border px-3 py-4 text-center text-xs italic"
                      style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                    >
                      No dependencies yet
                    </p>
                  )}
                </div>
              </div>
            </div>
          </section>
        ),
      },
      {
        id: "activity",
        label: "Activity",
        content: (
          <section
            className="rounded-2xl border p-4"
            style={{
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)",
            }}
          >
            <div className="flex items-start gap-3">
              {renderSectionDragHandle("activity", "Activity")}
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setShowActivity((current) => !current)}
                  className="flex w-full items-center justify-between gap-3 text-left"
                >
                  <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                    Activity
                  </h4>
                  <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{showActivity ? "Hide" : "Show"}</span>
                </button>
                {showActivity && (
                  <div className="mt-3 space-y-2">
                    {activityEvents.map((event) => (
                      <div
                        key={event.id}
                        className="rounded-xl border p-3 text-sm"
                        style={{
                          backgroundColor: "var(--color-bg-overlay)",
                          borderColor: "var(--color-border)",
                        }}
                      >
                        <div
                          className="flex justify-between gap-3 text-xs"
                          style={{ color: "var(--color-text-muted)" }}
                        >
                          <span>
                            {(event.actor?.name?.trim() || event.actor?.email || "System")} {describeActivityEvent(event)}
                          </span>
                          <span className="shrink-0">{new Date(event.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                    ))}
                    {activityEvents.length === 0 && (
                      <p
                        className="rounded-xl border px-3 py-4 text-center text-xs italic"
                        style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                      >
                        No activity recorded yet
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        ),
      },
      {
        id: "record",
        label: "Record",
        content: (
          <section
            className="rounded-2xl border p-4 text-sm"
            style={{
              backgroundColor: "var(--color-bg-overlay)",
              borderColor: "var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            <div className="flex items-start gap-3">
              {renderSectionDragHandle("record", "Record")}
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold" style={{ color: "var(--color-text-secondary)" }}>
                  Record
                </h4>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <span className="font-medium">Created by:</span>{" "}
                    <span className="inline-flex max-w-full items-center gap-2 align-middle">
                      {creator ? (
                        <>
                          <Avatar
                            name={creator.name}
                            email={creator.email}
                            image={creator.image}
                            size="xs"
                          />
                          <span className="truncate">{creatorLabel}</span>
                        </>
                      ) : (
                        <span>Unknown</span>
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="font-medium">Created:</span>{" "}
                    {new Date(task.createdAt).toLocaleString()}
                  </div>
                  <div>
                    <span className="font-medium">Updated:</span>{" "}
                    {new Date(task.updatedAt).toLocaleString()}
                  </div>
                  {closedAt && (
                    <div>
                      <span className="font-medium">Closed:</span>{" "}
                      {new Date(closedAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        ),
      },
    ];

    const sectionById = new Map(sections.map((section) => [section.id, section]));
    return normalizeTaskDetailSectionOrder(sectionOrder)
      .map((sectionId) => sectionById.get(sectionId))
      .filter((section): section is TaskDetailSectionDescriptor => Boolean(section));
  })();

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l shadow-xl backdrop-blur-md"
      style={{
        backgroundColor: "var(--color-surface)",
        borderColor: "var(--color-border)",
        color: "var(--color-text)",
      }}
    >
      {/* Header */}
      <div
        className="border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
              Task Detail
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {taskKey && (
                <span className="rounded-full px-2.5 py-1 text-xs font-bold" style={{ backgroundColor: "var(--color-accent-muted)", color: "var(--color-accent)" }}>
                  {taskKey}
                </span>
              )}
              <StatusBadge name={task.status.name} color={task.status.color} />
              <Badge variant="outline" className="capitalize">
                {task.priority}
              </Badge>
            </div>
            <h2 className="mt-3 text-2xl font-semibold leading-tight tracking-tight" style={{ color: "var(--color-text)" }}>
              {editing ? "Edit task" : task.title}
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close task detail">
            ✕
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 pb-5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => (isWatching ? unwatchTask.mutate({ taskId }) : watchTask.mutate({ taskId }))}
            disabled={watchTask.isPending || unwatchTask.isPending}
          >
            {isWatching ? "Unwatch" : "Watch"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => duplicateTask.mutate({ id: taskId })}
            disabled={duplicateTask.isPending}
          >
            {duplicateTask.isPending ? "Duplicating..." : "Duplicate"}
          </Button>
          <Button
            variant={editing ? "secondary" : "default"}
            size="sm"
            onClick={() => {
              setFormError(null);
              setEditing(!editing);
            }}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
          {!editing && (
            <AiChatLauncher
              projectId={task.projectId}
              taskId={taskId}
              title={`AI chat for ${task.title}`}
              buttonLabel="Ask AI"
            />
          )}
          {canArchiveNow && !editing && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => archiveTask.mutate({ id: taskId })}
              disabled={archiveTask.isPending}
            >
              {archiveTask.isPending ? "Archiving..." : "Archive now"}
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {editing ? (
          <form onSubmit={handleSave} className="space-y-3">
            {formError && (
              <div
                className="rounded-lg border px-3 py-2 text-sm"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
                  borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))",
                  color: "var(--color-danger)",
                }}
              >
                {formError}
              </div>
            )}
            <Input
              name="title"
              defaultValue={task.title}
              required
              maxLength={200}
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  className="mb-1 block text-xs font-medium"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Status
                </label>
                <Select name="statusId" defaultValue={task.statusId}>
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Priority
                </label>
                <Select name="priority" defaultValue={task.priority}>
                  <option value="none">None</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  className="mb-1 block text-xs font-medium"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Due Date
                </label>
                <Input
                  name="dueDate"
                  type="date"
                  required
                  defaultValue={
                    new Date(task.dueDate).toISOString().split("T")[0]
                  }
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Start Date
                </label>
                <Input
                  name="startDate"
                  type="date"
                  defaultValue={
                    task.startDate
                      ? new Date(task.startDate).toISOString().split("T")[0]
                      : ""
                  }
                />
              </div>
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Sprint
              </label>
              <Select name="sprintId" defaultValue={task.sprintId ?? ""}>
                <option value="">No sprint</option>
                {sprints.map((sprint) => (
                  <option key={sprint.id} value={sprint.id}>{sprint.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Description
              </label>
              <textarea
                name="body"
                  defaultValue={task.body ?? ""}
                rows={5}
                placeholder="Add task details..."
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
                style={{
                  backgroundColor: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text)",
                  resize: "vertical",
                }}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Assignee
              </label>
              <Select
                name={canEditPeopleFields ? "assigneeId" : undefined}
                defaultValue={task.assignee?.id ?? ""}
                disabled={!canEditPeopleFields}
              >
                {canEditPeopleFields ? (
                  <>
                    <option value="">Unassigned</option>
                    {peopleOptions.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name?.trim() || person.email}
                      </option>
                    ))}
                  </>
                ) : (
                  <option value={task.assignee?.id ?? ""}>{assigneeLabel}</option>
                )}
              </Select>
              {!canEditPeopleFields && (
                <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {peopleFieldMessage}
                </p>
              )}
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Participants
              </label>
              {canEditPeopleFields ? (
                <div
                  className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-lg border p-3"
                  style={{
                    backgroundColor: "var(--color-bg-overlay)",
                    borderColor: "var(--color-border)",
                  }}
                >
                  {peopleOptions.map((person) => {
                    const checked = participantIds.includes(person.id);

                    return (
                      <label
                        key={person.id}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                        style={{ color: "var(--color-text-secondary)" }}
                      >
                        <input
                          type="checkbox"
                          name="participantIds"
                          value={person.id}
                          defaultChecked={checked}
                          className="rounded"
                        />
                        <span>{person.name?.trim() || person.email}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div
                  className="space-y-2 rounded-lg border p-3"
                  style={{
                    backgroundColor: "var(--color-bg-overlay)",
                    borderColor: "var(--color-border)",
                  }}
                >
                  {participants.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {participants.map((participant) => (
                        <div
                          key={participant.user.id}
                          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                          style={{
                            backgroundColor: "var(--color-surface)",
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          <Avatar
                            name={participant.user.name}
                            email={participant.user.email}
                            image={participant.user.image}
                            size="xs"
                          />
                          <span>{participant.user.name?.trim() || participant.user.email}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                      No participants added.
                    </p>
                  )}
                  <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    {peopleFieldMessage}
                  </p>
                </div>
              )}
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Tags
              </label>
              {projectTags && projectTags.length > 0 ? (
                <div
                  className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-lg border p-3"
                  style={{
                    backgroundColor: "var(--color-bg-overlay)",
                    borderColor: "var(--color-border)",
                  }}
                >
                  {projectTags.map((tag) => {
                    const checked = task.tags.some(({ tag: taskTag }) => taskTag.id === tag.id);

                    return (
                      <label
                        key={tag.id}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                        style={{
                          backgroundColor: `${tag.color}14`,
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        <input
                          type="checkbox"
                          name="tags"
                          value={tag.id}
                          defaultChecked={checked}
                          className="rounded"
                        />
                        <span style={{ color: tag.color }}>{tag.name}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  No tags available for this project.
                </p>
              )}
            </div>
            <CustomFieldInputs
              fields={(customFields ?? []).map((field) => ({
                id: field.id,
                name: field.name,
                type: field.type,
                required: field.required,
                options: (field.options as { choices?: string[] } | null) ?? null,
              }))}
              values={{ ...customFieldValueMap, ...customFieldValues }}
              onChange={(fieldId, value) =>
                setCustomFieldValues((prev) => ({
                  ...prev,
                  [fieldId]: value,
                }))
              }
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={updateTask.isPending}>
                Save
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (confirm("Delete this task?")) {
                    deleteTask.mutate({ id: taskId });
                  }
                }}
              >
                Delete
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-5">
            {visibleSections.map((section) => wrapSection(section))}
          </div>
        )}
      </div>
    </div>
  );
}
