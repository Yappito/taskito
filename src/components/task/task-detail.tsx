"use client";

import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
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

/** Side panel showing full task details with editing */
export function TaskDetail({ taskId, statuses, onClose }: TaskDetailProps) {
  const [editing, setEditing] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkTargetId, setLinkTargetId] = useState("");
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

  const updateTask = trpc.task.update.useMutation({
    onMutate: async (variables) => {
      await utils.task.byId.cancel({ id: taskId });
      const prev = utils.task.byId.getData({ id: taskId });
      if (prev) {
        utils.task.byId.setData({ id: taskId }, { ...prev, ...variables } as typeof prev);
      }
      return { prev };
    },
    onError: (_err, _variables, context) => {
      if (context?.prev) {
        utils.task.byId.setData({ id: taskId }, context.prev);
      }
    },
    onSettled: () => {
      utils.task.byId.invalidate({ id: taskId });
      utils.task.list.invalidate();
      setEditing(false);
    },
  });

  const deleteTask = trpc.task.delete.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      onClose();
    },
  });

  const addComment = trpc.task.addComment.useMutation({
    onSuccess: () => {
      utils.task.byId.invalidate({ id: taskId });
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

  const otherTasks = (siblingTasks?.items ?? []).filter(
    (t: { id: string }) => t.id !== taskId
  );

  function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
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
    });
  }

  function handleAddComment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const content = form.get("content") as string;
    if (!content.trim()) return;
    addComment.mutate({ taskId, content });
    e.currentTarget.reset();
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
            onClick={() => setEditing(!editing)}
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
                Comments
              </h4>
              <div className="space-y-2">
                {task.comments.map(
                  (comment: {
                    id: string;
                    content: string;
                    createdAt: string | Date;
                    author: { name: string | null };
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
                      <p className="mt-1">{comment.content}</p>
                    </div>
                  )
                )}
              </div>
              <form onSubmit={handleAddComment} className="mt-2 flex gap-2">
                <Input
                  name="content"
                  placeholder="Add a comment..."
                  maxLength={5000}
                />
                <Button type="submit" size="sm" disabled={addComment.isPending}>
                  Send
                </Button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
