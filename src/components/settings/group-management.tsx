"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import { Alert, Button, useConfirm } from "@/components/ui";
import { DialogControlled as Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";
import { useCrudDialogs } from "@/hooks/use-crud-dialogs";
import { GroupForm, emptyGroup, type GroupFormData } from "@/components/settings/group-form";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type GroupRow = RouterOutputs["group"]["list"][number];

/** Groups tab (admin): create, edit and delete local groups */
export function GroupManagement() {
  const utils = trpc.useUtils();
  const { data: groups, isLoading } = trpc.group.list.useQuery();
  const { data: users } = trpc.user.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();
  const dialogs = useCrudDialogs<GroupRow, GroupFormData>({
    createForm: emptyGroup,
    editForm: emptyGroup,
  });

  const createMutation = trpc.group.create.useMutation({
    onSuccess: () => {
      utils.group.list.invalidate();
      utils.user.list.invalidate();
      dialogs.completeCreate();
    },
  });
  const updateMutation = trpc.group.update.useMutation({
    onSuccess: () => {
      utils.group.list.invalidate();
      utils.user.list.invalidate();
      dialogs.completeEdit();
    },
  });
  const deleteMutation = trpc.group.delete.useMutation({
    onSuccess: () => {
      setDeleteError(null);
      utils.group.list.invalidate();
      utils.user.list.invalidate();
    },
    onError: (error) => {
      setDeleteError(error.message);
    },
  });

  function openEdit(group: GroupRow) {
    dialogs.openEdit(group, {
      name: group.name,
      description: group.description ?? "",
      memberIds: group.members.map((membership) => membership.user.id),
      projectAccess: group.projectMemberships.map((membership) => ({
        projectId: membership.projectId,
        role: membership.role as GroupFormData["projectAccess"][number]["role"],
      })),
    });
  }

  if (isLoading) {
    return (
      <div className="animate-pulse py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
        Loading groups...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
            Groups
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
            Group roles grant project permissions. OIDC groups are created automatically when users sign in.
          </p>
        </div>
        <Button onClick={dialogs.openCreate}>New Group</Button>
      </div>

      <div className="space-y-2">
        {groups?.map((group) => (
          <div key={group.id} className="rounded-lg border px-4 py-3" style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)" }}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium" style={{ color: "var(--color-text)" }}>{group.name}</span>
                  <span className="rounded px-1.5 py-0.5 text-xs" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-muted)" }}>
                    {group.source}
                  </span>
                </div>
                {group.description && (
                  <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>{group.description}</p>
                )}
                <p className="mt-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {group.members.length} member{group.members.length === 1 ? "" : "s"}
                  {group.projectMemberships.length > 0
                    ? ` · ${group.projectMemberships.map((membership) => `${membership.project.key}:${membership.role}`).join(" · ")}`
                    : " · no project roles"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => openEdit(group)}>Edit</Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={group.source !== "local" || group.isSystem}
                  onClick={() => {
                    void confirm({
                      title: "Delete this group?",
                      description: "Group project access will be removed.",
                      confirmLabel: "Delete",
                      destructive: true,
                    }).then((confirmed) => {
                      if (confirmed) {
                        deleteMutation.mutate({ id: group.id });
                      }
                    });
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          </div>
        ))}
        {groups?.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
            No groups yet.
          </div>
        )}
      </div>
      {deleteError && (
        <Alert variant="danger" className="mt-3">{deleteError}</Alert>
      )}

      <Dialog open={dialogs.createOpen} onOpenChange={(open) => { if (!open) dialogs.closeCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Group</DialogTitle>
          </DialogHeader>
          <GroupForm
            value={dialogs.createForm}
            onChange={dialogs.setCreateForm}
            users={users ?? []}
            projects={projects ?? []}
            submitLabel="Create"
            isPending={createMutation.isPending}
            error={createMutation.error?.message ?? null}
            onCancel={dialogs.closeAll}
            onSubmit={() => createMutation.mutate({
              name: dialogs.createForm.name,
              description: dialogs.createForm.description || null,
              memberIds: dialogs.createForm.memberIds,
              projectAccess: dialogs.createForm.projectAccess,
            })}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={dialogs.editOpen} onOpenChange={(open) => { if (!open) dialogs.closeEdit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Group</DialogTitle>
          </DialogHeader>
          {dialogs.editing && (
            <GroupForm
              value={dialogs.editForm}
              managedExternally={dialogs.editing.source !== "local"}
              onChange={dialogs.setEditForm}
              users={users ?? []}
              projects={projects ?? []}
              submitLabel="Save"
              isPending={updateMutation.isPending}
              error={updateMutation.error?.message ?? null}
              onCancel={dialogs.closeAll}
              onSubmit={() => {
                const editing = dialogs.editing;
                if (!editing) return;
                updateMutation.mutate({
                  id: editing.id,
                  ...(editing.source === "local" ? { name: dialogs.editForm.name, memberIds: dialogs.editForm.memberIds } : {}),
                  description: dialogs.editForm.description || null,
                  projectAccess: dialogs.editForm.projectAccess,
                });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmElement}
    </div>
  );
}
