"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import { Alert, Button, useConfirm } from "@/components/ui";
import { DialogControlled as Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";
import { useCrudDialogs } from "@/hooks/use-crud-dialogs";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ProjectRow = RouterOutputs["project"]["list"][number];

export interface ProjectFormData {
  name: string;
  slug: string;
  key: string;
  description: string;
}

export const emptyProject: ProjectFormData = { name: "", slug: "", key: "", description: "" };

export interface ProjectEditFormData {
  name: string;
  description: string;
}

export const emptyProjectEdit: ProjectEditFormData = { name: "", description: "" };

/** Auto-generated slug and short key derived from a project name */
export function deriveProjectNameFields(name: string): { slug: string; key: string } {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
  const key = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
  return { slug, key };
}

/** Projects tab (admin): create, rename and delete projects */
export function ProjectManagement() {
  const utils = trpc.useUtils();
  const { data: projects, isLoading } = trpc.project.list.useQuery();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();
  const dialogs = useCrudDialogs<ProjectRow, ProjectFormData, ProjectEditFormData>({
    createForm: emptyProject,
    editForm: emptyProjectEdit,
  });

  const createMutation = trpc.project.create.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
      dialogs.completeCreate();
    },
  });
  const updateMutation = trpc.project.update.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
      dialogs.completeEdit();
    },
  });
  const deleteMutation = trpc.project.delete.useMutation({
    onSuccess: () => {
      setDeleteError(null);
      utils.project.list.invalidate();
    },
    onError: (error) => {
      setDeleteError(error.message);
    },
  });

  function openEdit(project: ProjectRow) {
    dialogs.openEdit(project, { name: project.name, description: project.description ?? "" });
  }

  if (isLoading) {
    return (
      <div className="animate-pulse py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
        Loading projects...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          Projects
        </h2>
        <Button onClick={dialogs.openCreate}>New Project</Button>
      </div>

      {/* Project list */}
      <div className="space-y-2">
        {projects?.map((project) => (
          <div
            key={project.id}
            className="flex items-center justify-between rounded-lg px-4 py-3"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-mono font-medium"
                  style={{
                    backgroundColor: "var(--color-accent-muted)",
                    color: "var(--color-accent)",
                  }}
                >
                  {project.key}
                </span>
                <span className="font-medium" style={{ color: "var(--color-text)" }}>
                  {project.name}
                </span>
                <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  /{project.slug}
                </span>
              </div>
              {project.description && (
                <p className="mt-1 text-sm truncate" style={{ color: "var(--color-text-secondary)" }}>
                  {project.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 ml-4">
              <Button variant="outline" size="sm" onClick={() => openEdit(project)}>
                Edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  void confirm({
                    title: "Delete this project and all its tasks?",
                    description: "This cannot be undone.",
                    confirmLabel: "Delete",
                    destructive: true,
                  }).then((confirmed) => {
                    if (confirmed) {
                      deleteMutation.mutate({ id: project.id });
                    }
                  });
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        {projects?.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
            No projects yet. Create one to get started.
          </div>
        )}
      </div>
      {deleteError && (
        <Alert variant="danger" className="mt-3">{deleteError}</Alert>
      )}

      {/* Create Project Dialog */}
      <Dialog open={dialogs.createOpen} onOpenChange={(open) => { if (!open) dialogs.closeCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate({
                name: dialogs.createForm.name,
                slug: dialogs.createForm.slug,
                key: dialogs.createForm.key,
                description: dialogs.createForm.description || undefined,
              });
            }}
            className="space-y-4"
          >
            <Field label="Name" required>
              {(ids) => (
                <Input id={ids.id}
                  value={dialogs.createForm.name}
                  onChange={(e) => {
                    const { slug, key } = deriveProjectNameFields(e.target.value);
                    dialogs.setCreateForm((f) => ({ ...f, name: e.target.value, slug, key }));
                  }}
                  placeholder="My Project"
                  required
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Slug" required>
                {(ids) => (
                  <Input id={ids.id}
                    value={dialogs.createForm.slug}
                    onChange={(e) => dialogs.setCreateForm((f) => ({ ...f, slug: e.target.value }))}
                    placeholder="my-project"
                    pattern="^[a-z0-9-]+$"
                    required
                  />
                )}
              </Field>
              <Field label="Key" required>
                {(ids) => (
                  <Input id={ids.id}
                    value={dialogs.createForm.key}
                    onChange={(e) => dialogs.setCreateForm((f) => ({ ...f, key: e.target.value.toUpperCase() }))}
                    placeholder="PROJ"
                    pattern="^[A-Z0-9]+$"
                    maxLength={10}
                    required
                  />
                )}
              </Field>
            </div>
            <Field label="Description">
              {(ids) => (
                <Input id={ids.id}
                  value={dialogs.createForm.description}
                  onChange={(e) => dialogs.setCreateForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description"
                />
              )}
            </Field>
            {createMutation.error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {createMutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={dialogs.closeCreate}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Project Dialog */}
      <Dialog open={dialogs.editOpen} onOpenChange={(open) => { if (!open) dialogs.closeEdit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!dialogs.editing) return;
              updateMutation.mutate({
                id: dialogs.editing.id,
                name: dialogs.editForm.name,
                description: dialogs.editForm.description || undefined,
              });
            }}
            className="space-y-4"
          >
            <Field label="Name" required>
              {(ids) => (
                <Input id={ids.id}
                  value={dialogs.editForm.name}
                  onChange={(e) => dialogs.setEditForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              )}
            </Field>
            <Field label="Description">
              {(ids) => (
                <Input id={ids.id}
                  value={dialogs.editForm.description}
                  onChange={(e) => dialogs.setEditForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description"
                />
              )}
            </Field>
            {updateMutation.error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {updateMutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={dialogs.closeEdit}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {confirmElement}
    </div>
  );
}
