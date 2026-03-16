"use client";

import Image from "next/image";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { CustomFieldInputs, type TaskCustomFieldValueMap } from "@/components/task/custom-field-inputs";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "./status-badge";
import { Badge } from "@/components/ui/badge";
import { TaskSearchInput } from "@/components/ui/task-search-input";

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

/** Side panel showing full task details with editing */
export function TaskDetail({ taskId, statuses, onClose }: TaskDetailProps) {
  const [editing, setEditing] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkTargetId, setLinkTargetId] = useState("");
  const [customFieldValues, setCustomFieldValues] = useState<TaskCustomFieldValueMap>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [commentContent, setCommentContent] = useState("");
  const [commentFiles, setCommentFiles] = useState<File[]>([]);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const utils = trpc.useUtils();

  const { data: task, isLoading } = trpc.task.byId.useQuery({ id: taskId });

  // Fetch sibling tasks for the link selector
  const { data: siblingTasks } = trpc.task.list.useQuery(
    { projectId: task?.projectId ?? "", limit: 100 },
    { enabled: !!task?.projectId }
  );

  const { data: projectTags } = trpc.tag.list.useQuery(
    { projectId: task?.projectId ?? "" },
    { enabled: !!task?.projectId }
  );
  const { data: people } = trpc.project.people.useQuery(
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
      const prev = utils.task.byId.getData({ id: taskId });
      if (prev) {
        utils.task.byId.setData({ id: taskId }, { ...prev, ...variables } as typeof prev);
      }
      return { prev };
    },
    onError: (error, _variables, context) => {
      if (context?.prev) {
        utils.task.byId.setData({ id: taskId }, context.prev);
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

  if (isLoading) {
    return (
      <div
        className="fixed inset-y-0 right-0 z-40 w-full max-w-md border-l p-6 shadow-xl"
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

  const dependencyMessages = getDependencyMessages(task as {
    dependencyState?: {
      blockingTaskCount: number;
      openChildCount: number;
    };
  });
  const isTerminalTask = task.status.category === "done" || task.status.category === "cancelled";
  const isArchived = !!task.archivedAt && new Date(task.archivedAt) <= new Date();
  const canArchiveNow = isTerminalTask && !isArchived;

  const otherTasks = (siblingTasks?.items ?? []).filter(
    (t: { id: string }) => t.id !== taskId
  );

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
      assigneeId: ((form.get("assigneeId") as string) || null),
      statusId: form.get("statusId") as string,
      priority: form.get("priority") as "none" | "low" | "medium" | "high" | "urgent",
      dueDate: new Date(form.get("dueDate") as string),
      startDate: form.get("startDate")
        ? new Date(form.get("startDate") as string)
        : null,
      tagIds: form.getAll("tags") as string[],
      customFieldValues: effectiveCustomFieldValues,
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

  function handleAddLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const linkType = form.get("linkType") as "blocks" | "relates" | "parent" | "child";
    if (!linkTargetId) return;
    addLink.mutate({ sourceTaskId: taskId, targetTaskId: linkTargetId, linkType });
    setLinkTargetId("");
  }

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l shadow-xl backdrop-blur-md"
      style={{
        backgroundColor: "var(--color-surface)",
        borderColor: "var(--color-border)",
        color: "var(--color-text)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between border-b p-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <h2 className="text-lg font-semibold">Task Detail</h2>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (isWatching ? unwatchTask.mutate({ taskId }) : watchTask.mutate({ taskId }))}
            disabled={watchTask.isPending || unwatchTask.isPending}
          >
            {isWatching ? "Unwatch" : "Watch"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => duplicateTask.mutate({ id: taskId })}
            disabled={duplicateTask.isPending}
          >
            {duplicateTask.isPending ? "Duplicating..." : "Duplicate"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFormError(null);
              setEditing(!editing);
            }}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
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
                Description
              </label>
              <textarea
                name="body"
                defaultValue={(task as { body?: string | null }).body ?? ""}
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
                name="assigneeId"
                defaultValue={(task as { assignee?: { id: string } | null }).assignee?.id ?? ""}
              >
                <option value="">Unassigned</option>
                {(people ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name?.trim() || person.email}
                  </option>
                ))}
              </Select>
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
          <div className="space-y-4">
            {/* Task key */}
            {(task as { taskNumber?: number }).taskNumber && (task as { project?: { key: string } }).project?.key && (
              <span
                className="text-xs font-bold"
                style={{ color: "var(--color-text-muted)" }}
              >
                {(task as { project?: { key: string } }).project!.key}-{(task as { taskNumber?: number }).taskNumber}
              </span>
            )}
            <h3 className="text-xl font-semibold">{task.title}</h3>

            <div className="flex flex-wrap gap-2">
              <StatusBadge
                name={task.status.name}
                color={task.status.color}
              />
              <Badge variant="outline" className="capitalize">
                {task.priority}
              </Badge>
            </div>

            {canArchiveNow && (
              <div
                className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                style={{
                  backgroundColor: "var(--color-bg-overlay)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text-secondary)",
                }}
              >
                <span>
                  This task is no longer active and can be archived now.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => archiveTask.mutate({ id: taskId })}
                  disabled={archiveTask.isPending}
                >
                  {archiveTask.isPending ? "Archiving..." : "Archive now"}
                </Button>
              </div>
            )}

            {dependencyMessages.length > 0 && (
              <div
                className="rounded-lg border px-3 py-2 text-sm"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--color-danger) 8%, transparent)",
                  borderColor: "color-mix(in srgb, var(--color-danger) 30%, var(--color-border))",
                  color: "var(--color-text-secondary)",
                }}
              >
                {dependencyMessages.map((message) => (
                  <div key={message}>{message}</div>
                ))}
              </div>
            )}

            <div
              className="grid grid-cols-2 gap-2 text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              <div>
                <span className="font-medium">Due:</span>{" "}
                {new Date(task.dueDate).toLocaleDateString()}
              </div>
              {task.startDate && (
                <div>
                  <span className="font-medium">Start:</span>{" "}
                  {new Date(task.startDate).toLocaleDateString()}
                </div>
              )}
            </div>

            <div
              className="grid grid-cols-1 gap-2 text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              <div>
                <span className="font-medium">Created by:</span>{" "}
                {(task as { creator?: { name: string | null; email: string } | null }).creator
                  ? ((task as { creator?: { name: string | null; email: string } | null }).creator?.name?.trim() ||
                    (task as { creator?: { name: string | null; email: string } | null }).creator?.email)
                  : "Unknown"}
              </div>
              <div>
                <span className="font-medium">Assigned to:</span>{" "}
                {(task as { assignee?: { name: string | null; email: string } | null }).assignee
                  ? ((task as { assignee?: { name: string | null; email: string } | null }).assignee?.name?.trim() ||
                    (task as { assignee?: { name: string | null; email: string } | null }).assignee?.email)
                  : "Unassigned"}
              </div>
            </div>

            {/* Alert acknowledgement toggle */}
            <label
              className="flex items-center gap-2 text-sm cursor-pointer"
              style={{ color: "var(--color-text-secondary)" }}
            >
              <input
                type="checkbox"
                className="rounded"
                checked={(task as { alertAcknowledged?: boolean }).alertAcknowledged ?? false}
                onChange={(e) => {
                  updateTask.mutate({ id: taskId, alertAcknowledged: e.target.checked });
                }}
              />
              <span>Acknowledge due-date alert</span>
            </label>

            {/* Body / Description */}
            {(task as { body?: string | null }).body && (
              <div>
                <h4
                  className="mb-1 text-xs font-medium"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Description
                </h4>
                <div
                  className="whitespace-pre-wrap rounded-lg p-3 text-sm"
                  style={{
                    backgroundColor: "var(--color-bg-overlay)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {(task as { body?: string | null }).body}
                </div>
              </div>
            )}

            {task.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
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
            )}

            {task.customFieldValues.length > 0 && (
              <div>
                <h4
                  className="mb-1 text-xs font-medium"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Custom Fields
                </h4>
                <div className="space-y-2">
                  {task.customFieldValues.map((fieldValue) => (
                    <div
                      key={fieldValue.id}
                      className="rounded-lg border p-3 text-sm"
                      style={{
                        backgroundColor: "var(--color-bg-overlay)",
                        borderColor: "var(--color-border)",
                      }}
                    >
                      <div className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                        {fieldValue.customField.name}
                      </div>
                      <div>{fieldValue.value == null ? "—" : String(fieldValue.value)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dependencies */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4
                  className="text-sm font-medium"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Dependencies
                </h4>
                <button
                  onClick={() => setShowLinkForm(!showLinkForm)}
                  className="rounded-md px-2 py-0.5 text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: "var(--color-accent-muted)",
                    color: "var(--color-accent)",
                  }}
                >
                  {showLinkForm ? "Cancel" : "+ Add"}
                </button>
              </div>

              {/* Add link form */}
              {showLinkForm && (
                <form
                  onSubmit={handleAddLink}
                  className="mb-3 space-y-2 rounded-lg p-3"
                  style={{
                    backgroundColor: "var(--color-bg-overlay)",
                    border: "1px solid var(--color-border)",
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

              {/* Existing links */}
              <div className="space-y-1 text-sm">
                {task.sourceLinks.map(
                  (link: {
                    id: string;
                    linkType: string;
                    targetTask: {
                      id: string;
                      taskNumber: number;
                      title: string;
                      project: { key: string };
                    };
                  }) => (
                    <div
                      key={link.id}
                      className="flex items-center justify-between rounded-md px-2 py-1"
                      style={{ backgroundColor: "var(--color-bg-overlay)" }}
                    >
                      <span style={{ color: "var(--color-text-secondary)" }}>
                        <span
                          className="mr-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                          style={{
                            backgroundColor: "var(--color-accent-muted)",
                            color: "var(--color-accent)",
                          }}
                        >
                          {link.linkType}
                        </span>
                        →{" "}
                        <span className="font-semibold" style={{ color: "var(--color-text-muted)" }}>
                          {link.targetTask.project.key}-{link.targetTask.taskNumber}
                        </span>{" "}
                        <span className="text-xs">{link.targetTask.title}</span>
                      </span>
                      <button
                        onClick={() => removeLink.mutate({ id: link.id })}
                        className="ml-2 text-xs opacity-50 hover:opacity-100"
                        style={{ color: "var(--color-danger)" }}
                        title="Remove link"
                      >
                        ✕
                      </button>
                    </div>
                  )
                )}
                {task.targetLinks.map(
                  (link: {
                    id: string;
                    linkType: string;
                    sourceTask: {
                      id: string;
                      taskNumber: number;
                      title: string;
                      project: { key: string };
                    };
                  }) => (
                    <div
                      key={link.id}
                      className="flex items-center justify-between rounded-md px-2 py-1"
                      style={{ backgroundColor: "var(--color-bg-overlay)" }}
                    >
                      <span style={{ color: "var(--color-text-secondary)" }}>
                        ←{" "}
                        <span className="font-semibold" style={{ color: "var(--color-text-muted)" }}>
                          {link.sourceTask.project.key}-{link.sourceTask.taskNumber}
                        </span>{" "}
                        <span className="text-xs">{link.sourceTask.title}</span>
                        <span
                          className="ml-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                          style={{
                            backgroundColor: "var(--color-accent-muted)",
                            color: "var(--color-accent)",
                          }}
                        >
                          {link.linkType}
                        </span>
                      </span>
                      <button
                        onClick={() => removeLink.mutate({ id: link.id })}
                        className="ml-2 text-xs opacity-50 hover:opacity-100"
                        style={{ color: "var(--color-danger)" }}
                        title="Remove link"
                      >
                        ✕
                      </button>
                    </div>
                  )
                )}
                {task.sourceLinks.length === 0 &&
                  task.targetLinks.length === 0 && (
                    <p
                      className="text-xs italic"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      No dependencies yet
                    </p>
                  )}
              </div>
            </div>

            {/* Comments */}
            <div>
              <h4
                className="mb-2 text-sm font-medium"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Activity
              </h4>
              <div className="space-y-2">
                {((task as { activityEvents?: Array<{ id: string; action: string; details?: Record<string, unknown> | null; createdAt: string | Date; actor?: { name: string | null; email: string } | null }> }).activityEvents ?? []).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-md p-2 text-sm"
                    style={{ backgroundColor: "var(--color-bg-overlay)" }}
                  >
                    <div
                      className="flex justify-between gap-3 text-xs"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      <span>
                        {(event.actor?.name?.trim() || event.actor?.email || "System")} {describeActivityEvent(event)}
                      </span>
                      <span>{new Date(event.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
                {((task as { activityEvents?: unknown[] }).activityEvents?.length ?? 0) === 0 && (
                  <p className="text-xs italic" style={{ color: "var(--color-text-muted)" }}>
                    No activity recorded yet
                  </p>
                )}
              </div>
            </div>

            {/* Comments */}
            <div>
              <h4
                className="mb-2 text-sm font-medium"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Comments
              </h4>
              <div className="space-y-2">
                {task.comments.map(
                  (comment: {
                    id: string;
                    content: string;
                    createdAt: string | Date;
                    author: { name: string | null };
                    attachments?: Array<{
                      id: string;
                      originalName: string;
                      mimeType: string;
                      sizeBytes: number;
                    }>;
                  }) => (
                    <div
                      key={comment.id}
                      className="rounded-md p-2 text-sm"
                      style={{ backgroundColor: "var(--color-bg-overlay)" }}
                    >
                      <div
                        className="flex justify-between text-xs"
                        style={{ color: "var(--color-text-muted)" }}
                      >
                        <span>{comment.author.name ?? "User"}</span>
                        <span>
                          {new Date(comment.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words">{comment.content}</p>
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
                  )
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
                <textarea
                  name="content"
                  value={commentContent}
                  onChange={(event) => setCommentContent(event.target.value)}
                  placeholder="Add a comment..."
                  maxLength={5000}
                  rows={3}
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                  style={{
                    backgroundColor: "var(--color-surface)",
                    borderColor: "var(--color-border)",
                    color: "var(--color-text)",
                  }}
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
        )}
      </div>
    </div>
  );
}
