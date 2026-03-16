"use client";

import { useState, useRef, useEffect, useCallback, type FormEvent } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { CustomFieldInputs, type TaskCustomFieldValueMap } from "@/components/task/custom-field-inputs";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";

interface ProjectTaskTemplate {
  id: string;
  name: string;
  title: string;
  body?: string | null;
  statusId?: string | null;
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  tagIds?: string[];
  assigneeId?: string | null;
}

interface QuickAddProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string }>;
  tags: Array<{ id: string; name: string }>;
}

/** Quick-add task form — FAB button opens dialog, Ctrl+N keyboard shortcut */
export function QuickAdd({ projectId, statuses, tags }: QuickAddProps) {
  const [open, setOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [selectedStatusId, setSelectedStatusId] = useState("");
  const [priority, setPriority] = useState<"none" | "low" | "medium" | "high" | "urgent">("none");
  const [selectedAssigneeId, setSelectedAssigneeId] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<TaskCustomFieldValueMap>({});
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const { data: people } = trpc.project.people.useQuery({ projectId });
  const { data: templates } = trpc.project.templates.useQuery({ projectId });
  const { data: customFields } = trpc.customField.list.useQuery({ projectId });

  const today = new Date().toISOString().split("T")[0];

  const resetForm = useCallback(() => {
    setSelectedTemplateId("");
    setTitle("");
    setBody("");
    setDueDate(today);
    setSelectedStatusId(statuses[0]?.id ?? "");
    setPriority("none");
    setSelectedAssigneeId("");
    setSelectedTagIds([]);
    setCustomFieldValues({});
    setSaveAsTemplate(false);
    setTemplateName("");
  }, [statuses, today]);

  const createTask = trpc.task.create.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      setOpen(false);
      resetForm();
    },
  });

  const saveTemplateMutation = trpc.project.saveTemplate.useMutation({
    onSuccess: () => {
      utils.project.templates.invalidate({ projectId });
      setSaveAsTemplate(false);
      setTemplateName("");
    },
  });

  // Keyboard shortcut: Ctrl+N / Cmd+N
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Auto-focus title on open
  useEffect(() => {
    if (open) {
      setTimeout(() => titleRef.current?.focus(), 100);
    } else {
      resetForm();
    }
  }, [open, resetForm]);

  useEffect(() => {
    if (!open || selectedAssigneeId || !people?.length) {
      return;
    }

    setSelectedAssigneeId(people[0].id);
  }, [open, people, selectedAssigneeId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setDueDate((current) => current || today);
    setSelectedStatusId((current) => current || statuses[0]?.id || "");
  }, [open, statuses, today]);

  useEffect(() => {
    if (!selectedTemplateId) {
      return;
    }

    const template = (templates as ProjectTaskTemplate[] | undefined)?.find((item) => item.id === selectedTemplateId);
    if (!template) {
      return;
    }

    setTitle(template.title);
    setBody(template.body ?? "");
    setSelectedStatusId(template.statusId ?? statuses[0]?.id ?? "");
    setPriority(template.priority ?? "none");
    setSelectedAssigneeId(template.assigneeId ?? "");
    setSelectedTagIds(template.tagIds ?? []);
    setCustomFieldValues({});
  }, [selectedTemplateId, statuses, templates]);

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    const assigneeId = selectedAssigneeId || null;

    if (!trimmedTitle || !dueDate) return;

    if (saveAsTemplate && templateName.trim()) {
      saveTemplateMutation.mutate({
        projectId,
        name: templateName.trim(),
        title: trimmedTitle,
        body: trimmedBody || null,
        statusId: selectedStatusId || undefined,
        priority,
        tagIds: selectedTagIds,
        assigneeId,
      });
    }

    createTask.mutate({
      projectId,
      title: trimmedTitle,
      body: trimmedBody || null,
      assigneeId,
      dueDate: new Date(dueDate),
      statusId: selectedStatusId || undefined,
      priority,
      tagIds: selectedTagIds.length ? selectedTagIds : undefined,
      customFieldValues: Object.entries(customFieldValues).map(([customFieldId, value]) => ({
        customFieldId,
        value,
      })),
    });
  }

  return (
    <>
      {/* FAB for mobile */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full text-2xl text-white shadow-lg md:hidden"
        style={{ backgroundColor: "var(--color-accent)" }}
        aria-label="Add task"
      >
        +
      </button>

      {/* Desktop button */}
      <Button
        onClick={() => setOpen(true)}
        className="hidden md:inline-flex"
      >
        + New Task
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)}>
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--color-text)" }}>New Task</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            ref={titleRef}
            name="title"
            placeholder="Task title..."
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />

          {(templates as ProjectTaskTemplate[] | undefined)?.length ? (
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Start from template
              </label>
              <Select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>
                <option value="">No template</option>
                {(templates as ProjectTaskTemplate[]).map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
              Description
            </label>
            <textarea
              name="body"
              rows={4}
              placeholder="Add task details..."
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
              style={{
                backgroundColor: "var(--color-surface)",
                borderColor: "var(--color-border)",
                color: "var(--color-text)",
                resize: "vertical",
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Due Date
              </label>
              <Input
                name="dueDate"
                type="date"
                required
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Priority
              </label>
              <Select
                name="priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value as "none" | "low" | "medium" | "high" | "urgent")}
              >
                <option value="none">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
              Status
            </label>
            <Select
              name="statusId"
              value={selectedStatusId}
              onChange={(event) => setSelectedStatusId(event.target.value)}
            >
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
              Assignee
            </label>
            <Select
              name="assigneeId"
              value={selectedAssigneeId}
              onChange={(event) => setSelectedAssigneeId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {(people ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {(person.name?.trim() || person.email)}
                </option>
              ))}
            </Select>
          </div>

          {tags.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Tags
              </label>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <label key={tag.id} className="flex items-center gap-1 text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    <input
                      type="checkbox"
                      value={tag.id}
                      checked={selectedTagIds.includes(tag.id)}
                      onChange={() => toggleTag(tag.id)}
                      className="rounded"
                      style={{ borderColor: "var(--color-border)" }}
                    />
                    {tag.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <CustomFieldInputs
            fields={(customFields ?? []).map((field) => ({
              id: field.id,
              name: field.name,
              type: field.type,
              required: field.required,
              options: (field.options as { choices?: string[] } | null) ?? null,
            }))}
            values={customFieldValues}
            onChange={(fieldId, value) =>
              setCustomFieldValues((prev) => ({
                ...prev,
                [fieldId]: value,
              }))
            }
          />

          <div className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
            <label className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
              <input
                type="checkbox"
                checked={saveAsTemplate}
                onChange={(event) => setSaveAsTemplate(event.target.checked)}
              />
              Save this draft as a reusable template
            </label>
            {saveAsTemplate && (
              <Input
                className="mt-3"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder="Template name"
                maxLength={100}
              />
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createTask.isPending || saveTemplateMutation.isPending || (saveAsTemplate && !templateName.trim())}>
              {createTask.isPending ? "Creating..." : "Create Task"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
