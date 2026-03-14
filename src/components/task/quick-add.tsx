"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";

interface QuickAddProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string }>;
  tags: Array<{ id: string; name: string }>;
}

/** Quick-add task form — FAB button opens dialog, Ctrl+N keyboard shortcut */
export function QuickAdd({ projectId, statuses, tags }: QuickAddProps) {
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const createTask = trpc.task.create.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      setOpen(false);
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
    }
  }, [open]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = form.get("title") as string;
    const dueDate = form.get("dueDate") as string;
    const statusId = form.get("statusId") as string;
    const priority = (form.get("priority") as string) || "none";
    const selectedTags = form.getAll("tags") as string[];

    if (!title || !dueDate) return;

    createTask.mutate({
      projectId,
      title,
      dueDate: new Date(dueDate),
      statusId: statusId || undefined,
      priority: priority as "none" | "low" | "medium" | "high" | "urgent",
      tagIds: selectedTags.length ? selectedTags : undefined,
    });
  }

  const today = new Date().toISOString().split("T")[0];

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
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Due Date
              </label>
              <Input
                name="dueDate"
                type="date"
                required
                defaultValue={today}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
                Priority
              </label>
              <Select name="priority" defaultValue="none">
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
            <Select name="statusId">
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
                      name="tags"
                      value={tag.id}
                      className="rounded"
                      style={{ borderColor: "var(--color-border)" }}
                    />
                    {tag.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createTask.isPending}>
              {createTask.isPending ? "Creating..." : "Create Task"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
