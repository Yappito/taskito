"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH_HINT } from "@/lib/password-policy";
import type { inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import { Alert, Avatar, Button, Field, useConfirm } from "@/components/ui";
import { DialogControlled as Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";
import { useCrudDialogs } from "@/hooks/use-crud-dialogs";
import { toggleId } from "@/lib/id-list";
import { AccessChecklists } from "@/components/settings/access-checklists";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type UserRow = RouterOutputs["user"]["list"][number];

export interface UserFormData {
  name: string;
  email: string;
  password: string;
  role: "admin" | "member";
  projectIds: string[];
  groupIds: string[];
}

export const emptyUser: UserFormData = { name: "", email: "", password: "", role: "member", projectIds: [], groupIds: [] };

export interface UserEditFormData {
  name: string;
  email: string;
  role: "admin" | "member";
  password: string;
  projectIds: string[];
  groupIds: string[];
  disabled: boolean;
}

export const emptyUserEdit: UserEditFormData = {
  name: "",
  email: "",
  role: "member",
  password: "",
  projectIds: [],
  groupIds: [],
  disabled: false,
};

function RoleRadios({
  name,
  value,
  onChange,
}: {
  name: string;
  value: "admin" | "member";
  onChange: (role: "admin" | "member") => void;
}) {
  return (
    <Field label="Role">
      {(ids) => (
        <div role="radiogroup" aria-labelledby={ids.labelId} className="flex gap-4">
          {(["member", "admin"] as const).map((r) => (
            <label key={r} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={name}
                value={r}
                checked={value === r}
                onChange={() => onChange(r)}
                className="accent-[var(--color-accent)]"
              />
              <span className="text-sm capitalize" style={{ color: "var(--color-text)" }}>
                {r}
              </span>
            </label>
          ))}
        </div>
      )}
    </Field>
  );
}

/** Users tab (admin): create, edit, disable and delete users */
export function UserManagement({ currentUserId }: { currentUserId: string }) {
  const utils = trpc.useUtils();
  const { data: users, isLoading } = trpc.user.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery();
  const { data: groups } = trpc.group.list.useQuery();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();
  const dialogs = useCrudDialogs<UserRow, UserFormData, UserEditFormData>({
    createForm: emptyUser,
    editForm: emptyUserEdit,
  });

  const localGroups = groups?.filter((group) => group.source === "local") ?? [];

  const createMutation = trpc.user.create.useMutation({
    onSuccess: () => {
      utils.user.list.invalidate();
      utils.group.list.invalidate();
      dialogs.completeCreate();
    },
  });
  const updateMutation = trpc.user.update.useMutation({
    onSuccess: () => {
      utils.user.list.invalidate();
      utils.group.list.invalidate();
      dialogs.completeEdit();
    },
  });
  const deleteMutation = trpc.user.delete.useMutation({
    onSuccess: () => {
      setDeleteError(null);
      utils.user.list.invalidate();
      utils.group.list.invalidate();
    },
    onError: (error) => {
      setDeleteError(error.message);
    },
  });

  function openEdit(user: UserRow) {
    dialogs.openEdit(user, {
      name: user.name ?? "",
      email: user.email ?? "",
      role: user.role as "admin" | "member",
      password: "",
      projectIds: user.projectMemberships.map((membership) => membership.projectId),
      groupIds: user.groupMemberships.map((membership) => membership.groupId),
      disabled: Boolean(user.disabledAt),
    });
  }

  if (isLoading) {
    return (
      <div className="animate-pulse py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
        Loading users...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          Users
        </h2>
        <Button onClick={dialogs.openCreate}>New User</Button>
      </div>

      {/* User list */}
      <div className="space-y-2">
        {users?.map((user) => (
          <div
            key={user.id}
            className="flex items-center justify-between rounded-lg px-4 py-3"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <Avatar name={user.name} email={user.email} image={user.image} size="md" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium" style={{ color: "var(--color-text)" }}>
                    {user.name ?? "—"}
                  </span>
                  <span
                    className="rounded px-1.5 py-0.5 text-xs capitalize"
                    style={{
                      backgroundColor: user.role === "admin" ? "var(--color-warning-muted, var(--color-accent-muted))" : "var(--color-bg-muted)",
                      color: user.role === "admin" ? "var(--color-warning, var(--color-accent))" : "var(--color-text-muted)",
                    }}
                  >
                    {user.role}
                  </span>
                  {user.disabledAt && (
                    <span className="rounded px-1.5 py-0.5 text-xs" style={{ backgroundColor: "var(--color-danger-muted, var(--color-bg-muted))", color: "var(--color-danger)" }}>
                      disabled
                    </span>
                  )}
                </div>
                <p className="text-sm truncate" style={{ color: "var(--color-text-secondary)" }}>
                  {user.email} · {user.authSource ?? "local"}
                </p>
                <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {user.projectMemberships.length > 0
                    ? user.projectMemberships.map((membership) => `${membership.project.key} ${membership.project.name}`).join(" • ")
                    : "No project access"}
                </p>
                <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {user.groupMemberships.length > 0
                    ? user.groupMemberships.map((membership) => membership.group.name).join(" • ")
                    : "No groups"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 ml-4">
              <Button variant="outline" size="sm" onClick={() => openEdit(user)}>
                Edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={user.id === currentUserId}
                onClick={() => {
                  void confirm({
                    title: "Delete this user?",
                    description: "This cannot be undone.",
                    confirmLabel: "Delete",
                    destructive: true,
                  }).then((confirmed) => {
                    if (confirmed) {
                      deleteMutation.mutate({ id: user.id });
                    }
                  });
                }}
              >
                {user.id === currentUserId ? "Current User" : "Delete"}
              </Button>
            </div>
          </div>
        ))}
        {users?.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
            No users found.
          </div>
        )}
      </div>
      {deleteError && (
        <Alert variant="danger" className="mt-3">{deleteError}</Alert>
      )}

      {/* Create User Dialog */}
      <Dialog open={dialogs.createOpen} onOpenChange={(open) => { if (!open) dialogs.closeCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate(dialogs.createForm);
            }}
            className="space-y-4"
          >
            <Field label="Name" required>
              {(ids) => (
                <Input id={ids.id}
                  value={dialogs.createForm.name}
                  onChange={(e) => dialogs.setCreateForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="John Doe"
                  required
                />
              )}
            </Field>
            <Field label="Email" required>
              {(ids) => (
                <Input id={ids.id}
                  type="email"
                  value={dialogs.createForm.email}
                  onChange={(e) => dialogs.setCreateForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="john@example.com"
                  required
                />
              )}
            </Field>
            <Field label="Password" required>
              {(ids) => (
                <Input id={ids.id}
                  type="password"
                  value={dialogs.createForm.password}
                  onChange={(e) => dialogs.setCreateForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={PASSWORD_MIN_LENGTH_HINT}
                  minLength={PASSWORD_MIN_LENGTH}
                  required
                />
              )}
            </Field>
            <RoleRadios name="role" value={dialogs.createForm.role} onChange={(role) => dialogs.setCreateForm((f) => ({ ...f, role }))} />
            <AccessChecklists
              projects={projects}
              groups={localGroups}
              projectIds={dialogs.createForm.projectIds}
              groupIds={dialogs.createForm.groupIds}
              onToggleProject={(projectId) =>
                dialogs.setCreateForm((current) => ({ ...current, projectIds: toggleId(current.projectIds, projectId) }))
              }
              onToggleGroup={(groupId) =>
                dialogs.setCreateForm((current) => ({ ...current, groupIds: toggleId(current.groupIds, groupId) }))
              }
            />
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

      {/* Edit User Dialog */}
      <Dialog open={dialogs.editOpen} onOpenChange={(open) => { if (!open) dialogs.closeEdit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!dialogs.editing) return;
              updateMutation.mutate({
                id: dialogs.editing.id,
                name: dialogs.editForm.name,
                email: dialogs.editForm.email,
                role: dialogs.editForm.role,
                password: dialogs.editForm.password || undefined,
                projectIds: dialogs.editForm.projectIds,
                groupIds: dialogs.editForm.groupIds,
                disabled: dialogs.editForm.disabled,
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
            <Field label="Email" required>
              {(ids) => (
                <Input id={ids.id}
                  type="email"
                  value={dialogs.editForm.email}
                  onChange={(e) => dialogs.setEditForm((f) => ({ ...f, email: e.target.value }))}
                  required
                />
              )}
            </Field>
            <Field label="New Password">
              {(ids) => (
                <Input id={ids.id}
                  type="password"
                  value={dialogs.editForm.password}
                  onChange={(e) => dialogs.setEditForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Leave blank to keep current"
                  minLength={PASSWORD_MIN_LENGTH}
                />
              )}
            </Field>
            <RoleRadios name="edit-role" value={dialogs.editForm.role} onChange={(role) => dialogs.setEditForm((f) => ({ ...f, role }))} />
            <label className="flex items-center gap-3 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text)", backgroundColor: "var(--color-bg-overlay)" }}>
              <input
                type="checkbox"
                checked={dialogs.editForm.disabled}
                disabled={dialogs.editing?.id === currentUserId}
                onChange={(event) => dialogs.setEditForm((current) => ({ ...current, disabled: event.target.checked }))}
                className="accent-[var(--color-accent)]"
              />
              Disable account
            </label>
            <AccessChecklists
              projects={projects}
              groups={localGroups}
              projectIds={dialogs.editForm.projectIds}
              groupIds={dialogs.editForm.groupIds}
              onToggleProject={(projectId) =>
                dialogs.setEditForm((current) => ({ ...current, projectIds: toggleId(current.projectIds, projectId) }))
              }
              onToggleGroup={(groupId) =>
                dialogs.setEditForm((current) => ({ ...current, groupIds: toggleId(current.groupIds, groupId) }))
              }
            />
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
